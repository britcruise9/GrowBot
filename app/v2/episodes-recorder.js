// GrowBot episodes recorder — self-contained browser module for the archive lane.
//
// PRIVACY: recording honors the same pb2_journal opt-out as the diary. Free-text human
// speech is either redacted by the caller's redactQ or dropped entirely (fail-closed).
// No camera frames or audio buffers are captured — only LLM turn I/O and down-sampled
// motor features.
//
// Exposes window.pbEpisodes = { turn(o), motor(imuArr,actArr,servoArr), flush(),
// setProv(p), wipe() }. Optional: set window.pbEpisodes.redact = fn to hash free-text
// fields; otherwise they are dropped.
(function () {
  var PB_SID_KEY = 'pb2_sid';
  var PB_JOURNAL_KEY = 'pb2_journal';

  var MOTOR_WINDOW_MS = 1000;   // collapse ~30 Hz control samples to 1 Hz network writes
  var FLUSH_INTERVAL_MS = 10000;// batch ~10 s worth of lines
  var BATCH_BYTES = 32 * 1024;  // or flush early if a batch gets big
  var MAX_MOTOR_SAMPLES = 120;  // 4 s at 30 Hz; hard ceiling for the raw sample ring
  var MAX_LINES = 5000;         // pending-flush ceiling; oldest dropped if backed up

  var sid = null;
  var prov = null;
  var lines = [];
  var motorBuf = [];
  var motorDropped = 0;
  var motorT0 = 0;
  var motorTimer = null;
  var flushTimer = null;
  var flushing = false;

  var api = {
    turn: turn,
    motor: motor,
    soul: soul,              // SOUL HISTORY (0721): versioned identity snapshots, kind:"soul" lines on the same lane
    flush: function (force) { flush(!!force); },
    setProv: setProv,
    wipe: wipe,
    redact: null             // app may assign its redactQ here
  };

  function now() { return Date.now(); }

  function storageGet(k) {
    try { return window.localStorage.getItem(k); } catch (e) { return null; }
  }
  function storageSet(k, v) {
    try { window.localStorage.setItem(k, v); } catch (e) {}
  }

  function makeSid() {
    return now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function isOptedOut() {
    return storageGet(PB_JOURNAL_KEY) === '0';   // 0811 CORRECTED (Brit): the redacted diary is the most valuable part of the project — default ON, redaction is the privacy layer, raw is a global switch; '0' = the CLOUD NOTES opt-out
  }

  function ensureSid() {
    if (sid) return;
    sid = storageGet(PB_SID_KEY);
    if (!sid && !isOptedOut()) {
      sid = makeSid();
      storageSet(PB_SID_KEY, sid);
    }
  }

  function cloneProv() {
    // Stamp provenance at write time, not flush time, so every line carries the
    // model/policy/soul/deploy/consent state that produced it.
    return prov ? JSON.parse(JSON.stringify(prov)) : null;
  }

  function setProv(p) {
    prov = p ? JSON.parse(JSON.stringify(p)) : null;
  }

  // Drop undefined keys so omitted free-text fields don't leak as `undefined`.
  function compact(obj) {
    var out = {};
    for (var k in obj) {
      if (obj.hasOwnProperty(k) && obj[k] !== undefined) out[k] = obj[k];
    }
    return out;
  }

  // Apply the caller's redactor to a free-text field; if none is configured, drop it.
  function redactField(value, rfn) {
    if (!rfn) return undefined;
    var out = rfn(value);
    return out === undefined ? undefined : out;
  }

  function turn(o) {
    if (isOptedOut()) return;
    ensureSid();
    if (!sid || !prov) return;

    var rfn = (o && o.redact) || api.redact || null;

    var obs = {
      vision_txt: o.vision_txt,
      mood: o.mood,
      stage: o.stage
    };
    // heard is free-text human speech until the redactor hashes it.
    if (o.heard != null) obs.heard_txt_or_hash = redactField(o.heard, rfn);

    var decision = {
      prompt_hash: o.prompt_hash,
      verbs: o.verbs
    };
    if (o.raw_llm != null) decision.raw_llm = redactField(o.raw_llm, rfn);
    if (o.speech != null) decision.speech = redactField(o.speech, rfn);
    // 0924 GESTURE KEYFRAMES (logging audit spec 3): the leg keyframes the creature commanded this turn,
    // as "l,r,ms;l,r,ms". The pattern admits DIGITS and separators only, so no text can ride and no
    // redactor is needed; gesture NAMES are never passed (people teach poses under names). Absent
    // body_steps (v2, the tester, every turn without a gesture) adds nothing: the line is byte-identical.
    if (o.body_steps && typeof o.body_steps.s === 'string' && /^[0-9,;-]{1,200}$/.test(o.body_steps.s)) {
      decision.body = { s: o.body_steps.s, n: o.body_steps.n | 0, hold: +o.body_steps.hold || 0, named: o.body_steps.named ? 1 : 0 };
    }

    var human = null;
    if (o.human) {
      human = {
        responded_ms: o.human.responded_ms,
        fed: !!o.human.fed,
        glow: !!o.human.glow
      };
      var reply = o.human.reply != null ? o.human.reply : o.human.reply_txt_or_hash;
      if (reply != null) human.reply_txt_or_hash = redactField(reply, rfn);
    }

    var line = {
      kind: 'turn',
      t: now(),
      obs: compact(obs),
      decision: compact(decision),
      prov: cloneProv()
    };
    if (human) line.human = compact(human);

    addLine(line);
  }

  function motor(imuArr, actArr, servoArr) {
    if (isOptedOut()) return;
    ensureSid();
    if (!sid || !prov) return;

    if (!motorTimer) {
      motorTimer = window.setInterval(emitMotor, MOTOR_WINDOW_MS);
      motorT0 = now();
    }
    if (!motorBuf.length) motorT0 = now();

    motorBuf.push({ i: imuArr, a: actArr, s: servoArr });
    // REVIEW FIX: count ring overflow (backgrounded tabs throttle the emit timer to
    // >=1s or worse while 30 Hz pushes continue) so silent gaps are visible in the data.
    if (motorBuf.length > MAX_MOTOR_SAMPLES) { motorBuf.shift(); motorDropped++; }
  }

  function emitMotor() {
    if (!motorBuf.length) return;
    var n = motorBuf.length;
    var t1 = now();
    var dt = t1 - motorT0;
    var hz = Math.round(n / (dt || 1) * 1000);
    var imu = [], act = [], servo = [];
    for (var i = 0; i < n; i++) {
      var s = motorBuf[i];
      imu.push(s.i); act.push(s.a); servo.push(s.s);
    }
    // REVIEW FIX: window START (t0) travels with the line — downstream alignment
    // against turn records needs the span, not just the emit instant.
    var line = {
      kind: 'motor',
      t: t1,
      t0: motorT0,
      hz: hz,
      imu: imu,
      act: act,
      servo: servo,
      prov: cloneProv()
    };
    if (motorDropped) { line.dropped = motorDropped; motorDropped = 0; }
    addLine(line);
    motorBuf = [];
  }

  // SOUL HISTORY (0721): how a creature's identity evolves — and how its person edits it —
  // as kind:"soul" lines on the same append-only lane (server validates only t+kind, sweep
  // never touches it, wipe() already deletes it). Free text goes through the configured
  // redactor (fail-closed: no redactor -> field DROPPED); the owner name is always hashed
  // (a real name = PII). Content-hash dedupe so callers can fire on every candidate moment
  // (boot, dream, edit, import) and only REAL change writes a line.
  var SOUL_H_KEY = 'gb_soul_h';
  function djb2(s) { var h = 5381, i; for (i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0; return ('0000000' + h.toString(16)).slice(-8); }
  function soul(o) {
    if (!o || isOptedOut()) return;
    ensureSid();
    if (!sid || !prov) return;
    var rfn = (o && o.redact) || api.redact || null;
    var snap = compact({
      identity: o.identity != null ? redactField(String(o.identity).slice(0, 900), rfn) : undefined,
      wants: Array.isArray(o.wants) ? o.wants.slice(0, 4).map(function (w) { return redactField(String(w).slice(0, 120), rfn); }) : undefined,
      rules: Array.isArray(o.rules) ? o.rules.slice(0, 6).map(function (r) { return redactField(String(r).slice(0, 120), rfn); }) : undefined,
      owner_hash: o.owner ? djb2(String(o.owner)) : undefined,
      mood: o.mood || undefined
    });
    var h = djb2(JSON.stringify(snap));
    if (h === storageGet(SOUL_H_KEY)) return;   // nothing actually changed since the last snapshot
    storageSet(SOUL_H_KEY, h);
    addLine({ kind: 'soul', t: now(), trigger: String(o.trigger || 'edit').slice(0, 24), soul: snap, prov: cloneProv() });
  }

  function addLine(line) {
    lines.push(line);
    if (lines.length > MAX_LINES) lines.shift();
    if (!flushTimer) {
      flushTimer = window.setInterval(function () { flush(true); }, FLUSH_INTERVAL_MS);
    }
    if (payloadBytes() >= BATCH_BYTES) flush(true);
  }

  function payloadBytes() {
    var n = 0;
    for (var i = 0; i < lines.length; i++) n += JSON.stringify(lines[i]).length + 1;
    return n;
  }


  // sendBeacon is synchronous and survives pagehide; fetch keepalive is the fallback.
  // done(ok): beacon "queued" counts as ok (fire-and-forget is the API's contract);
  // the fetch path reports the real HTTP outcome so failures can requeue.
  function transmit(body, done) {
    var url = '/api/episodes?sid=' + encodeURIComponent(sid);
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      var blob = new Blob([body], { type: 'text/plain' });
      if (navigator.sendBeacon(url, blob)) { if (done) done(true); return; }
    }
    if (typeof window !== 'undefined' && window.fetch) {
      window.fetch(url, {
        method: 'POST',
        body: body,
        keepalive: true,
        headers: { 'content-type': 'text/plain' }
      }).then(function (r) { if (done) done(!!(r && r.ok)); })
        .catch(function () { if (done) done(false); });
    } else {
      if (done) done(false);
    }
  }

  function flush(force) {
    ensureSid();
    if (!sid || !lines.length) return;
    if (flushing && !force) return;

    // REVIEW FIX: clearing lines before knowing the send landed made every offline
    // moment or 429 permanent data loss. Keep the batch; on a KNOWN failure put it
    // back in front (newest-bounded by MAX_LINES) for the next flush to retry.
    var batch = lines;
    lines = [];
    var body = payloadFromLines(batch);
    flushing = true;
    transmit(body, function (ok) {
      flushing = false;
      if (!ok) lines = batch.concat(lines).slice(-MAX_LINES);
    });
  }

  function payloadFromLines(arr) {
    var parts = [];
    for (var i = 0; i < arr.length; i++) parts.push(JSON.stringify(arr[i]));
    return parts.join('\n') + '\n';
  }

  function wipe() {
    lines = [];             // REVIEW FIX: dropped dead `toSend` capture — wipe means
    motorBuf = [];          // discard, never "send on the way out".
    motorDropped = 0;
    if (motorTimer) { window.clearInterval(motorTimer); motorTimer = null; }
    if (flushTimer) { window.clearInterval(flushTimer); flushTimer = null; }

    var cur = storageGet(PB_SID_KEY);
    sid = null;
    /* 0923: wipe() used to fire the delete and swallow the outcome, so the app announced "cloud
       copies erased" on the strength of the JOURNAL result alone while the movement archive may
       have failed entirely. It returns a promise now: true only when the server confirms, in its
       BODY as well as its status, because that API also used to answer ok:true on total failure.
       Nothing stored to delete is success; "we could not tell" is not. */
    if (!cur) return Promise.resolve(true);
    if (typeof window === 'undefined' || !window.fetch) return Promise.resolve(false);
    return window.fetch('/api/episodes?sid=' + encodeURIComponent(cur), {
      method: 'DELETE', keepalive: true
    }).then(function (r) {
      return r.json().then(function (j) { return !!(r.ok && j && j.ok === true); },
                           function () { return false; });
    }, function () { return false; });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', function () { flush(true); });
    window.pbEpisodes = api;
  }
}());
