// agent-gateway.js — the SAFETY LAYER between any EXTERNAL BRAIN and the body.
//
// An external brain (a local model via an OpenAI-compatible endpoint, or an agent
// script dialing in over the relay) never touches the wire protocol directly. It
// speaks HIGH-LEVEL VERBS (speak/forward/turn/stop/gesture); this module validates
// them against body truth, clamps every number, enforces the duty budget, runs the
// walk policy/reflexes IN THE BROWSER, and only then talks to the chip through the
// shared RelayBody. The Pico firmware and the relay worker are untouched by design.
//
//   external brain ──verbs──▶ SafeBody (this file: clamps + body_truth + reflexes)
//                                        └──pose/act/stop──▶ relay ──▶ chip ──▶ servos
//
// Inbound transport: AgentChannel joins the relay worker on a SEPARATE side channel
// ("<deviceId>-agent") from the chip's main channel. A cooperative agent that speaks
// this protocol only ever emits verbs; SafeBody validates + clamps them before any
// motor envelope reaches the chip, so a buggy or low-capability brain cannot drive the
// legs out of band.
//
// This separation is NOT a security boundary. The relay is unauthenticated today (a
// phase-5 TODO in relay/worker.js — msg.code is never checked), exactly like the
// existing manual/policy/LLM remotes, so anyone holding the pairing code can address
// the main channel directly and move the legs WITHOUT these clamps. The clamps protect
// against a dumb cooperative brain, not a hostile one. Treat the pairing code as a secret.
//
// Consumed by tester/custom.html. Documented for agent authors at /agent-docs.html.

import { RelayBody, RELAY_DEFAULT } from './relay-transport.js';

const D2R = Math.PI / 180;
const OBS_HZ = 2;                    // sensor ticker rate to an inbound agent
const AGENT_STALE_MS = 25000;        // no envelope for this long -> "agent quiet"
const BODY_RX_MS = 25000;            // next.html _bodyAlive: inbound relay traffic this recent still counts as a live robot

// 1006 fix: the old one-liner sent wrap(0) to -pi, so a still phone told the fallback walker roll = pitch = yaw = -180 deg
// (the bug tester/policy.html fixed on 09-11). Same numbers as policy.html's wrap for every finite input; written as the
// app's (next.html) so it can never loop.
function wrap(a){ a = a % (2*Math.PI); if(a > Math.PI) a -= 2*Math.PI; if(a < -Math.PI) a += 2*Math.PI; return a; }
function clampN(v, lo, hi){ v = Number(v); if(!Number.isFinite(v)) return lo; return Math.max(lo, Math.min(hi, v)); }
function readCal(){ try { return JSON.parse(localStorage.getItem('gb_walk_cal') || '{}'); } catch (e) { return {}; } }
function fin(v){ return typeof v === 'number' && isFinite(v); }
function nowMs(){ return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }   // the clock the page stamps motion events with
function pageHidden(){ return typeof document !== 'undefined' && !!document.hidden; }
function motionErr(code, message){ const e = new Error(message); e.code = code; return e; }
function motionWhy(e){ return e.message + (e.code ? ' (' + e.code + ')' : ''); }
const ROOT = typeof globalThis !== 'undefined' ? globalThis : {};   // GBForwardWalk / GBNormalSpin / GBForwardChoice are classic-script globals (loaded by the page)

// R3 spin length for turn(degrees). The R3 spin has no angle sensor loop and no angle guarantee; this is Brit's 10-05
// bench line (one kit, one surface: 26/58/136 deg in 2/3/5 s, about 37 deg/s after a 1.4 s start-up), an estimate only.
function spinSecs(deg){ return clampN(1.4 + Math.abs(+deg || 0) / 37, 1.5, 6.5); }

// ── stock-walk motion capture (1006) ────────────────────────────────────────
// A copy of the app's capture (next.html captureForwardMotion + _gSignTick), so the gateway feeds GBForwardWalk the
// sample the app feeds it: gyro a/b/g, accelerationIncludingGravity x/y/z times the gravity sign, |linear accel|, t.
// The page passes every deviceorientation/devicemotion event in with ONE clock (performance.now()). Gravity sign: the
// first guess is the platform's (the iOS 13+ permission API reads -1, else +1); orientation then MEASURES it. 5 still,
// agreeing samples decide, only 60 the other way overturn it, and 10 s without a verdict keeps the guess unmeasured.
// Until it is measured the walk refuses (gravity_sign_unmeasured), exactly like the app.
export class ForwardCapture {
  constructor(opts = {}){
    const DME = typeof DeviceMotionEvent !== 'undefined' ? DeviceMotionEvent : null;
    this.sign = (opts.guess === 1 || opts.guess === -1) ? opts.guess : ((DME && typeof DME.requestPermission === 'function') ? -1 : 1);
    this.how = '';                 // '' | 'orient' (measured) | 'default' (no verdict in 10 s: the guess stays, still unmeasured)
    this._run = 0; this._n = 0; this._t0 = 0; this._ori = null;
    this.sample = null;            // gyro + gravity: the screen-forward walk and the R3 spin read this
    this.gravity = null;           // gravity, gyro optional: the no-gyro walk and the fallback tip guard read this
    this.event = null;             // GBForwardWalk.eventInfo: which axes this browser supplies
  }
  get measured(){ return this.how === 'orient'; }
  orientation(e, t){ if(e && e.beta != null && e.gamma != null) this._ori = { b: e.beta, g: e.gamma, t: t }; }
  motion(e, t){
    const rr = e && e.rotationRate, fa = e && e.accelerationIncludingGravity, fl = e && e.acceleration;
    if(fa) this._signTick(fa, rr, t);
    const s = this.sign, lin = (fl && [fl.x, fl.y, fl.z].every(fin)) ? Math.sqrt(fl.x*fl.x + fl.y*fl.y + fl.z*fl.z) : null;
    this.sample = null; this.gravity = null;
    if(fa && [fa.x, fa.y, fa.z].every(fin))
      this.gravity = { t: t, a: rr ? rr.alpha : null, b: rr ? rr.beta : null, g: rr ? rr.gamma : null, x: fa.x*s, y: fa.y*s, z: fa.z*s, sign: s, linear: lin };
    const F = ROOT.GBForwardWalk;
    this.event = (F && typeof F.eventInfo === 'function') ? F.eventInfo(e, t) : null;
    if(rr && fa && [rr.alpha, rr.beta, rr.gamma, fa.x, fa.y, fa.z].every(fin))
      this.sample = { t: t, a: rr.alpha, b: rr.beta, g: rr.gamma, x: fa.x*s, y: fa.y*s, z: fa.z*s, sign: s, linear: lin };
  }
  _signTick(ag, rr, now){
    const o = this._ori;
    if(!this._t0 && (ag.x || ag.y || ag.z)) this._t0 = now;   // the 10 s default clock starts at the first real reading
    const c = (o && Math.abs(now - o.t) <= 250) ? signCos(ag, o, rr) : null, v = (c === null) ? 0 : (c >= 0.8 ? 1 : (c <= -0.8 ? -1 : 0));
    if(v && v === this._run) this._n++; else { this._run = v; this._n = v ? 1 : 0; }
    if(this.how !== 'orient'){ if(v && this._n >= 5){ this.sign = v; this.how = 'orient'; } else if(!this.how && this._t0 && now - this._t0 > 10000) this.how = 'default'; }
    else if(v && v !== this.sign && this._n >= 60) this.sign = v;   // hysteresis: a decided sign turns only on a long still run that says otherwise
  }
}
// cos of the angle between the reading and "up" from orientation (device frame, spec beta/gamma); null when the
// reading is not about 1 g or the phone is turning (next.html _gSignCos).
function signCos(ag, o, rr){
  const x = +ag.x || 0, y = +ag.y || 0, z = +ag.z || 0, m = Math.sqrt(x*x + y*y + z*z);
  if(m < 8.3 || m > 11.3) return null;
  if(rr && Math.abs(rr.alpha || 0) + Math.abs(rr.beta || 0) + Math.abs(rr.gamma || 0) > 30) return null;
  const b = o.b * D2R, g = o.g * D2R;
  return (-x*Math.sin(g)*Math.cos(b) + y*Math.sin(b) + z*Math.cos(g)*Math.cos(b)) / m;
}

