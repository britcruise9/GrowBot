/* GrowBot — anonymous-BY-CONSTRUCTION analytics client.  (spec: 01_analytics_logging_spec)
 *
 * THE RULE: there is nothing personal in here to leak, because the schema cannot hold it.
 * We send a random per-TAB session id, a handful of yes/no funnel milestones, coarse device
 * buckets, and a heartbeat. NEVER: name/email/account, any cross-session id, creature/soul
 * content, LLM prompts or completions, camera frames, audio, transcripts, precise location,
 * or API keys. The tab closes -> the id is gone forever (sessionStorage, never a cookie).
 *
 * It AUTO-INSTRUMENTS what it can with zero host edits — mic/camera permission (getUserMedia),
 * motion permission + IMU streaming (DeviceMotionEvent), page load, 5-minute hold, heartbeat,
 * clean exit. A host page only adds two one-line calls for its app-internal milestones:
 *     GBA.mark('policy')          // walk policy loaded ok   (GBA.mark('policy','fail') on failure)
 *     GBA.mark('active')          // the experience began — "the wow"
 *
 * INVARIANT: nothing here may EVER throw into the host page. Every public path is guarded.
 */
(function () {
  "use strict";
  if (window.GBA) return;                       // idempotent — safe to include twice

  var ENDPOINT  = "/api/ev";
  var HEARTBEAT = 60000;                         // liveness/presence ping. Milestones flush
                                                 // immediately (800ms debounce), so funnel latency
                                                 // is unaffected; this only paces the heartbeat.
                                                 // 20s -> 60s (0806). Paired with FREEZE_GAP 90 -> 300
                                                 // in api/health.js: the ratio must be big enough that
                                                 // no plausible burst of dropped pings invents a
                                                 // freeze, and 300/60 tolerates 4 consecutive losses
                                                 // (slightly MORE headroom than the old 90/20). The
                                                 // old tight gap also existed to absorb background
                                                 // timer throttling, which no longer applies now that
                                                 // hidden tabs stop pinging entirely (see below).
                                                 // ⚠ CHANGE THESE TWO TOGETHER.
  var FIVE_MIN  = 5 * 60 * 1000;
  var STEPS_OK  = { app_loaded: 1, imu: 1, mic: 1, cam: 1, policy: 1, active: 1, hold5: 1, end: 1, grad: 1, gradgo: 1, gradfail: 1, gradboot: 1, gradnotowner: 1, pay: 1, pack: 1, adopt: 1, redeem: 1, gate: 1, present: 1, wake_tap: 1, js_err: 1 };   // 0811: the no-tap funnel (gate shown / human touched / gate tapped) — K3 caught the marks shipping whitelisted-OUT on both sides   // 0729: money-funnel keys were dropped client-side; match server STEP_KEYS so the ?clicks funnel counts
  var STATUS_OK = { granted: 1, denied: 1, stream: 1, ok: 1, fail: 1 };

  // ---- ephemeral, per-tab session id (dies on tab close; never a cookie) ----
  function uuid() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  }
  var sid;
  try {
    sid = sessionStorage.getItem("gb_sid");
    if (!sid) { sid = uuid(); sessionStorage.setItem("gb_sid", sid); }
  } catch (e) { sid = uuid(); }                  // private mode / blocked storage -> in-memory only

  var startT  = Date.now();
  var page    = window.GBA_PAGE ||
                (location.pathname.indexOf("/tester") === 0 ? "robot" : "creature");
  var reached = {};                              // milestones already counted this session (idempotent)
  var pending = [];                              // tokens not yet flushed
  var hb      = 0;
  var engaged = false;                           // reached 'active' — flips presence tracking on server
  var bg      = false;                            // tab backgrounded — so the server doesn't read a normal app-switch as a freeze
  var bgOverride = false;                         // set for the single retirement ping (see IDLE_RETIRE): report "not watchable" without claiming the tab is hidden
  var ended   = false;
  var env     = sniffEnv();

  // ---- coarse device buckets — ENVIRONMENT, not identity. Raw UA never leaves as-is. ----
  function sniffEnv() {
    var ua = ""; try { ua = navigator.userAgent || ""; } catch (e) {}
    var os = "other", br = "other", form = "desktop";
    if (/iPhone|iPad|iPod/i.test(ua))      os = "iOS" + maj(ua, /OS (\d+)/);
    else if (/Android/i.test(ua))          os = "Android" + maj(ua, /Android (\d+)/);
    else if (/Windows NT/i.test(ua))       os = "Windows";
    else if (/Mac OS X/i.test(ua))         os = "macOS";
    else if (/CrOS/i.test(ua))             os = "ChromeOS";
    else if (/Linux/i.test(ua))            os = "Linux";
    // browser — order matters: Samsung/Edge/Chrome all contain "Chrome"
    if (/SamsungBrowser/i.test(ua))        br = "Samsung Internet" + maj(ua, /SamsungBrowser\/(\d+)/);
    else if (/Edg\//i.test(ua))            br = "Edge" + maj(ua, /Edg\/(\d+)/);
    else if (/FxiOS|Firefox/i.test(ua))    br = "Firefox" + maj(ua, /(?:FxiOS|Firefox)\/(\d+)/);
    else if (/CriOS|Chrome/i.test(ua))     br = "Chrome" + maj(ua, /(?:CriOS|Chrome)\/(\d+)/);
    else if (/Safari/i.test(ua))           br = "Safari" + maj(ua, /Version\/(\d+)/);
    var coarse = false, touch = false;
    try { coarse = matchMedia("(pointer:coarse)").matches; } catch (e) {}
    try { touch = (navigator.maxTouchPoints || 0) > 0 || "ontouchstart" in window; } catch (e) {}
    if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) form = "tablet";
    else if (/Mobi|iPhone|Android/i.test(ua) || (coarse && touch)) form = "phone";
    var sp = 0; try { sp = Math.min(screen.width || 0, screen.height || 0); } catch (e) {}
    var scr = sp <= 360 ? "<=360" : sp <= 414 ? "361-414" : sp <= 768 ? "415-768" : ">768";
    return { os: clip(os), br: clip(br), form: form, scr: scr };
  }
  function maj(ua, re) { var m = re.exec(ua); return m ? " " + m[1] : ""; }
  function clip(s) { return String(s).replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, 24); }

  // ---- record a milestone (idempotent per session) ----
  function mark(step, status) {
    try {
      if (!STEPS_OK[step]) return;               // whitelist — anything else simply can't be sent
      if (step === "active") engaged = true;
      var tok = (status && STATUS_OK[status]) ? (step + ":" + status) : step;
      if (reached[tok]) return;
      reached[tok] = 1;
      pending.push(tok);
      alive();                                   // a milestone IS proof of life (see IDLE_RETIRE)
      schedule();                                // batch a burst of marks into one flush
    } catch (e) {}
  }

  // ---- transport: batched POST; sendBeacon for the final unload flush ----
  var flushT = null, requeues = 0;   // 0810 (K3 retro #4): re-queue is capped — a flapping mobile tunnel that loses RESPONSES (POST landed) must not multiply milestone counts forever, and an offline tab must not retransmit the same batch for its whole life
  function schedule() { if (!flushT) flushT = setTimeout(function () { flushT = null; flush(false); }, 800); }
  function buildBody(isEnd) {
    var p = { v: 1, sid: sid, page: page, env: env, hb: hb, age: Date.now() - startT };
    if (engaged) { p.act = 1; p.bg = (bg || bgOverride) ? 1 : 0; }  // act -> server tracks presence; bg -> exclude from freeze tally
    if (pending.length) p.steps = pending.slice();
    if (isEnd) p.end = 1;
    return JSON.stringify(p);
  }
  function flush(isEnd) {
    try {
      var body = buildBody(isEnd);               // reads `pending` BEFORE we clear it
      var took = pending.slice();                // 0810: keep the milestone tokens until the POST actually lands
      pending = [];
      if (isEnd && navigator.sendBeacon) { try { navigator.sendBeacon(ENDPOINT, body); } catch (e) {} return; }
      fetch(ENDPOINT, { method: "POST", body: body, keepalive: true, headers: { "content-type": "application/json" } })
        .catch(function () { try { if (took.length && requeues < 3) { requeues++; pending = took.concat(pending); } } catch (e) {} });   // 0810: a dropped request used to eat app_loaded/active tokens forever (measured: iOS boots > counted loads) — re-queue on network failure (max 3 per session, K3 retro #4) and let the NEXT natural flush carry them; deliberately NO reschedule, an offline tab must not hammer retries every 800ms. The rare landed-but-response-lost double-count is bounded and the lesser error for counters.
    } catch (e) { /* never throw */ }
  }

  // ---- lifecycle ----
  // The heartbeat SKIPS while hidden and retires an idle tab (0806). Two reasons, both measured:
  //   hidden — api/health.js discards every record with bg set, so a background ping is traffic
  //            whose only consumer throws it away. It was also the worst case: browsers throttle
  //            hidden timers to ~60s, which is past PRESENCE_FRESH_S, so it wrote EVERY time.
  //            The visibilitychange flush below still marks the record bg on the way out and
  //            refreshes it on the way back, so nothing is lost by going quiet in between.
  //   idle   — the timer used to be cleared only in bye() (pagehide), so a forgotten-but-open tab
  //            pinged forever. That is a ratchet, not a level: it never falls off on its own.
  // Proof of life is real user input OR any mark(), because the app is voice-driven and a quiet
  // but genuinely engaged user is a normal shape here — pointer/key alone would retire them.
  var lastAlive = Date.now();
  var IDLE_RETIRE = 20 * 60 * 1000;
  var retired = false, bgTicks = 0;
  function alive() { lastAlive = Date.now(); }
  try {
    ["pointerdown", "keydown", "touchstart"].forEach(function (ev) {
      window.addEventListener(ev, alive, { capture: true, passive: true });
    });
  } catch (e) {}
  var hbTimer = setInterval(function () {
    try {
      if (bg) {
        // Hidden: nothing to refresh, health.js drops bg records. But go quiet only once the
        // server has actually HEARD that we are hidden. If the visibilitychange flush was dropped
        // (network blip, torn-down keepalive), the stored record still reads bg:0 with an ageing
        // last-seen and turns into a phantom freeze — and the old throttled background ping used
        // to self-heal exactly that. Re-assert every 5th tick to keep the repair: for an already-bg
        // record ev.js finds changed=false and suppresses stale, so this costs a POST and no blob op.
        // BOUNDED at 3 re-asserts (~15 min), or a tab minimised and forgotten becomes the same
        // never-ending ping loop this whole change exists to kill. 15 min is also FRESH_MS, so by
        // then the record is prune-eligible anyway and cannot be read as a freeze either way.
        if (++bgTicks % 5 === 0 && bgTicks <= 15) flush(false);
        return;
      }
      bgTicks = 0;
      if (Date.now() - lastAlive > IDLE_RETIRE) {
        // Retire ONCE, and say so, instead of just falling silent. A silent stop leaves a visible,
        // un-ended record ageing until it crosses FREEZE_GAP and gets counted as a crash five
        // minutes later. That would be a lie about the one number this telemetry exists to get
        // right, and it would fire on the app's most normal shape: the phone is strapped into a
        // robot body and the interaction is voice, so a fully engaged user emits no pointer/key
        // event and no new milestone for 20 minutes. bg is already "here but not watchable" and
        // health.js already drops it, so reuse it rather than inventing a field the server would
        // strip. Coming back is automatic: alive() clears `retired`, the next ping carries bg:0,
        // and ev.js sees the flip as `changed` and re-registers the session.
        if (!retired) { retired = true; bgOverride = true; flush(false); bgOverride = false; }
        return;
      }
      retired = false;
      hb++; flush(false);
    } catch (e) {}
  }, HEARTBEAT);
  // hold5 is the retention signal — gate on `engaged` so it counts only STARTED sessions still
  // alive at 5 min (spec). Otherwise a tab idling on a broken on-ramp would inflate hold5 above active.
  setTimeout(function () { if (engaged) mark("hold5"); }, FIVE_MIN);
  function bye() {
    if (ended) return; ended = true;
    try { clearInterval(hbTimer); } catch (e) {}
    try { clearTimeout(flushT); flushT = null; } catch (e) {}
    if (!reached.end) { reached.end = 1; pending.push("end"); }
    flush(true);
  }
  window.addEventListener("pagehide", bye, { capture: true });
  document.addEventListener("visibilitychange", function () {
    // mark/clear the background flag and report it: a backgrounded tab stops pinging (timers
    // throttle), so without this the server would read a normal app-switch as a candidate freeze.
    bg = (document.visibilityState === "hidden");
    try { flush(false); } catch (e) {}
  }, { capture: true });

  // ---- AUTO: mic / camera permission via getUserMedia (no host edits needed) ----
  try {
    var md = navigator.mediaDevices;
    if (md && md.getUserMedia && !md.__gba) {
      md.__gba = 1;
      var origGUM = md.getUserMedia.bind(md);
      navigator.mediaDevices.getUserMedia = function (constraints) {
        var wantA = false, wantV = false;
        try { wantA = !!(constraints && constraints.audio); wantV = !!(constraints && constraints.video); } catch (e) {}
        var pr;
        try { pr = origGUM(constraints); } catch (e) { return Promise.reject(e); }
        try {
          pr.then(function () {                  // side-observer chain — swallows, never rethrows
            if (wantA) mark("mic", "granted");
            if (wantV) mark("cam", "granted");
          }, function (err) {
            var denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
            if (wantA) mark("mic", denied ? "denied" : "fail");
            if (wantV) mark("cam", denied ? "denied" : "fail");
          });
        } catch (e) {}
        return pr;                               // host gets the ORIGINAL promise, untouched
      };
    }
  } catch (e) {}

  // ---- AUTO: motion permission (iOS) ----
  try {
    var DME = window.DeviceMotionEvent;
    if (DME && typeof DME.requestPermission === "function" && !DME.__gba) {
      DME.__gba = 1;
      var origReq = DME.requestPermission.bind(DME);
      DME.requestPermission = function () {
        var pr = origReq();
        try { pr.then(function (s) { mark("imu", s === "granted" ? "granted" : "denied"); }, function () { mark("imu", "denied"); }); } catch (e) {}
        return pr;
      };
    }
  } catch (e) {}

  // ---- AUTO: IMU actually streaming (the "phone is alive as a sensor" check) ----
  try {
    var imuSeen = false;
    var onMotion = function (e) {
      if (imuSeen) return;
      var a = e && (e.accelerationIncludingGravity || e.acceleration);
      if (a && (a.x != null || a.y != null || a.z != null)) {
        imuSeen = true;
        mark("imu", "stream");
        try { window.removeEventListener("devicemotion", onMotion); } catch (e2) {}
      }
    };
    window.addEventListener("devicemotion", onMotion, { passive: true });
  } catch (e) {}

  // ---- public surface ----
  window.GBA = { mark: mark, sid: sid, page: page };
  try { if (/[?&]agent=1/.test(location.search)) localStorage.gb_agent = "1"; } catch (e) {}   // 0816 AGENT FLAG: the shared link lands HERE first and the param dies on navigation — persist it so the app tags the journal (read-time separation of agent sessions from human funnel metrics; never gates behavior)
  mark("app_loaded");
  setTimeout(function () { try { flush(false); } catch (e) {} }, 1500); // early ping so short sessions still register
})();