// Gravity-only sensor check for the fallback walker: the stock walk's diagnostic codes and messages (forward-walk.js),
// minus the gyro requirement (the old walker runs without rotation rates).
function gravityCheck(s, now, sign){
  if(!s) throw motionErr('motion_no_event', 'No motion readings yet. Allow motion access and keep this page open.');
  if(![s.x, s.y, s.z].every(fin)) throw motionErr('motion_gravity_missing', 'This browser is not supplying usable gravity readings. Check motion permission in this browser.');
  if(!fin(now) || !fin(s.t)) throw motionErr('motion_invalid_time', 'Motion sensor timing is invalid. Reload this page.');
  if(now < s.t) throw motionErr('motion_future_time', 'Motion sensor timing is ahead of the page. Reload this page.');
  if(now - s.t > 1000) throw motionErr('motion_stale', 'Motion readings stopped. Keep this page visible and enable motion access.');
  if([1, -1].indexOf(sign) < 0 || [1, -1].indexOf(s.sign) < 0) throw motionErr('gravity_sign_unmeasured', 'Gravity direction is not measured yet. Hold the phone still briefly, then try again.');
  if(s.sign !== sign) throw motionErr('motion_sign_mismatch', 'The measured gravity direction changed. Hold still and try again.');
  return s;
}

// THE CURRENT WALK'S TIP RULE (forward-walk.js Controller.tick), for the old policy walker that stays as the fallback.
// Tilt = the angle of measured gravity in the walk's frame [y, -x, z]: never beta/gamma one Euler angle at a time
// (near a vertical mount they jump, and max(angDelta(beta), angDelta(gamma)) > 55 stopped a builder's upright phone).
// Armed 1 s after the first tick, then 5 in a row tip it: past 115 deg (face down), flat under 15 deg from a raised
// start (on its back), or more than 55 deg onto a side. 6 in a row of linear acceleration over 11 m/s^2 is a grab.
export class TipGuard {
  constructor(){ this.first = null; this.initialTilt = null; this.tipN = 0; this.jerkN = 0; }
  tick(s, now){
    const a = [s.y, -s.x, s.z], mag = Math.sqrt(a[0]*a[0] + a[1]*a[1] + a[2]*a[2]);
    if(!(mag >= 0.01)) throw new Error('gravity signal unavailable');
    const tilt = Math.acos(Math.max(-1, Math.min(1, a[2] / mag))) / D2R;
    if(this.first === null){ this.first = now; this.initialTilt = tilt; }
    if(now - this.first > 1000){
      this.tipN = (tilt > 115 || (this.initialTilt >= 20 && tilt < 15) || Math.abs(a[1]) / mag > Math.sin(55 * D2R)) ? this.tipN + 1 : 0;
      this.jerkN = (fin(s.linear) && s.linear > 11) ? this.jerkN + 1 : 0;
      if(this.tipN >= 5 || this.jerkN >= 6) return { abort: this.tipN >= 5 ? 'tipped' : 'grabbed', tilt: tilt };
    }
    return { tilt: tilt };
  }
}
function abortText(why){ return why === 'tipped' ? 'tipped over, stopped and resting' : 'picked up or grabbed, stopped and resting'; }

// ── body truth + verb menu ──────────────────────────────────────────────────
export function loadBodyTruth(url){
  return fetch(url || '/v3/body.json', { cache: 'no-store' }).then(r => {
    if(!r.ok) throw new Error('body.json ' + r.status);
    return r.json();
  });
}

// The external-agent contract: the kernel's legs verbs (speak/turn/forward/stop) plus
// NAMED gestures from body truth. No raw servo verb on purpose — "rich, specific verbs
// = the flexibility; clamped-not-raw params = the safety" (agent_kernel.js, 2026-06-30).
export function buildVerbMenu(bodyTruth, kernel){
  const K = kernel || (typeof globalThis !== 'undefined' && globalThis.GrowBotUnifiedAgent);
  if(!K) throw new Error('agent kernel not loaded (include /v3/agent_kernel.js first)');
  const bt = K.createBodyTruth('legs');
  bt.verbs = bt.verbs.filter(v => v.name.indexOf('mimic') < 0);   // phone-sensor games — not part of the external contract
  // Drop the kernel's duration_ms from forward/turn: this body has no odometry, so we
  // derive walk time from the magnitude (meters/degrees). The kernel injects a duration_ms
  // DEFAULT on every validate, which would otherwise mask the magnitude the agent asked
  // for — every forward becomes 1000ms regardless of meters. (review 0712)
  bt.verbs.forEach(v => { if((v.name === 'forward' || v.name === 'turn') && v.params) delete v.params.duration_ms; });
  const names = Object.keys((bodyTruth && bodyTruth.gestures) || {});
  if(names.length){
    bt.verbs.push({ name: 'gesture', effect: 'physical',
      params: { name: { required: true, enum: names } } });        // enum (no type) -> kernel's enum branch validates it
  }
  if(bodyTruth && bodyTruth.id) bt.id = bodyTruth.id;
  return bt;
}

// The minimal agent prompt — ONE source of truth. The outbound (OpenAI-compatible)
// loop uses it as the system prompt; the inbound handshake ships it in the menu
// envelope so any agent can feed it straight to its own model.
export function agentPrompt(menu, bodyTruth){
  const gest = Object.keys((bodyTruth && bodyTruth.gestures) || {}).join('|') || 'wiggle';
  return (
'You drive a small two-legged desk robot (GrowBot) by replying with exactly ONE verb call per turn.\n\n' +
'BODY: ' + ((bodyTruth && bodyTruth.name) || 'two-leg walker') + '. Two paddle legs that swing from the hips. It can walk, turn, gesture, and speak aloud through its phone. No arms, no wheels, no odometry.\n\n' +
'VERBS (the complete menu; anything else is rejected):\n' +
'  speak(text="...")                 say it aloud (max 180 chars)\n' +
'  forward(meters=0.05..2)           walk forward; ~0.05 m/s, meters are an estimate not a measurement\n' +
'  turn(degrees=-180..180)           turn in place (an arc-turn where spins are unavailable); negative = left, positive = right (approximate)\n' +
'  stop()                            halt everything, legs go limp\n' +
'  gesture(name=' + gest + ')   a canned expressive move\n\n' +
'RULES:\n' +
'- Reply with ONLY the verb call on one line. No prose, no markdown, no code fences, no explanation.\n' +
'- One verb per turn. Each turn you receive a fresh observation (sensors + the result of your last verb).\n' +
'- Out-of-range numbers are clamped; off-menu verbs are rejected and the robot does nothing.\n' +
'- A safety layer enforces servo limits and a motion duty budget (about 20s of leg motion per minute). If an ack says the budget is spent, speak or wait instead of moving.');
}

// ── SafeBody: verbs in, clamped relay traffic out ───────────────────────────
// opts: { kernel, bodyTruth (required), relay, sensors: ()=>({ori,rate,accel}|null),
//         motion: a ForwardCapture the page feeds (the stock walk/spin read it; the fallback tip guard reads its gravity),
//         query: URL query override (default location.search: ?forwardwalk=0 / ?normalspin=0 roll back like the app),
//         speak: (text)=>void, onTrace: (line,kind)=>void, onState: ()=>void,
//         policyUrl (default '/policy_85mm.json', the old walker that stays as the fallback) }
export class SafeBody {
  constructor(deviceId, opts = {}){
    this.id = String(deviceId || 'bench');
    this.K = opts.kernel || (typeof globalThis !== 'undefined' && globalThis.GrowBotUnifiedAgent);
    if(!this.K) throw new Error('agent kernel not loaded');
    this.bt = opts.bodyTruth;
    if(!this.bt) throw new Error('SafeBody needs bodyTruth (loadBodyTruth first)');
    this.menu = buildVerbMenu(this.bt, this.K);
    this.prompt = agentPrompt(this.menu, this.bt);
    this.sensors = opts.sensors || null;
    this.motion = opts.motion || null;
    this.query = opts.query != null ? String(opts.query) : null;
    this.speakFn = opts.speak || null;
    this.trace = opts.onTrace || function(){};
    this.onState = opts.onState || function(){};
    this.policyUrl = opts.policyUrl || (this.bt.walk && this.bt.walk.policy ? '/' + this.bt.walk.policy : '/policy_85mm.json');
    this.limits = this.bt.limits || { duty_ms: 20000, duty_window_ms: 60000, max_gesture_ms: 3000 };
    const s = (this.bt.servos && this.bt.servos[0]) || {};
    this.band = Array.isArray(s.band) ? s.band : [0, 180];   // 0929: fallback matches body.json's full band (was 5-175)
    this.body = new RelayBody(this.id, {
      relay: opts.relay || RELAY_DEFAULT,
      onStatus: a => { this._rxT = a ? Date.now() : 0; this.onState(); this.trace(a ? 'robot online' : 'robot offline', 'net'); },   // as next.html: awake:1 stamps, awake:0 CLEARS
      onAck: m => { this._rxT = Date.now(); this.trace('chip ack rid=' + m.rid + ' ok=' + m.ok + (m.queued_ms != null ? ' queued_ms=' + m.queued_ms : ''), 'net'); },
      onAlive: () => { this._rxT = Date.now(); },   // the relay's {t:'alive'} every 30 s for a heartbeat chip: proof of life with no motion
    });
    this._rxT = 0;                // last inbound proof of life (awake:1, an ack, an alive frame); awake:0 clears it
    this._motion = null;          // {kind, loopIv} — one mover at a time
    this._stopGen = 0;            // operator-stop generation (halt()); commands carry the generation they were produced under
    this._walkLog = [];           // [{t, ms}] duty ledger (walks + gestures)
    this._coolUntil = 0;          // tip-abort cooldown
    this._pj = null;              // cached policy json
    this.last = null;             // {verb, ok, note, t} — for the status screen + obs frames
  }

  connect(){ this.body.connect(); }
  close(){ this.stopMotion(); this.body.close(); }
  get robotAwake(){ return !!this.body.awake; }
  // next.html _bodyAlive (0830 F-4, 0925): the relay's awake status, or inbound traffic within 25 s when the status is
  // unreliable. A connected relay with no chip behind it (robot off, battery dead) is not a robot: walks refuse with
  // "robot not answering" instead of streaming into the void and acking "done".
  _bodyAlive(){ return !!(this.body && this.body.awake) || (!!this._rxT && Date.now() - this._rxT <= BODY_RX_MS); }

  dutyLeftMs(){
    const now = Date.now(), win = this.limits.duty_window_ms || 60000, cap = this.limits.duty_ms || 20000;
    this._walkLog = this._walkLog.filter(w => now - w.t < win);
    return Math.max(0, cap - this._walkLog.reduce((s, w) => s + w.ms, 0));
  }
  _dutyRestS(){
    const win = this.limits.duty_window_ms || 60000;
    const oldest = this._walkLog[0];
    return oldest ? Math.max(1, Math.ceil((win - (Date.now() - oldest.t)) / 1000)) : 1;
  }

  // Halt the current motion. CRUCIAL: settle its pending execute() promise, or an
  // interrupted walk/gesture (stop verb, supersede, STOP button) leaves execute()
  // hung forever — a missing ack inbound, a wedged loop outbound. (review 0712)
  stopMotion(reason){
    if(this._motion){
      const M = this._motion;
      if(M.loopIv) clearTimeout(M.loopIv);
      if(M.timer) clearTimeout(M.timer);   // the stock lane's 15 s policy-load timeout
      this._motion = null;
      if(M.resolve){ const done = M.resolve; M.resolve = null;
        // 1006: a stock walk/spin cancelled while its policy still loads never moved: say so, in the fallback's words
        done(M.loading ? { ok: false, verb: M.verb, error: 'cancelled, ' + (M.gen !== (this._stopGen | 0) ? 'STOP' : 'stopped or replaced') + ' during gait load' }
                       : { ok: true, verb: M.verb || 'stop', note: reason || 'stopped' }); }
    }
    try { if(this.body && this.body.ready) this.body.stop(); } catch (e) {}
    this.onState();
  }

  // OPERATOR STOP (0906, the STOP class ported from v3 — round 2). halt() bumps the stop GENERATION and halts motion. A
  // command carries the generation it was produced under (the caller captures gate.stopGen before it thinks; an inbound
  // envelope is stamped on arrival); execute() refuses a motion verb from an older generation, and both walkers re-check
  // the generation after every await of the gait load and before every pose. No time window: age is not identity.
  halt(reason){
    this._stopGen = (this._stopGen | 0) + 1;
    this.stopMotion(reason || 'operator stop');
  }
  get stopGen(){ return this._stopGen | 0; }

  get driving(){ return this._motion ? this._motion.kind : 'idle'; }

  obsFrame(){
    const S = this.sensors ? this.sensors() : null;
    const f = {
      at: Date.now(),               // NOT `t` — that key is the envelope type on the wire (obs bug, caught in E2E 0712)
      robot: this.robotAwake ? 1 : 0,
      driving: this.driving,
      duty_left_ms: this.dutyLeftMs(),
      orientation_deg: (S && S.ori) ? { alpha: Math.round(S.ori.a), beta: Math.round(S.ori.b), gamma: Math.round(S.ori.g) } : null,
      accel_mps2: (S && S.accel) ? { x: +S.accel.x.toFixed(2), y: +S.accel.y.toFixed(2), z: +S.accel.z.toFixed(2) } : null,
    };
    if(this.last) f.last_action = { verb: this.last.verb, ok: this.last.ok, note: this.last.note, s_ago: Math.round((Date.now() - this.last.t) / 1000) };
    return f;
  }

  _finish(ack){
    this.last = { verb: ack.verb || '?', ok: !!ack.ok, note: ack.error || ack.note || '', t: Date.now() };
    ack.duty_left_ms = this.dutyLeftMs();
    this.onState();
    return ack;
  }

  // The one entry point. Resolves when the action has PLAYED OUT (so a driving loop
  // naturally paces itself). Never throws — errors come back as {ok:false, error}.
  async execute(actionInput, opts){
    const cmdGen = (opts && opts.gen != null) ? (opts.gen | 0) : (this._stopGen | 0);   // the generation this command was produced under
    let a = this.K.parseAgentAction(actionInput);
    if(a.error) return this._finish({ ok: false, verb: '?', error: a.error });
    // SAFETY CLAMP, not rejection, for numeric ranges: dumb models learn faster from a
    // clamped success than a refusal. Off-menu verbs / unknown params still hard-fail.
    let clamped = false;
    const spec = (this.menu.verbs || []).filter(v => v.name === a.verb)[0];
    if(spec && a.params){
      for(const k of Object.keys(a.params)){
        const ps = spec.params && spec.params[k];
        if(ps && (ps.type === 'number' || ps.type === 'integer') && ps.min != null && ps.max != null){
          const raw = Number(a.params[k]);
          if(Number.isFinite(raw)){ const c = clampN(raw, ps.min, ps.max); if(c !== raw){ a.params[k] = c; clamped = true; } }
        }
      }
    }
    const v = this.K.validateAction(this.menu, a);
    if(!v.ok) return this._finish({ ok: false, verb: a.verb || '?', error: v.error });
    const act = v.action;
    this.trace('verb: ' + this.K.formatAction(act) + (clamped ? ' (clamped)' : ''), 'mv');

    let ack;
    const motionVerb = act.verb === 'gesture' || act.verb === 'forward' || act.verb === 'turn';
    if(motionVerb && cmdGen !== (this._stopGen | 0))   // STOP class (0906): a reply in flight across a STOP never moves the body
      return this._finish({ ok: false, verb: act.verb, error: 'cancelled, STOP was pressed' });
    if(act.verb === 'speak')        ack = this._speak(act.params.text);
    else if(act.verb === 'stop')  { this.stopMotion(); ack = { ok: true, verb: 'stop', note: 'halted, legs limp' }; }
    else if(act.verb === 'gesture') ack = await this._gesture(act.params.name);   // resolves after playout — MUST await or _finish decorates the Promise, not the ack
    else if(act.verb === 'forward'){ const met = act.params.meters == null ? 0.25 : act.params.meters;   // ~0.05 m/s -> time; clamped in _walk to the duty budget + 8s
      ack = await this._walk(0, clampN(met / 0.05 * 1000, 600, 8000), 'forward ' + met + 'm'); }
    else if(act.verb === 'turn'){ const dgr = act.params.degrees || 0;   // R3 spin: spinSecs(); the arc-turn fallback keeps ~22 ms/deg
      ack = await this._walk(Math.sign(dgr) || 1, clampN(Math.abs(dgr) * 22, 500, 6000), 'turn ' + Math.round(dgr) + '°', spinSecs(dgr)); }
    else ack = { ok: false, verb: act.verb, error: 'no actuator for verb' };   // unreachable if menu = dispatch
    if(clamped) ack.clamped = true;
    return this._finish(ack);
  }

  _speak(text){
    text = String(text || '').slice(0, 180);
    try {
      if(this.speakFn) this.speakFn(text);
      else if(typeof speechSynthesis !== 'undefined'){ speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); }
    } catch (e) {}
    return { ok: true, verb: 'speak', note: 'said aloud' };
  }

  _trim(steps){
    const c = readCal(), lo = +c.L_OFF || 0, ro = +c.R_OFF || 0;
    const B = this.band;
    return steps.map(s => ({
      l: Math.round(clampN((s.l == null ? 90 : s.l) + lo, B[0], B[1])),
      r: Math.round(clampN((s.r == null ? 90 : s.r) + ro, B[0], B[1])),
      ms: Math.round(clampN(s.ms, 120, Math.min(2500, this.limits.max_gesture_ms || 3000))),
    }));
  }

  _gesture(name){
    if(!this.body.ready) return { ok: false, verb: 'gesture', error: 'no robot connected on the relay' };
    const raw = (this.bt.gestures || {})[name];
    if(!Array.isArray(raw) || !raw.length) return { ok: false, verb: 'gesture', error: 'unknown gesture ' + name };
    const left = this.dutyLeftMs();
    if(left < 600) return { ok: false, verb: 'gesture', error: 'duty budget spent, legs rest ~' + this._dutyRestS() + 's' };
    let total = 0; const steps = [];
    for(const s of this._trim(raw.slice(0, 24))){ if(total + s.ms > Math.min(14000, left)) break; total += s.ms; steps.push(s); }
    if(!steps.length) return { ok: false, verb: 'gesture', error: 'duty budget spent, legs rest ~' + this._dutyRestS() + 's' };
    this.stopMotion('superseded');
    this._walkLog.push({ t: Date.now(), ms: total });
    this._motion = { kind: 'gesture', verb: 'gesture', loopIv: null, resolve: null };
    const M = this._motion;
    this.body.act(steps, 'replace');
    return new Promise(res => {
      M.resolve = res;   // stopMotion() settles this if the gesture is interrupted
      M.loopIv = setTimeout(() => {
        if(this._motion === M) this._motion = null;
        M.resolve = null; this.onState();
        res({ ok: true, verb: 'gesture', note: name + ' played (' + total + 'ms)', ms: total });
      }, total + 250);
    });
  }

  // yawBias: -1 left, 0 straight, +1 right. Resolves when the walk ends (or aborts).
  // 1006: with an IMU, forward runs the app's CURRENT stock walk (screen-forward, GBForwardWalk) and turn runs its R3
  // normal spin (GBNormalSpin), selected exactly as the app selects them (body, trims, SWAP, ?forwardwalk=0 /
  // ?normalspin=0, gyro present). Anything they refuse to run on falls back to the old policy walker, now guarded by
  // the current walk's gravity tip rule. No IMU at all = the honest open-loop shuffle, as before.
  async _walk(yawBias, ms, label, spinS){
    const verb = yawBias ? 'turn' : 'forward';
    if(!this.body.ready) return { ok: false, verb: verb, error: 'no robot connected on the relay' };
    if(!this._bodyAlive()) return { ok: false, verb: verb, error: 'robot not answering' };   // next.html _runGait
    if(Date.now() < this._coolUntil) return { ok: false, verb: verb, error: 'recovering balance, try again in a moment' };
    const left = this.dutyLeftMs();
    if(left < 900) return { ok: false, verb: verb, error: 'duty budget spent, legs rest ~' + this._dutyRestS() + 's' };
    const S0 = this.sensors ? this.sensors() : null;
    const haveIMU = !!(S0 && S0.ori);
    if(haveIMU){
      const lane = this._stockLane(yawBias);
      if(lane.on) return this._stockMove(yawBias, yawBias ? (spinS || spinSecs(90)) : Math.min(ms, 8000) / 1000, label);
      this.trace((yawBias ? 'R3 spin' : 'screen-forward walk') + ' not used here (' + lane.why + '): old policy walker with the gravity tip guard', 'mv');
      // the fallback's tip guard reads measured gravity: refuse before anything moves or the duty budget is charged
      const cap = this.motion;
      try { gravityCheck(cap ? cap.gravity : null, nowMs(), cap && cap.measured ? cap.sign : 0); }
      catch (e) { return { ok: false, verb: verb, error: 'walk refused: ' + motionWhy(e) }; }
    }
    ms = Math.min(ms, left, 8000);
    this.stopMotion();
    this._walkLog.push({ t: Date.now(), ms: ms });
    return haveIMU ? this._policyWalk(yawBias, ms, label) : this._marchWalk(yawBias, ms, label);
  }

  _cal(){ return Object.assign({}, (this.bt.walk && this.bt.walk.cal) || {}, readCal()); }   // = the app's calNow(): body truth, then the device's saved trims
  _q(){ return this.query != null ? this.query : (typeof location !== 'undefined' ? String(location.search || '') : ''); }

  // The app's selection: forwardWalkState() / normalSpinState() (next.html), minus the wheels and DIY lanes this
  // legs-only gateway does not have (normal-spin.js already steps aside for ?diygait=).
  _stockLane(turn){
    const F = ROOT.GBForwardWalk, cap = this.motion;
    if(!F) return { on: false, why: 'adapter_unavailable' };
    if(!cap) return { on: false, why: 'no_motion_capture' };
    if(turn){
      const N = ROOT.GBNormalSpin;
      if(!N) return { on: false, why: 'adapter_unavailable' };
      return N.select(this.bt, this._cal(), this._q(), cap.event || null);
    }
    return F.select(this.bt, this._cal(), this._q());
  }

  // Runs the stock walk / R3 spin the way next.html runForwardWalk / runNormalSpin do: sensors and trims checked before
  // anything moves, the SHA-pinned policy loaded (15 s timeout), a Controller built on the newest sample, then 25 Hz
  // ticks on nextDeadline. The Controller stands neutral for 1.2 s and owns the reflexes: gravity tilt tip, grab
  // (linear accel), and every sensor diagnostic (missing gyro/gravity, motion_stale, gravity sign unmeasured or
  // changed); the spin adds TipGuard for side and back falls. Every abort comes back as {ok:false, verb, error}; STOP
  // (generation), a stop verb or a newer motion (_motion supersede) end it before the next pose (during the load:
  // {ok:false, 'cancelled, ... during gait load'}), a robot that stops answering ends it, and every end goes through
  // body.stop().
  _stockMove(turn, secs, label){
    const verb = turn ? 'turn' : 'forward', kind = turn ? 'spin' : 'walk';
    const S = ROOT.GBForwardWalk, cap = this.motion, key = turn ? (turn < 0 ? 'ccw' : 'cw') : null;
    let F = turn ? ROOT.GBNormalSpin : S;
    if(!turn && ROOT.GBForwardChoice) F = ROOT.GBForwardChoice.pick(cap.gravity, cap.event);   // app parity: a phone without a gyro walks the no-gyro specialist
    const what = turn ? 'R3 spin ' + (key === 'ccw' ? 'left' : 'right') : ((F && F.NO_GYRO) ? 'screen-forward walk without gyro' : 'screen-forward walk');
    const sample = () => (F && F.NO_GYRO) ? cap.gravity : cap.sample;
    const frameOf = turn ? S : F;   // the spin checks its sensors with the walk's frame(), as runNormalSpin does
    const checkSensors = (t, expected) => {   // next.html checkSensors: an unmeasured gravity sign is passed as 0, so it refuses
      const info = cap.event || null;
      if(!cap.measured) return frameOf.frame(sample(), t, 0, info);
      if(expected !== undefined && cap.sign !== expected) throw motionErr('motion_sign_mismatch', 'The measured gravity direction changed. Hold still and try again.');
      return frameOf.frame(sample(), t, cap.sign, info);
    };
    const left = this.dutyLeftMs();
    if(left < 1200 + 1000) return { ok: false, verb: verb, error: 'duty budget spent, legs rest ~' + this._dutyRestS() + 's' };
    secs = Math.max(0, Math.min(secs, (left - 1200) / 1000));
    try { checkSensors(nowMs()); S.calibration(this._cal()); }
    catch (e) { return { ok: false, verb: verb, error: kind + ' refused: ' + motionWhy(e) }; }
    this.stopMotion('superseded');
    const gen = this._stopGen | 0;
    const M = { kind: 'walk', verb: verb, loopIv: null, timer: null, resolve: null, loading: true, gen: gen };
    this._motion = M; this.onState();   // owned from the start: a STOP, a stop verb or a newer verb during the load cancels it
    this.trace(what + ': loading the verified policy', 'mv');
    const self = this;
    return new Promise(res => {
      M.resolve = res;   // stopMotion() settles this if the move is interrupted (stop/supersede/STOP)
      const settle = (ack) => {   // resolve once; release the legs unless a newer motion already owns them
        if(!M.resolve) return;
        const done = M.resolve; M.resolve = null;
        if(M.loopIv) clearTimeout(M.loopIv);
        if(M.timer) clearTimeout(M.timer);
        M.loopIv = null; M.timer = null;
        const mine = self._motion === M;
        if(mine) self._motion = null;
        if(mine || !self._motion){ try { if(self.body && self.body.ready) self.body.stop(); } catch (e) {} }
        self.onState(); done(ack);
      };
      M.timer = setTimeout(() => { M.timer = null; settle({ ok: false, verb: verb, error: kind + ' could not load, try again (policy load timed out)' }); }, 15000);
      const fetcher = (u) => fetch(u), cry = typeof crypto !== 'undefined' ? crypto : undefined;
      Promise.resolve().then(() => turn ? F.load(key, fetcher, cry) : F.load(fetcher, cry)).then(p => {
        if(!M.resolve) return;   // already settled: stop verb, STOP, supersede or the load timeout
        if(M.timer){ clearTimeout(M.timer); M.timer = null; }
        if((self._stopGen | 0) !== gen){ settle({ ok: false, verb: verb, error: 'cancelled, STOP during gait load' }); return; }
        if(self._motion !== M){ settle({ ok: false, verb: verb, error: 'cancelled, replaced during gait load' }); return; }
        if(!self.body.ready || pageHidden()){ settle({ ok: false, verb: verb, error: 'interrupted: robot disconnected or page hidden' }); return; }
        if(!self._bodyAlive()){ settle({ ok: false, verb: verb, error: 'interrupted: robot not answering' }); return; }
        let C;
        const t0 = nowMs();
        try {
          if(!self._stockLane(turn).on) throw new Error(kind + ' setup changed');
          checkSensors(t0);
          C = turn ? new F.Controller(p, self._cal(), sample(), t0, key) : new F.Controller(p, self._cal(), sample(), t0);
        } catch (e) { settle({ ok: false, verb: verb, error: kind + ' could not start: ' + motionWhy(e) }); return; }
        M.loading = false;
        // 1006 (review safety F1): the R3 spin's Controller only stops a face-down fall (tilt > 115) or a grab, so a spin
        // knocked onto its side or back kept driving the legs. The spin also gets the walk's gravity rule (TipGuard: the
        // same numbers as forward-walk.js Controller.tick), armed with the Controller on the first tick after the stance.
        // forward needs no second copy: its Controller already runs exactly this rule.
        const guard = turn ? new TipGuard() : null;
        self._walkLog.push({ t: Date.now(), ms: 1200 + secs * 1000 });   // the neutral stance counts against the duty budget, as in the app
        self.trace(what + ': 1.2 s stance, then ' + secs.toFixed(1) + ' s', 'mv');
        let due = t0, end = null;
        const step = () => {
          if(!M.resolve) return;
          if((self._stopGen | 0) !== gen){ settle({ ok: false, verb: verb, error: 'cancelled, STOP' }); return; }   // checked before EVERY pose
          if(self._motion !== M){ settle({ ok: true, verb: verb, note: label + ' superseded' }); return; }
          if(!self.body.ready || pageHidden()){ settle({ ok: false, verb: verb, error: 'interrupted: robot disconnected or page hidden' }); return; }
          if(!self._bodyAlive()){ settle({ ok: false, verb: verb, error: 'interrupted: robot not answering' }); return; }
          const t = nowMs();
          if(t < C.last || t - C.last > 250){ settle({ ok: false, verb: verb, error: kind + ' interrupted: control paused' }); return; }
          try {
            if(!self._stockLane(turn).on) throw new Error(kind + ' setup changed');
            checkSensors(t, C.sign);
            if(end !== null && t >= end){ settle({ ok: true, verb: verb, note: label + ' done (' + what + ', ' + secs.toFixed(1) + ' s after a 1.2 s stance' + (turn ? '; angle not measured' : '') + ')', ms: Math.round(secs * 1000) }); return; }
            const out = C.tick(sample(), t, self._cal());
            if(out.abort){ self._coolUntil = Date.now() + 4000; settle({ ok: false, verb: verb, error: abortText(out.abort) }); return; }
            const fall = (guard && !out.prep) ? guard.tick(sample(), t).abort : null;
            if(fall){ self._coolUntil = Date.now() + 4000; settle({ ok: false, verb: verb, error: abortText(fall) }); return; }
            if(!out.prep && end === null) end = t + secs * 1000;
            self.body.pose(out.servo[0], out.servo[1]);
          } catch (e) { settle({ ok: false, verb: verb, error: kind + ' stopped: ' + motionWhy(e) }); return; }
          due = S.nextDeadline(due, nowMs()); M.loopIv = setTimeout(step, Math.max(0, due - nowMs()));
        };
        step();
      }).catch(e => { settle({ ok: false, verb: verb, error: kind + ' could not load: ' + motionWhy(e) }); });
    });
  }

  // The fallback: the old trained gait (policy_85mm), closed-loop on this device's IMU, in the browser, for a body or
  // trims the stock walk refuses (unsupported body, SWAP, invalid trims, ?forwardwalk=0 / ?normalspin=0, no gyro for
  // the spin). 1006: its tip reflex is the current walk's gravity rule (TipGuard), never Euler angles one at a time.
  async _policyWalk(yawBias, ms, label){
    const gen = this._stopGen | 0;   // STOP during the gait load (module import / policy fetch) must cancel BEFORE any pose is published
    const verb = yawBias ? 'turn' : 'forward';
    const M = { kind: 'walk', verb: verb, loopIv: null, resolve: null };
    this._motion = M; this.onState();   // owned from the start: a stop verb or a newer verb during the load cancels it too
    let pj = this._pj, GrowBotWalker;
    try {
      const mod = await import('./growbot_policy.js');
      GrowBotWalker = mod.GrowBotWalker;
      if(!pj){ const r = await fetch(this.policyUrl, { cache: 'no-store' }); if(!r.ok) throw new Error('policy ' + r.status); pj = this._pj = await r.json(); }
    } catch (e) { if(this._motion === M) this._motion = null; return { ok: false, verb: verb, error: 'gait load failed (' + e.message + ')' }; }
    if((this._stopGen | 0) !== gen){ if(this._motion === M) this._motion = null; return { ok: false, verb: verb, error: 'cancelled, STOP during gait load' }; }
    if(this._motion !== M) return { ok: false, verb: verb, error: 'cancelled, stopped or replaced during gait load' };
    const cal = Object.assign({}, (this.bt.walk && this.bt.walk.cal) || {}, readCal());
    cal.turn = clampN((+cal.turn || 0) + yawBias * 12, -20, 20);   // arc-turn = the Policy remote's turn bias
    const w = new GrowBotWalker(pj, cal);
    const hz = (this.bt.walk && this.bt.walk.rate_hz) || 30;
    const endT = Date.now() + ms;
    const S0 = this.sensors(); const base = { a: S0.ori.a, b: S0.ori.b, g: S0.ori.g };   // policy input reference only, never the tip check
    const cap = this.motion, sign0 = (cap && cap.measured) ? cap.sign : 0, guard = new TipGuard();
    const self = this;
    return new Promise(res => {
      M.resolve = res;   // stopMotion() settles this if the walk is interrupted (stop/supersede)
      const settle = (ack) => {   // resolve once, stop the legs, drop the resolver so stopMotion can't double-fire
        if(M.loopIv) clearTimeout(M.loopIv);
        if(self._motion === M) self._motion = null;
        M.resolve = null;
        try { if(self.body && self.body.ready) self.body.stop(); } catch (e) {}
        self.onState(); res(ack);
      };
      const step = () => {
        if((self._stopGen | 0) !== gen){ settle({ ok: false, verb: verb, error: 'cancelled, STOP' }); return; }   // checked before EVERY pose
        if(self._motion !== M){ settle({ ok: true, verb: verb, note: label + ' superseded' }); return; }
        if(!self._bodyAlive()){ settle({ ok: false, verb: verb, error: 'interrupted: robot not answering' }); return; }
        if(Date.now() >= endT){ settle({ ok: true, verb: verb, note: label + ' done (old policy walker, ' + ms + 'ms)', ms: ms }); return; }
        const S = self.sensors();
        if(!S || !S.ori){ settle({ ok: false, verb: verb, error: 'lost the IMU mid-walk, stopped' }); return; }
        // REFLEX (browser, not the brain): the current walk's gravity tip/grab rule on fresh gravity in the sign it was
        // measured in. Stale, missing or re-signed gravity stops the walk honestly instead of walking blind.
        const t0 = nowMs();
        try {
          const r = guard.tick(gravityCheck(cap ? cap.gravity : null, t0, sign0), t0);
          if(r.abort){ self._coolUntil = Date.now() + 4000; settle({ ok: false, verb: verb, error: abortText(r.abort) }); return; }
        } catch (e) { settle({ ok: false, verb: verb, error: 'walk stopped: ' + motionWhy(e) }); return; }
        const imu = { roll: wrap((S.ori.g - base.g) * D2R), pitch: wrap((S.ori.b - base.b) * D2R), yaw: wrap((S.ori.a - base.a) * D2R),
                      gr: (S.rate ? S.rate.g : 0) * D2R, gp: (S.rate ? S.rate.b : 0) * D2R, gy: (S.rate ? S.rate.a : 0) * D2R };
        const out = w.step(imu);
        try { self.body.pose(out.l, out.r); } catch (e) {}
        const spent = nowMs() - t0;
        M.loopIv = setTimeout(step, Math.max(0, 1000 / hz - spent));
      };
      step();
    });
  }

  // Honest fallback when this device has no IMU (e.g. the OpenAI-endpoint mode running
  // on a laptop): a rough open-loop shuffle. Real walking wants the closed-loop gait —
  // run the Custom tab on the robot's phone for that.
  _marchWalk(yawBias, ms, label){
    const gen = this._stopGen | 0;
    const verb = yawBias ? 'turn' : 'forward';
    const M = { kind: 'walk', verb: verb, loopIv: null, resolve: null };
    this._motion = M; this.onState();
    this.trace('no IMU here, open-loop shuffle (closed-loop gait needs the robot phone)', 'err');
    const c = readCal(), lo = +c.L_OFF || 0, ro = +c.R_OFF || 0, B = this.band;
    const endT = Date.now() + ms, hz = 30, A = 20, f = 1.4;
    let ph = 0;
    const self = this;
    return new Promise(res => {
      M.resolve = res;
      const settle = (ack) => {
        if(M.loopIv) clearTimeout(M.loopIv);
        if(self._motion === M) self._motion = null;
        M.resolve = null;
        try { if(self.body && self.body.ready) self.body.stop(); } catch (e) {}
        self.onState(); res(ack);
      };
      const step = () => {
        if((self._stopGen | 0) !== gen){ settle({ ok: false, verb: verb, error: 'cancelled, STOP' }); return; }   // checked before EVERY pose
        if(self._motion !== M){ settle({ ok: true, verb: verb, note: label + ' superseded' }); return; }
        if(!self._bodyAlive()){ settle({ ok: false, verb: verb, error: 'interrupted: robot not answering' }); return; }
        if(Date.now() >= endT){ settle({ ok: true, verb: verb, note: label + ' done (open-loop shuffle, ' + ms + 'ms)', ms: ms }); return; }
        ph += 2 * Math.PI * f / hz;
        const s = Math.sin(ph);
        const lA = A * (1 - 0.5 * Math.max(0, -yawBias));   // turning = shorten the inner leg's stride
        const rA = A * (1 - 0.5 * Math.max(0, yawBias));
        try { self.body.pose(clampN(90 + lo - lA * s, B[0], B[1]), clampN(90 + ro + rA * s, B[0], B[1])); } catch (e) {}
        M.loopIv = setTimeout(step, 1000 / hz);
      };
      step();
    });
  }
}

// ── AgentChannel: an external agent dials IN over the existing relay ────────
// Side channel "<deviceId>-agent" on the SAME deployed worker. This page = the
// channel's `hello` side; the agent = the `attach` side. Wire (agent's view):
//   agent -> {t:'attach', id:'<id>-agent', code:'<id>-agent'}   join
//   agent -> {t:'hi', name?}                                    ask for the menu
//   here  -> {t:'menu', menu, body, prompt}                     verbs + body truth + ready-made system prompt
//   here  -> {t:'obs', ...}                                     sensor ticker, ~2 Hz
//   agent -> {t:'verb', rid, action:'forward(meters=0.3)'}      or {t:'verb', rid, verb, params}
//   here  -> {t:'ack', rid, ok, note|error, clamped?, duty_left_ms}
//   agent -> {t:'ping'} -> here {t:'pong'}                      keepalive
export class AgentChannel {
  constructor(safeBody, opts = {}){
    this.sb = safeBody;
    this.relay = opts.relay || RELAY_DEFAULT;
    this.chan = safeBody.id + '-agent';
    this.onAgent = opts.onAgent || function(){};   // (seen:boolean, sAgo:number|null)
    this.onVerb = opts.onVerb || function(){};     // (actionText, ack)
    this.trace = safeBody.trace;
    this.ws = null; this._want = false; this._t = null; this._obsIv = null;
    this.lastAgentT = 0; this._seq = 0;
  }

  connect(){
    if(this._want) return;   // idempotent: the surface toggles this by mode; don't open a 2nd socket
    this._want = true;
    if(!this._obsIv) this._obsIv = setInterval(() => this._tick(), 1000 / OBS_HZ);
    this._open();
  }

  _open(){
    let ws;
    try { ws = new WebSocket(this.relay + '/d/' + encodeURIComponent(this.chan)); }
    catch (e) { this._retry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', id: this.chan }));   // we are this channel's body-side: agents that attach get forwarded to us
      this.trace('agent channel open (' + this.chan + ')', 'net');
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } this._onMsg(m); };
    ws.onclose = () => { this.ws = null; if(this._want) this._retry(); };
    ws.onerror = () => {};
  }

  _retry(){ clearTimeout(this._t); this._t = setTimeout(() => { if(this._want) this._open(); }, 1500); }

  close(){
    this._want = false;
    clearTimeout(this._t); clearInterval(this._obsIv); this._obsIv = null;
    try { if(this.ws) this.ws.close(); } catch (e) {}
    this.ws = null;
  }

  get ready(){ return !!this.ws && this.ws.readyState === 1; }
  get agentSeen(){ return this.lastAgentT && (Date.now() - this.lastAgentT < AGENT_STALE_MS); }

  _send(o){ try { if(this.ready) this.ws.send(JSON.stringify(o)); } catch (e) {} }

  _tick(){
    this._send(Object.assign({ t: 'obs', seq: ++this._seq }, this.sb.obsFrame()));
    this.onAgent(this.agentSeen, this.lastAgentT ? Math.round((Date.now() - this.lastAgentT) / 1000) : null);
  }

  _onMsg(m){
    if(!m || typeof m.t !== 'string') return;
    if(m.t === 'status') return;                      // relay presence noise on the side channel — not an agent envelope
    this.lastAgentT = Date.now();
    if(m.t === 'hi'){
      this.trace('agent said hi' + (m.name ? ' (' + String(m.name).slice(0, 40) + ')' : ''), 'net');
      this._send({ t: 'menu',
        menu: (this.sb.menu.verbs || []).map(v => ({ verb: v.name, effect: v.effect, params: v.params || {} })),
        body: { id: this.sb.bt.id, name: this.sb.bt.name, band: this.sb.band, limits: this.sb.limits,
                gestures: Object.keys(this.sb.bt.gestures || {}) },
        prompt: this.sb.prompt });
      this.onAgent(true, 0);
      return;
    }
    if(m.t === 'ping'){ this._send({ t: 'pong' }); return; }
    if(m.t === 'verb'){
      const rid = m.rid;
      const input = (m.action != null) ? m.action : { verb: m.verb, params: m.params };
      Promise.resolve(this.sb.execute(input)).then(ack => {
        this._send(Object.assign({ t: 'ack', rid: rid }, ack));
        this.onVerb(typeof input === 'string' ? input : JSON.stringify(input), ack);
      });
      return;
    }
    // anything else: ignore quietly (forward-compat), but it still counts as presence
  }
}
