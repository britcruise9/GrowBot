/* Agent face tracking — 0917; on by default since 0923 (next.html mounts it for a paired robot).
 *
 * WHAT IS REUSED, VERBATIM: the calibrated Combined gaze controller that is LIVE on
 * /tester/face.html. These four modules are imported from tester/face-evidence/ and are
 * NOT copied, re-derived or retuned here:
 *     combined-gaze.mjs   COMBINED_PROFILE (gain .99, bMax 6, leanScale .25, …)
 *     stance-guard.mjs    BENCH_GAZE envelope + the reversal/brake law
 *     hold-zone.mjs       the tested 75%-enter / 50%-exit coverage hold
 *     profile.mjs         the calibration gate
 * Baseline pinned 0917: /tester/face.html md5 0b65152fe107f4ad79055594a8492ccc
 * (= commit bda7318, "Use tested face-box coverage hold in Combined tracker"), and all four
 * modules byte-identical to live. The ONLY numbers restated in this file are the three energy
 * presets and the timing constants, copied verbatim from that page — see PRESETS below.
 *
 * 1001 opt-in fastResponse trial: a bounded large-error gain boost and warm reacquisition after
 * a <=150ms observation gap. The default still uses the calibrated behavior below.
 *
 * WHAT IS NEW: agent ownership (the thought loop turns it on/off and picks an energy level),
 * the explicit-disable latch, and a BOUNDED release after the brief hold. Everything about how
 * a face position becomes a leg pair is the tested controller's, untouched.
 *
 * NOT IN THIS RELEASE: recognition, identity, naming, search motion, motion blending,
 * any second stream, any LLM call of its own.
 * ES2018 only — no ?., no ??, no Object.hasOwn (0822 ES2018 law: one ?. parse-killed a tester tab).
 */
import {CombinedGaze, decodePose, leanLimit} from '../tester/face-evidence/combined-gaze.mjs';
import {HoldZone} from '../tester/face-evidence/hold-zone.mjs';
import {readFaceSelection, readFaceWiring} from '../tester/face-evidence/profile.mjs';

/* THE STANDARD BUILD FOLLOWS WITHOUT A CEREMONY (Brit 0921).
 * The tester gate bundled two different things. Only one of them is about safety:
 *   readFaceWiring  — refuses a leg-SWAPPED body. Combined emits absolute pre-swap wire targets,
 *                     so a swapped robot would be driven backwards. KEPT, unchanged.
 *   readFaceSelection — "has a person confirmed this exact robot by hand". A tester step. DROPPED.
 * A standard build has no saved gb_walk_cal at all, or one with SWAP false, and is 99.9% of
 * people now. The signature still carries the wiring verdict, so if a swap is set later
 * profileMatches() sees the change and stops tracking mid-flight, exactly as before. */
export function standardBuildProfile(storage, bodyId) {
  var id = typeof bodyId === 'string' ? bodyId.trim() : '';
  if (!id) return {supported:false, reason:'no_robot_paired', signature:null};
  var wiring;
  try { wiring = readFaceWiring(storage); }
  catch (_) { return {supported:false, reason:'leg_setup_unreadable', signature:null}; }
  if (!wiring.supported)
    return {supported:false, reason:'legs_wired_untested', signature:null, detail:wiring.reason};
  return {supported:true, reason:'', source:'standard', bodyId:id,
          signature:'standard-build:' + JSON.stringify([id, false])};
}

/* The three tested energy levels, copied EXACTLY from live face.html:
 *   $('mode').onchange … {quiet:[10,60],conversation:[60,60],engaged:[39,120]}
 * [sensitivity 10-100, requested °/s]. gain = sensitivity/100, exactly as that page does it.
 * NORMAL IS THE LOWEST LEVEL (this release's decision, not a retune): the tester page defaults
 * to conversation because a person is sitting in front of it choosing; an agent that turns this
 * on by itself starts at the quietest motion there is evidence for.
 * Note engaged's sensitivity (39) is BELOW conversation's (60) on purpose — that is the measured
 * pairing with 120°/s, not a typo, and it is not "fixed" here. */
export var PRESETS = {
  normal:       {sensitivity:10, speed:60,  rank:0, label:'normal'},
  conversation: {sensitivity:60, speed:60,  rank:1, label:'conversation'},
  engaged:      {sensitivity:39, speed:120, rank:2, label:'engaged'}
};
export var LEVELS = ['normal','conversation','engaged'];
export var ALIAS = {quiet:'normal', normal:'normal', low:'normal', gentle:'normal',
  conversation:'conversation', conversational:'conversation', medium:'conversation',
  engaged:'engaged', high:'engaged', lively:'engaged'};

/* Tested timing constants, copied from live face.html (same names, same values). */
export var HOLD_MS = 950;               // "Briefly lost — holding" window
export var REACQUIRE_MS = 250;          // steady-face observation before arming
export var REPEATED_REACQUIRE_MS = 600; // after repeated losses
export var LOSS_WINDOW_MS = 8000;       // losses older than this stop counting
export var LOSS_REPEAT_N = 3;           // this many losses in the window → longer reacquire
export var FRAME_STALE_MS = 400;        // an observation older than this is not steerable
export var FAST_LOSS_MS = 150;          // trial only: last good face -> returning good face
export var FAST_REACQUIRE_MS = 60;      // multiple fresh observations, while the same stance is still owned
/* Spatial continuity only when choosing among multiple faces, never identity. A sole valid
 * face follows the original acceptance rule, including after a large move or a camera stall. */
export function selectFace(boxes, previous) {
  var candidates = (Array.isArray(boxes) ? boxes : []).filter(function (b) {
    return b && ['x','y','width','height'].every(function (k) { return Number.isFinite(b[k]); }) &&
      b.width > 0 && b.height > 0 &&
      Math.abs(b.x + b.width / 2 - .5) <= .5 && Math.abs(b.y + b.height / 2 - .5) <= .5;
  });
  if (candidates.length <= 1) return candidates[0] || null;
  function distance(a, b) {
    return Math.hypot(a.x + a.width / 2 - b.x - b.width / 2,
                      a.y + a.height / 2 - b.y - b.height / 2);
  }
  if (previous) {
    var nearby = candidates.map(function (b) { return {box:b, d:distance(b, previous)}; })
      .filter(function (v) {
        var ratio = v.box.width * v.box.height / (previous.width * previous.height);
        return v.d <= Math.min(.2, Math.max(.08, Math.max(previous.width, previous.height) * .75)) &&
          ratio >= .4 && ratio <= 2.5;
      }).sort(function (a, b) { return a.d - b.d; });
    if (!nearby.length || (nearby.length > 1 && nearby[1].d - nearby[0].d < .04)) return null;
    return nearby[0].box;
  }
  candidates.sort(function (a, b) {
    return b.width * b.height - a.width * a.height ||
      distance(a, {x:.5,y:.5,width:0,height:0}) - distance(b, {x:.5,y:.5,width:0,height:0}) ||
      a.x - b.x || a.y - b.y;
  });
  return candidates[0] || null;
}
export var SEND_EVERY_MS = 33;          // the tester's command cadence — the DECISION rate
/* 0929 (review P3): VSYNC SLACK on that gate. The page's post-detect tick is stamped when a ~34 ms detection
 * ENDS, so the next frame's tick came 32.7 ms later and was skipped: at a 15/s cap every other interpolating
 * command went (one send per detection, stepped). 4 ms of slack sends it; on a 60, 90, 120 or 144 Hz frame clock
 * the ordinary cadence is unchanged (the next frame after 29 ms is the same one as after 33). */
export var SEND_SLACK_MS = 4;
/* THE WIRE RATE IS NOT THE DECISION RATE. The controller still thinks at 33ms; what changed is
 * that an unchanged command is not repeated onto the relay. Measured over 2 minutes of tracking:
 * 3629 frames, of which 3628 were byte-identical to the one before while a face was held still or
 * moving ordinarily. A whole 4-second policy walk is ~120 frames, and the live agent — which does
 * not hang — only ever streams poses in those short bursts.
 * KEEPALIVE_MS refreshes the chip's dead-man lease when nothing has changed. It sits well inside
 * the 300ms wheels dead-man and the 500ms legs one, so the hold is never dropped.
 * Skip only when both rounded wire targets match the last send; even a tiny float change
 * can cross a rounding boundary. POSE_EPSILON is retained for old diagnostic consumers. */
export var KEEPALIVE_MS = 200;
export var POSE_EPSILON = 0.4;
export var RAMP_START_MS = 500;         // followRate: 12°/s for this long …
export var RAMP_MS = 100;               // … then ramp to the preset speed over this
export var RAMP_FLOOR = 12;             // °/s during the initial hold-back

/* SELF-ATTRIBUTION, sized to the step actually commanded.
 * The agent decides "that bump was me" from selfMoveUntil, and a blanket +2500ms on every command
 * at ~30Hz kept it permanently ahead of now — which silently switched off pickup/carry/ride
 * sensing, fall attribution and mimic's self/other window for the whole tracking session.
 * Removing attribution is not the fix either: at conversation/engaged the legs really do sweep
 * (measured 62.7-70.6 deg over 6s, peaks 52-64 deg/s) and those bumps really are the robot's own.
 * So attribute per COMMAND. A step big enough to be felt claims its settling time; a step too
 * small to register claims nothing. Measured per-step sizes at the 33ms cadence:
 *     normal        ~0.17 deg/step  (peak  5 deg/s)  -> below the floor, claims nothing
 *     conversation  ~1.7  deg/step  (peak 52 deg/s)  -> claims its settle window
 *     engaged       ~2.1  deg/step  (peak 64 deg/s)  -> claims its settle window
 * A real sweep therefore stays continuously attributed, while gentle following stops blinding the
 * very sense that notices someone picking the robot up. A large correction at ANY level crosses the
 * floor, because the floor is about motion, not about which preset asked for it. */
/* A RATE, not a per-message delta. An earlier version expressed this floor in degrees per
 * command, which was fine until redundant frames stopped being repeated: the same motion then
 * arrived in fewer, larger messages (0.264 -> 0.588 deg at the gentle level) and crossed a floor
 * that had not moved. Degrees per second is what the servo actually does, and it is unchanged by
 * how the messages are batched. Measured peaks: normal ~8, conversation ~48, engaged ~62. */
export var SELF_MOVE_MIN_DEG_S = 15;    // slower than this is not felt as the robot's own motion
export var SELF_MOVE_SETTLE_MS = 350;   // how long one felt movement owns the bumps it makes

/* THE CREATURE'S OWN ENERGY PICKS THE LEVEL. mood.e is its 1-D arousal (0..1, resting 0.4,
 * moved by each reply's emotion) — the natural thing to link to, and distinct from energyState,
 * which is credits/sleep. Thresholds put the resting creature on the quietest level, so "normal
 * is the usual" still holds; only a genuinely lively mood steps up. An explicit agent or person
 * choice always wins over this, because only the 'auto' actor is ever re-synced from mood. */
/* 0923 (Brit, [session id removed]): the quietest preset was "so subtle i barely saw it", and with a
 * 0.5 cutoff an ordinary curious creature (target 0.55, drifting) sat on the boundary and fell into
 * it. Everyday energy (curious 0.55, happy 0.7) now gets the clearly visible middle preset; only a
 * genuinely calm or sleepy creature (calm targets 0.3) settles to the quietest, and alert/scared
 * (0.8/0.85) rise to engaged. The presets themselves are unchanged. */
export var MOOD_LEVELS = [[0.35, 'normal'], [0.75, 'conversation'], [Infinity, 'engaged']];
export function levelForEnergy(e) {
  if (!Number.isFinite(e)) return 'normal';
  for (var i = 0; i < MOOD_LEVELS.length; i++) if (e < MOOD_LEVELS[i][0]) return MOOD_LEVELS[i][1];
  return 'normal';
}
export function levelOf(value) {
  if (typeof value !== 'string') return null;
  var key = ALIAS[value.trim().toLowerCase()];
  return key ? key : null;
}
/* HOW FAR OUTSIDE the tested envelope a pose sits, in motor degrees. 0 = inside.
 * Brit, 0918: "from any position, face tracking should work because you're just updating legs to
 * improve the distance of the centroid of the face to the centre... we could bring the leg towards
 * the nearest position inside the envelope where it does work."
 * He is right, and the tested controller already does it: CombinedGaze.step clamps height into
 * [hMin,hMax], clamps lean to leanLimit(h), and retracts lean before leaving the support corridor —
 * all rate-limited. MEASURED on the three real stances from his sessions, feeding them straight in:
 *     walk 2 (h=-28.1, worst)  error 28.2 -> 0 in 0.59s
 *     walk 1 (lean -7.9)       error  1.9 -> 0 in 0.07s
 *     spin   (lean -31.8)      error 25.8 -> 0 in 0.63s
 * every one monotonic. So refusing to steer from outside was blocking a recovery the calibrated
 * controller performs natively — the envelope is where it is MEASURED, not a wall it must be
 * placed inside first. What replaces the refusal is a direction check: the error may never grow. */
/* The two halves of being outside, which are different physical situations. */
export function heightError(pair) {
  if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isFinite)) return Infinity;
  var h = decodePose(pair).h;
  if (!Number.isFinite(h)) return Infinity;
  return Math.max(0, -12 - h, h - 60);
}
export function leanError(pair) {
  if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isFinite)) return Infinity;
  var hb = decodePose(pair);
  if (!Number.isFinite(hb.h) || !Number.isFinite(hb.b)) return Infinity;
  return Math.max(0, Math.abs(hb.b) - leanLimit(hb.h));
}
export function envelopeError(pair) {
  if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isFinite)) return Infinity;
  var hb = decodePose(pair);
  if (!Number.isFinite(hb.h) || !Number.isFinite(hb.b)) return Infinity;
  return Math.max(0, -12 - hb.h, hb.h - 60) + Math.max(0, Math.abs(hb.b) - leanLimit(hb.h));
}
export function supportedPose(pair) { return envelopeError(pair) <= 1e-8; }
/* A pose is KNOWN when this page has actually commanded one. Nothing else counts: there is no
   sensor in the legs, so an unknown pose is unknown, not zero. */
export function poseKnown(pair) {
  return Array.isArray(pair) && pair.length === 2 && pair.every(Number.isFinite);
}
/* A recovery that is not converging is a real fault, not a slow one. The worst real stance took
 * 0.59s; this is an order of magnitude of headroom before the tracker gives the legs back. */
export var RECOVER_MAX_MS = 6000;
/* HOW FAR OUTSIDE THE ENVELOPE THE DEFAULT RELEASE WILL RECOVER FROM.
 * The controller demonstrably converges from far outside — 25.8 and 28.2 degrees of error came
 * back in 0.63s and 0.59s, monotonically — but a shrinking error is a fact about the CONTROLLER,
 * not evidence that this robot can stand up from a collapsed stance without a hand near it.
 * Those two stances are what a walk and a spin actually leave behind, and neither has been tested
 * physically from collapse. So the default budget covers ordinary drift and the milder walk
 * ending (1.9), and refuses the collapsed ones until someone has watched it try:
 *     ?ftrecover=1 lifts the budget for exactly that supervised test.
 * Beyond the budget the tracker does not steer and does not switch off — it waits for a stance it
 * may steer from (0929: the body's own stand; the supervised centring glide is gone). */
export var RECOVER_MAX_ERROR_DEG = 8;      // HEIGHT only: standing up from a collapse is untested
/* Lean is a different situation: the robot is upright and only tilted, and retracting lean is what
 * the controller does natively (leanLimit clamps it, and it retracts before leaving the support
 * corridor, so the recovery direction is toward stability). A spin routinely leaves 8-26 degrees
 * of excess lean; refusing those meant a turn ended following until someone asked it to stand. */
export var RECOVER_MAX_LEAN_DEG = 35;
/* followRate, verbatim from face.html: requested angle speed, not measured shaft speed. */
export function followRate(ageMs, speed) {
  var ramp = Math.max(0, Math.min(1, (ageMs - RAMP_START_MS) / RAMP_MS));
  return RAMP_FLOOR + (speed - RAMP_FLOOR) * ramp;
}

export function FaceTrack(host) {
  this.host = host;
  /* 1001 supervised response experiment. Large image errors earn more correction; close to
   * centre the calibrated gain is unchanged. Presets, pose envelope, acceleration and joint
   * speed limits remain the original controller's. A missing/unknown option is the baseline. */
  this.fastResponse = !!(host && host.fastResponse === true);
  /* opts.recoverMaxErrorDeg lets the preview flag lift the budget for a supervised physical test */
  /* Number.isFinite(Infinity) is false, and the supervised flag passes exactly Infinity — guarding
     with isFinite silently ignored the lift and kept the default budget. Accept any positive
     number, Infinity included. */
  this.recoverMaxErrorDeg = (host && typeof host.recoverMaxErrorDeg === 'number' && host.recoverMaxErrorDeg > 0)
    ? host.recoverMaxErrorDeg : RECOVER_MAX_ERROR_DEG;
  this.gaze = new CombinedGaze();
  this.zone = new HoldZone();
  /* THREE DISTINCT STATES, never collapsed:
   *   disabled  — nobody asked for it, or someone explicitly said stop. Latched.
   *   yielded   — asked for, but another controller owns the legs right now. Resumes itself.
   *   active    — this tracker owns the legs (owns=true) or is qualifying a face.
   * `latched` is the explicit-disable flag: only an explicit enable clears it. A yield NEVER
   * sets it, which is the whole point of keeping the two apart. */
  this.enabled = false;
  this.latched = false;
  this.agentPaused = false;
  this.latchReason = '';
  this.owns = false;
  this.level = 'normal';
  this.generation = 0;
  this.authorization = 0;
  this.message = 'Not tracking';
  this.metrics = {captured:0, decoded:0, dropped:0, detectMs:[], frameAge:[], commandMs:[],
    frameInterval:[], lastFrameAt:-1, stepLog:[], workerMs:[], workerMode:0, flowMode:0, flowFrames:0, flowMs:[],
    sends:0, sendFail:0, holds:0, releases:0, yields:0, reacquires:0};
  this.clear();
}
FaceTrack.prototype.preset = function () { return PRESETS[this.level] || PRESETS.normal; };
FaceTrack.prototype.clear = function () {
  this.gaze.reset(); this.zone.reset();
  this.observedAt = -Infinity; this.flowAt = -Infinity; this.box = null; this.seenSince = null; this.began = null;
  this.target = null; this.targetAt = -Infinity; this.lastStep = null;
  this.lastSend = null; this.lastPair = null; this.lastSentPair = null; this.smooth = 0;
  this.lossAt = null; this.holdingSince = null; this.released = false;
  this.warmBegan = null; this.warmLevel = null; this.fastReacquire = false; this.fastSeenN = 0;
  this.outOfRange = false; this.recoverFrom = null;
};
FaceTrack.prototype.say = function (text) {
  this.message = text;
  if (this.host.status) this.host.status(text);
};
FaceTrack.prototype.note = function (details) { if (this.host.event) this.host.event(details); };

/* ---- what the thought loop is allowed to see. Short, and computed fresh at read time. ---- */
FaceTrack.prototype.phase = function () {
  if (this.latched) return 'disabled_by_person';
  if (this.agentPaused) return 'disabled_by_agent';
  if (!this.enabled) return 'off';
  if (this.owns) return 'tracking';
  var s = this.host.state();
  if (s.busy || s.measuring) return 'yielded';   /* a careful look is a yield too, and the prompt must say so */
  /* Derived from state — and SPLIT, because these are different problems with different
     answers. An unknown pose is a cold page with nothing commanded. A stance too far out is a
     crouch or a walk ending: the pose is perfectly well known, it is just outside the corridor the
     controller was measured in. Telling a crouched robot "nothing has commanded your legs yet" is
     simply false, and left Brit unable to tell why following had stopped. */
  if (!poseKnown(s.pose)) return 'leg_position_unknown';
  if (this.outOfRange || heightError(s.pose) > this.recoverMaxErrorDeg ||
      leanError(s.pose) > RECOVER_MAX_LEAN_DEG) return 'stance_too_far';
  return 'waiting_for_face';
};
FaceTrack.prototype.report = function () {
  var s = this.host.state(), phase = this.phase();
  return {
    phase: phase,
    level: this.level,
    latched: this.latched,
    agentPaused: this.agentPaused,
    latchReason: this.latchReason,
    cameraReady: !!s.camera,
    bodyReady: !!s.online,
    available: !!(s.camera && s.online && !s.blocked && s.profile && s.profile.supported),
    /* COMPUTED FROM THE HOST'S STATE, not only from a flag tick() sets (60s of nothing in
       [session id removed]). 0929: needsCentre is gone with the centring glide; the body stands itself. */
    poseUnknown: !poseKnown(s.pose),
    stanceTooFar: poseKnown(s.pose) && (heightError(s.pose) > this.recoverMaxErrorDeg ||
                                        leanError(s.pose) > RECOVER_MAX_LEAN_DEG),
    needsSetup: !(s.profile && s.profile.supported),
    recoveringMs: this.recoverFrom === null ? -1 : Math.max(0, Math.round(s.now - this.recoverFrom)),
    faceAgeMs: this.observedAt === -Infinity ? -1 : Math.max(0, Math.round(s.now - this.observedAt)),
    holdingMs: this.holdingSince === null ? -1 : Math.max(0, Math.round(s.now - this.holdingSince))
  };
};

/* ---- enable / disable ---- */
FaceTrack.prototype.refuse = function (reason, text) {
  this.lastRefusal = reason;
  this.note({state:'enable_refused', reason:reason, level:this.level});
  this.say(text);
  return {ok:false, reason:reason};
};
/* who: 'person' (UI / spoken), 'agent' (a decision carried on an ordinary reply), or 'auto'
 * (the idle-breathing default: it arms itself whenever it can). Only 'person' lifts a latch. */
FaceTrack.prototype.enable = function (level, who) {
  var want = levelOf(level) || 'normal';
  if (this.agentPaused && who !== 'person' && who !== 'agent')
    return this.refuse('disabled_by_agent', 'Tracking is off by your own choice.');
  if (this.latched && who !== 'person')
    return this.refuse('disabled_by_person', 'Tracking is off because you asked it to stop. Turn it back on when you want it.');
  /* A PERSON ASKING FOR IT BACK WITHDRAWS THEIR STOP, even if it cannot start this second.
     Clearing this only on a SUCCESSFUL start misattributed the state: tap it back on with the
     camera shut and the panel still read "disabled by person" while the real blocker was the
     camera. The latch exists to stop the AGENT overriding the person, so the person withdrawing
     it is the whole condition; the preconditions below still refuse, and say which one. */
  if (this.latched && who === 'person') {
    this.latched = false; this.latchReason = '';
    this.note({state:'latch_withdrawn', by:'person'});
  }
  if (who === 'person' || who === 'agent') this.agentPaused = false;
  /* ALREADY FOLLOWING: asking again ("follow me" twice) is at most a level change. Re-running the
     start below bumped the generation and cleared ownership mid-follow (ASTRA review 0923 P1-5). */
  if (this.enabled) {
    if (want !== this.level) return this.setLevel(want, who);
    return {ok:true, level:this.level, already:true};
  }
  var s = this.host.state();
  if (!s.profile || !s.profile.supported)
    return this.refuse('calibration_not_ready', 'Confirm this robot’s tested setup before tracking.');
  if (!s.camera) return this.refuse('camera_unavailable', 'Open the front camera first.');
  if (!s.online) return this.refuse('body_unavailable', 'Connect the body first.');
  if (s.blocked) return this.refuse('page_or_mode_unavailable', 'Tracking is unavailable right now.');
  /* A MOVEMENT IN PROGRESS OUTRANKS EVERYONE. A walk or a gesture gets to finish. */
  if (s.busy) return this.refuse('agent_motion_busy', 'Wait for the current movement to finish.');
  /* A HELD POSE IS NOT A REFUSAL. It is a stance, and tracking maintains a stance too — the first
     command simply takes the hold over (host.send ends it). Only a MOVEMENT in progress outranks
     this, above. The remaining safety is the corridor check below, which is what actually keeps
     the legs inside measured ground.
     NOTE, because it reverses an earlier reading of the brief: "do not AUTOMATICALLY resume during
     a task requiring stable positioning" was implemented as "any timed hold blocks tracking", and
     on the real robot that meant every pose the creature struck switched following off for up to
     60s. Stillness is now something the agent ASKS for explicitly with track:"off", rather than a
     side effect of holding a pose. Brit's call, 0918, on three sessions of evidence. */
  /* 0929: NO POSE IS NO REFUSAL. Following is ON with the legs relaxed too (Brit 0929: "when you see a face
     you follow it unless you're told otherwise"): tick() steers nothing from an unknown pose, and the host
     asks its body to stand when a face is there. An out-of-envelope pose is fine as before: tick() steers it
     back in while following, and the direction contract there is what keeps that honest. */
  this.enabled = true; this.owns = false; this.level = want; this.levelBy = who || 'agent';
  this.generation++; this.authorization++; this.clear();
  this.body = s.body; this.video = s.video; this.profile = s.profile; this.dir = s.dir; this.epoch = s.epoch;
  this.losses = [];
  this.note({state:'enabled', level:want, by:who || 'agent'});
  this.say('Tracking on (' + want + ') · waiting for one steady face');
  return {ok:true, level:want};
};
/* A LEVEL CHANGE IS NOT A RESTART: the tested page keeps following across a mode change and
 * only resets the hold/gaze integrators, so the legs do not jump. Same here. */
FaceTrack.prototype.setLevel = function (level, who) {
  var want = levelOf(level);
  if (!want) return {ok:false, reason:'unknown_level'};
  if (!this.enabled) return this.enable(want, who);
  if (want === this.level) return {ok:true, level:want};
  this.level = want; this.levelBy = who || 'agent';
  this.fastReacquire = false; this.warmBegan = null;
  this.zone.reset(); this.gaze.reset();
  if (this.box) this.smooth = this.box.x + this.box.width / 2 - .5;
  if (this.began !== null) this.began = this.host.state().now; // re-ramp into the new speed
  this.note({state:'level', level:want, by:who || 'agent'});
  this.say('Tracking on (' + want + ')');
  return {ok:true, level:want};
};
/* latch=true is an EXPLICIT disable: "stop tracking me", or the off control. It survives
 * everything except an explicit enable. release=false leaves the legs where a host controller
 * put them — only a tracker-owned stop releases the wire. */
FaceTrack.prototype.disable = function (opts) {
  var o = opts || {};
  var owned = this.owns;
  /* what the wire last carried, captured before clear() wipes it — the stance to hand back */
  var held = this.lastSentPair ? this.lastSentPair.slice() : null;
  this.enabled = false; this.owns = false;
  if (o.by === 'agent' && o.reason === 'agent_asked') this.agentPaused = true;
  this.generation++; this.authorization++;
  if (o.latch) { this.latched = true; this.latchReason = o.reason || 'person_asked'; }
  this.clear();
  /* Only a real release makes the commanded pose unknown — see the host's note. */
  if (this.host.invalidatePose) this.host.invalidatePose(owned && o.release !== false);
  /* Never stop a host walk/gesture while giving up tracker authority. The release carries the
     generation it belongs to: a release that arrives after this run ended — because a new face was
     acquired, or another controller took the legs — is DROPPED by the host rather than landing on
     whatever is driving now. Synchronous today; stamped so it stays correct if it ever is not. */
  if (owned && o.release !== false) { this.metrics.releases++; this.host.release(this.generation, held); }
  this.note({state:o.latch ? 'disabled_by_person' : 'stopped', reason:o.reason || '', by:o.by || 'system'});
  this.say(o.message || (o.latch ? 'Tracking off — you asked it to stop' : 'Tracking off'));
  return {ok:true, latched:this.latched};
};
/* A temporary handoff. Stays enabled, so it re-qualifies a face and resumes by itself. */
FaceTrack.prototype.yieldTo = function (why) {
  if (!this.enabled) return;
  var owned = this.owns, reason = why || 'host_motion';
  this.owns = false; this.generation++;
  this.clear();
  if (owned) this.metrics.yields++;
  this.say('Yielded to ' + reason + ' · will resume');
  /* LOG THE TRANSITION, NOT THE TICK. This tee is crossed at frame rate while a policy walk runs,
     and a row per call buried the journal: 199 of the 240 kept rows in [session id removed] were this
     single event, leaving 41 for everything else. Carry the suppressed count so the churn is still
     visible, exactly as the relay lane does. */
  this._yieldN = (this._yieldN || 0) + 1;
  if (owned || reason !== this._yieldWhy) {
    this.note({state:'yielded', reason:reason, n:this._yieldN});
    this._yieldWhy = reason; this._yieldN = 0;
  }
};
FaceTrack.prototype.valid = function (s) {
  return s.camera && s.online && !s.blocked && s.body === this.body && s.video === this.video &&
    s.dir === this.dir && s.profile && s.profile.supported &&
    s.profile.signature === this.profile.signature;
};

/* ---- one detector result. `token` pins it to the generation that asked for it, so a result
 *      in flight across a yield/stop can never steer. ---- */
FaceTrack.prototype.observe = function (boxes, at, video, token) {
  if (token === undefined) token = this.generation;
  if (!this.enabled || token !== this.generation || video !== this.video || !Number.isFinite(at)) return;
  var s = this.host.state();
  if (!this.valid(s) || s.busy || s.measuring || s.epoch !== this.epoch || at < this.observedAt) return;
  var previousAt = this.observedAt;
  if (at - this.observedAt >= FRAME_STALE_MS) {
    this.seenSince = null; this.warmBegan = null; this.fastReacquire = false;
  }
  this.observedAt = at; this.flowAt = at;
  if (!this.owns && at - this.targetAt >= HOLD_MS) this.target = null;
  var bb = selectFace(boxes, this.target);
  var ok = !!bb && ['x','y','width','height'].every(function (k) { return Number.isFinite(bb[k]); }) &&
    bb.width > 0 && bb.height > 0;
  var x = ok ? bb.x + bb.width / 2 - .5 : NaN, y = ok ? bb.y + bb.height / 2 - .5 : NaN;
  if (!ok || Math.abs(x) > .5 || Math.abs(y) > .5) {
    /* FACE GONE. Record the loss once, exactly as the tested page does, and let tick() hold. */
    if (this.box !== null || this.seenSince !== null) {
      if (this.owns && this.lossAt === null) {
        this.warmBegan = this.began; this.warmLevel = this.level;
        this.lossAt = at; this.holdingSince = at;
        this.losses = (this.losses || []).filter(function (t) { return at - t < LOSS_WINDOW_MS; });
        this.losses.push(at);
        this.metrics.holds++;
        /* A flickering detection is a loss per flicker; the journal keeps 240 rows, so note at most
           one every 2s and say how many were folded in (ASTRA re-review 0923). */
        if (!(at - (this.lostNoteAt === undefined ? -Infinity : this.lostNoteAt) < 2000)) {
          this.note({state:'face_lost', repeats:this.losses.length, folded:this.lostFolded || 0});
          this.lostNoteAt = at; this.lostFolded = 0;
        } else this.lostFolded = (this.lostFolded || 0) + 1;
      }
      this.zone.reset(); this.gaze.reset();
    }
    this.box = null; this.seenSince = null; this.began = null; this.fastReacquire = false;
    this.say(this.owns ? (this.released ? 'Face gone · legs released' : 'Briefly lost · holding')
                       : 'Waiting for one face');
    return;
  }
  /* A momentary detector miss need not repeat a cold-start ramp in the response trial. The
   * robot must still own its stance, the last good observation must be <=150ms old, and the
   * level must be unchanged. Longer loss, stale frames and every ownership handoff keep the
   * ordinary qualification/ramp. Acceleration starts from zero, and lost time is not integrated. */
  if (this.lossAt !== null && this.owns && this.fastResponse && !this.released &&
      at - this.targetAt <= FAST_LOSS_MS && this.warmBegan !== null && this.warmLevel === this.level &&
      this.targetAt - this.warmBegan >= RAMP_START_MS + RAMP_MS) {
    this.fastReacquire = true; this.fastSeenN = 0; this.began = this.warmBegan; this.lastStep = at;
  }
  if (this.fastReacquire && at > previousAt) this.fastSeenN = Math.min(2, this.fastSeenN + 1);
  this.box = {x:bb.x, y:bb.y, width:bb.width, height:bb.height};
  this.target = this.box; this.targetAt = at;
  if (this.seenSince === null) this.seenSince = at;
  if (this.lossAt !== null && this.owns) { this.lossAt = null; this.holdingSince = null; this.released = false; }
  if (x * this.smooth <= 0) this.smooth = x;   // a reversal discards the old direction at once
};

/* Flow may update the location of a qualified face, never the evidence that a face exists.
 * Keeping observedAt/targetAt/seenSince/fastSeenN untouched makes detector loss authoritative. */
FaceTrack.prototype.observeFlow = function (bb, at, anchorAt, video, token) {
  var s=this.host.state();
  if(!this.enabled||!this.owns||this.released||token!==this.generation||video!==this.video||
     !this.valid(s)||s.busy||s.measuring||s.epoch!==this.epoch||!this.box||this.lossAt!==null||
     this.seenSince===null||at-this.seenSince<this.reacquireMs()||
     !Number.isFinite(at)||!Number.isFinite(anchorAt)||anchorAt!==this.observedAt||
     at<=this.flowAt||at-anchorAt>90||s.now-anchorAt>90||at<anchorAt||!bb||
     !['x','y','width','height'].every(function(k){return Number.isFinite(bb[k]);})||
     bb.width<=0||bb.height<=0||bb.x<0||bb.y<0||bb.x+bb.width>1||bb.y+bb.height>1)return false;
  this.flowAt=at;
  this.box={x:bb.x,y:bb.y,width:bb.width,height:bb.height};this.target=this.box;
  var x=bb.x+bb.width/2-.5;
  if(x*this.smooth<=0)this.smooth=x;
  return true;
};

FaceTrack.prototype.reacquireMs = function () {
  if (this.fastResponse && this.fastReacquire && this.owns)
    return this.fastSeenN >= 2 ? FAST_REACQUIRE_MS : Infinity;
  var recent = (this.losses || []).length >= LOSS_REPEAT_N;
  return recent ? REPEATED_REACQUIRE_MS : REACQUIRE_MS;
};

FaceTrack.prototype.tick = function (now) {
  if (!this.enabled) return;
  var s = this.host.state();
  if (!this.valid(s)) {
    this.disable({release:this.owns, reason:'camera_body_or_setup_changed',
      message:'Tracking off — camera, body or setup changed'});
    return;
  }
  /* ANOTHER CONTROLLER IS STARTING. Yield BEFORE it commands anything. */
  if (s.busy || s.epoch !== this.epoch) { this.yieldTo('the agent’s movement'); this.epoch = s.epoch; return; }
  /* A MEASUREMENT IS IN PROGRESS (a deliberate visual-memory lookup). MOTION 0920: a hold that
     exists so a measurement can happen must not have tracking on top of it — at engaged that is
     a 67-71 deg sweep under the camera. Yield for its duration; resume after. Note this only
     steadies frames captured AFTER the job starts; the frame it opens with was already in the
     ring, and a still one there needs stillness beforehand — the agent's own track:"off". */
  if (s.measuring) {
    var heldForLook = this.owns && this.lastSentPair ? this.lastSentPair.slice() : null;
    this.yieldTo('a careful look');
    if (heldForLook) { this.metrics.releases++; this.host.release(this.generation, heldForLook); }
    return;
  }
  /* No fresh observation right now. NOT a disable: the host reports real camera loss through
     valid() above, and this only means the last frame is too old to steer from. Falls through to
     the hold-then-release path, and picks itself back up when frames return. */
  var stale = this.observedAt > now || now - this.observedAt >= FRAME_STALE_MS;
  if (stale) {
    if (this.owns && this.lastPair) {
      if (this.holdingSince === null) { this.holdingSince = now; this.metrics.holds++;
        this.note({state:'frames_stalled', ageMs:Math.round(now - this.observedAt)}); }
      if (now - this.holdingSince >= HOLD_MS) {
        if (!this.released) {
          this.released = true; this.owns = false; this.generation++;
          this.lastPair = null; this.metrics.releases++;
          this.gaze.reset(); this.zone.reset();
          this.host.release(this.generation, (this.lastSentPair || this.lastPair || []).slice());
          this.note({state:'hold_released', afterMs:Math.round(now - this.holdingSince), why:'frames_stalled'});
          this.say('Waiting for camera frames · holding your stance');
        }
        return;
      }
      if (this.lastSend === null || now - this.lastSend >= KEEPALIVE_MS) {
        /* a stall hold re-sends the SAME pair — no new motion, so no new self-attribution,
           and nothing to say on the wire beyond keeping the lease alive */
        if (this.host.noteSelfMotion) this.host.noteSelfMotion(0, SELF_MOVE_MIN_DEG_S, SELF_MOVE_SETTLE_MS);
        if (!this.host.send((this.lastSentPair || this.lastPair).slice())) {
          this.disable({release:false, reason:'body_unavailable', message:'Tracking off — body unavailable'});
          return;
        }
        this.lastSend = now;
      }
    } else this.say('Waiting for camera frames');
    this.box = null; this.seenSince = null;
    return;
  }
  if (this.lastSend !== null && now - this.lastSend < SEND_EVERY_MS - SEND_SLACK_MS) return;

  /* ---- no steerable face right now ---- */
  if (!this.box || this.seenSince === null || now - this.seenSince < this.reacquireMs()) {
    if (this.owns && this.lastPair) {
      /* THE TESTED BRIEF HOLD, THEN A BOUNDED RELEASE.
       * face.html refreshes the last command for as long as frames keep arriving, which on this
       * wire is indefinite holding torque (the chip holds while the lease is renewed). The tested
       * ORIGINAL tracker released to limp on loss (face-original.html releaseTracking → body.stop).
       * This keeps face.html's brief hold and then takes Original's release: hold the last
       * commanded pair for HOLD_MS, then stop refreshing and release once. No search motion. */
      if (this.holdingSince !== null && now - this.holdingSince >= HOLD_MS) {
        if (!this.released) {
          var handBack = (this.lastSentPair || this.lastPair || []).slice();
          this.released = true; this.owns = false; this.generation++;
          this.lastPair = null; this.metrics.releases++;
          this.gaze.reset(); this.zone.reset();
          this.host.release(this.generation, handBack);
          this.note({state:'hold_released', afterMs:Math.round(now - this.holdingSince)});
          this.say('Face gone · holding your stance, still watching');
        }
        return;
      }
      if (this.lastSend !== null && now - this.lastSend < KEEPALIVE_MS) return;   /* lease still fresh */
      /* a hold re-sends the SAME pair — no new motion, so it claims no self-attribution */
      if (this.host.noteSelfMotion) this.host.noteSelfMotion(0, SELF_MOVE_MIN_DEG_S, SELF_MOVE_SETTLE_MS);
      if (!this.host.send((this.lastSentPair || this.lastPair).slice())) {
        this.disable({release:false, reason:'body_unavailable', message:'Tracking off — body unavailable'});
        return;
      }
      this.lastSend = now;
    }
    return;
  }

  /* ---- a qualified face: take ownership from the pose the host last commanded ---- */
  if (!this.owns) {
    /* An UNKNOWN pose is still refused — there is nothing to steer from, and guessing one is how
       a robot gets commanded somewhere nobody chose. An out-of-envelope pose is fine: we steer it
       back in while following, above. */
    if (!Array.isArray(s.pose) || s.pose.length !== 2 || !s.pose.every(Number.isFinite)) {
      if (!this.outOfRange) { this.outOfRange = true; this.note({state:'pose_unknown'}); }
      this.say('No leg position known yet · waiting for the body to stand');
      return;
    }
    /* Outside the recovery budget: steering back is untested FROM HERE on this robot, so it waits
       for a stance it may steer from (the body's stand). Still not a disable. */
    /* HEIGHT is the gated one. A robot standing and leaning can be picked up from; one that has
       collapsed cannot, because standing it back up is the case nobody has watched. */
    var hErr = heightError(s.pose), bErr = leanError(s.pose);
    if (hErr > this.recoverMaxErrorDeg || bErr > RECOVER_MAX_LEAN_DEG) {
      if (!this.outOfRange) {
        this.outOfRange = true;
        this.note({state:'pose_beyond_recovery_budget', h:Math.round(hErr * 10) / 10,
                   lean:Math.round(bErr * 10) / 10, budget:this.recoverMaxErrorDeg});
      }
      this.say(hErr > this.recoverMaxErrorDeg
        ? 'Too far down to pick up from · waiting for the body to stand'
        : 'Leaning too far to pick up from · waiting for the body to stand');
      return;
    }
    this.outOfRange = false;
    /* EACH ACQUISITION IS ITS OWN RUN. Without this bump the run that follows a bounded release
       reused the generation that release was stamped with, so a late release from the FINISHED run
       would have matched the NEW one and limped a freshly acquired face. Caught by the stale-release
       test; the bump is what makes the host's generation guard mean anything across a re-acquire. */
    this.generation++;
    this.lastPair = s.pose.slice();
    this.lastSentPair = s.pose.slice();
    this.recoverFrom = envelopeError(this.lastPair) > 0 ? now : null;
    this.lastSend = now; this.lastStep = now; this.began = now; this.owns = true;
    this.lossAt = null; this.holdingSince = null; this.released = false;
    this.metrics.reacquires++;
    if ((this.losses || []).length >= LOSS_REPEAT_N) this.losses = [];
    this.note({state:'following', level:this.level});
  }
  if (this.began === null) this.began = now;

  var p = this.preset();
  /* Integrate each elapsed interval once even when wire sends are deduplicated. */
  var dt = Math.max(0, Math.min(.1, (now - this.lastStep) / 1000));
  this.lastStep = now;
  var x = this.box.x + this.box.width / 2 - .5, y = this.box.y + this.box.height / 2 - .5;
  this.smooth += (x - this.smooth) * (1 - Math.exp(-dt / .02));   // the tested 20ms image filter
  var was = this.zone.holding;
  var holding = this.zone.step(this.box, {supported:supportedPose(this.lastPair)});
  if (was !== holding) { this.gaze.reset(); this.smooth = x; }
  var rate = followRate(now - this.began, p.speed);
  var boost = this.fastResponse ? 1 + Math.max(0, Math.min(1,
    (Math.max(Math.abs(this.smooth), Math.abs(y)) - .08) / .16)) : 1;
  var pair = this.gaze.step(this.lastPair, holding ? 0 : this.smooth, holding ? 0 : y, dt,
    {rate:rate, gain:p.sensitivity / 100 * boost, verticalOnly:false, dir:s.dir});
  /* THE DIRECTION IS THE CONTRACT, not the absolute position. Inside the envelope this is the old
     check exactly (0 stays 0). Outside it, every step must move toward the envelope; a step that
     would move FURTHER out is a real fault and still stops. */
  var errNow = envelopeError(pair), errWas = envelopeError(this.lastPair);
  if (errNow > errWas + 1e-6) {
    this.disable({release:true, reason:'gaze_left_tested_stance',
      message:'Tracking off — the request moved further outside the tested stance'});
    return;
  }
  if (errNow > 1e-6) {   /* the same float allowance as the check above: rounding is not "outside" */
    if (this.recoverFrom === null) this.recoverFrom = now;
    if (now - this.recoverFrom > RECOVER_MAX_MS) {
      this.disable({release:true, reason:'recovery_stalled',
        message:'Tracking off — could not bring the legs back into range'});
      return;
    }
  } else if (this.recoverFrom !== null) {
    /* Change-only, like the yield tee: the legs can cross the envelope edge repeatedly while
       following (18 rows in 3.5s in [session id removed]), and a row per crossing buries the journal
       the same way the yield spam did. Log the first, then one per 10s with the count. */
    var ms = Math.round(now - this.recoverFrom);
    this._recovN = (this._recovN || 0) + 1;
    if (!this._recovAt || now - this._recovAt > 10000) {
      this.note({state:'recovered', ms:ms, n:this._recovN});
      this._recovAt = now; this._recovN = 0;
    }
    this.recoverFrom = null;
  }
  /* Nothing new to say, and the lease is still fresh: keep the decision, skip the wire. */
  var prevPair = (this.lastSentPair || this.lastPair).slice();
  var unchanged = Math.round(pair[0]) === Math.round(prevPair[0]) &&
                  Math.round(pair[1]) === Math.round(prevPair[1]);
  if (unchanged && this.lastSend !== null && now - this.lastSend < KEEPALIVE_MS) {
    this.metrics.skipped = (this.metrics.skipped || 0) + 1;
    this.lastPair = pair;
    this.say(holding ? 'Tracking (' + this.level + ') · holding at 75% coverage'
                     : 'Tracking (' + this.level + ') · one face');
    return;
  }
  var t0 = this.host.now ? this.host.now() : now;
  if (!this.host.send(pair)) {
    this.metrics.sendFail++;
    this.disable({release:false, reason:'body_unavailable', message:'Tracking off — body unavailable'});
    return;
  }
  var t1 = this.host.now ? this.host.now() : now;
  this.metrics.sends++;
  this.lastSentPair = pair.slice();   /* what the WIRE carries — the hold re-commands THIS, not the
                                         decision, which skipped frames advance by up to POSE_EPSILON */
  /* Report the size of the step so the host can attribute the motion that actually happened. */
  var stepDeg = Math.max(Math.abs(pair[0] - prevPair[0]), Math.abs(pair[1] - prevPair[1]));
  /* Elapsed since the last thing that actually went out, so batching cannot inflate the rate. */
  var sinceMs = this.lastSend === null ? SEND_EVERY_MS : Math.max(1, now - this.lastSend);
  var stepRate = stepDeg / (sinceMs / 1000);
  this.lastStepDeg = stepDeg; this.lastStepRate = stepRate;
  if (stepDeg > (this.metrics.maxStepDeg || 0)) this.metrics.maxStepDeg = stepDeg;
  if (stepRate > (this.metrics.maxStepRate || 0)) this.metrics.maxStepRate = stepRate;
  /* A rolling log of real motion, so a visual-memory lookup can be judged against how much the
     body was actually moving while its frames were captured — rather than against the assumption
     that sharing one camera makes the images fine. */
  this.metrics.stepLog.push({t:now, d:stepDeg});
  while (this.metrics.stepLog.length && now - this.metrics.stepLog[0].t > 20000) this.metrics.stepLog.shift();
  if (this.host.noteSelfMotion) this.host.noteSelfMotion(stepRate, SELF_MOVE_MIN_DEG_S, SELF_MOVE_SETTLE_MS);
  /* commandMs is a DURATION across one clock, so host.now() on both ends is safe.
   * frameAge is a DIFFERENCE BETWEEN TWO STAMPS and must use one clock: observedAt carries the
   * caller's `at`, so the age is measured against the caller's `now`, never host.now(). Mixing
   * them read 149 SECONDS on a 4-second run the first time this was measured — the metric would
   * have looked plausible on the phone (where both happen to be performance.now()) while being
   * structurally wrong, which is the failure mode worth spending a line on. */
  push(this.metrics.commandMs, t1 - t0);
  push(this.metrics.frameAge, Math.max(0, now - this.observedAt));   // observation → command out
  this.lastPair = pair; this.lastSend = now;
  this.say(holding ? 'Tracking (' + this.level + ') · holding at 75% coverage'
                   : 'Tracking (' + this.level + ') · one face');
};

function push(arr, v) { if (Number.isFinite(v)) { arr.push(v); if (arr.length > 240) arr.shift(); } }
function pct(arr, q) {
  if (!arr.length) return -1;
  var a = arr.slice().sort(function (x, y) { return x - y; });
  return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * q))] * 10) / 10;
}
/* DROPPED FRAMES AS A RATIO, never a rate.
 * ATTRIBUTION, checked rather than assumed: the 800px/8fps cap and the 50%-vs-93% decode figures
 * come from the watch-service marker pipeline (raw-capture.mjs / marker-analysis.mjs). Those files
 * do not exist in this repository and neither next.html nor this module references them — this
 * path is the agent's own camera at 320x240 ideal (240x180 at 10fps under LOW_POWER), read
 * straight off camV. So none of those numbers are carried over or expected here.
 * What IS carried over is only the reporting rule, which stands on its own: a rate cannot show
 * frames being discarded, a ratio can. The numbers below are measured on THIS path. */
FaceTrack.prototype.stats = function () {
  var m = this.metrics;
  return {
    workerMode: m.workerMode || 0, flowMode:m.flowMode||0, flowFrames:m.flowFrames||0,
    flowMsMedian:pct(m.flowMs,.5), flowMsP95:pct(m.flowMs,.95), fastResponse: this.fastResponse ? 1 : 0,
    workerMsMedian: pct(m.workerMs, .5), workerMsP95: pct(m.workerMs, .95),
    captured: m.captured, decoded: m.decoded, dropped: m.dropped,
    decodeRatio: m.captured ? Math.round(m.decoded / m.captured * 1000) / 1000 : -1,
    frameIntervalMsMedian: pct(m.frameInterval, .5), frameIntervalMsP95: pct(m.frameInterval, .95),
    detectMsMedian: pct(m.detectMs, .5), detectMsP95: pct(m.detectMs, .95),
    frameAgeMsMedian: pct(m.frameAge, .5), frameAgeMsP95: pct(m.frameAge, .95),
    commandMsMedian: pct(m.commandMs, .5), commandMsP95: pct(m.commandMs, .95),
    maxStepDeg: Math.round((m.maxStepDeg || 0) * 100) / 100,
    maxStepRate: Math.round((m.maxStepRate || 0) * 10) / 10,
    sends: m.sends, skipped: m.skipped || 0, sendFail: m.sendFail, holds: m.holds, releases: m.releases,
    yields: m.yields, reacquires: m.reacquires
  };
};

/* ---- the detector. Same CDN, same model, same options as the tested page. ---- */
/* 0923 SELF-HOSTED (Brit: "at scale, 100s of growbots, we don't lose face tracking"). The same
 * @mediapipe/tasks-vision 0.10.18 files, byte-identical to npm's signed tarball (sha512 integrity
 * NRIlyqhGUz1J...), and the same BlazeFace short-range float16 v1 model, served from growbot.dev
 * under versioned immutable paths. No third-party origin: if growbot.dev is up, so is the detector. */
export var DETECTOR_BASE = '/vendor/mediapipe/tasks-vision-0.10.18';
export var DETECTOR_MODEL = '/vendor/mediapipe/models/blaze_face_short_range-float16-1.tflite';
export function faceDetector(canvas) {
  var V = DETECTOR_BASE;
  return import(V + '/vision_bundle.mjs').then(function (mod) {
    return mod.FilesetResolver.forVisionTasks(V + '/wasm').then(function (fileset) {
      var options = {
        baseOptions:{modelAssetPath:DETECTOR_MODEL, delegate:'GPU'},
        runningMode:'VIDEO', minDetectionConfidence:.5
      };
      if (canvas) options.canvas = canvas;
      return mod.FaceDetector.createFromOptions(fileset, options);
    });
  });
}
/* How much the legs moved over the last `windowMs` — total swept degrees and the largest single
 * step. Used to label a visual-memory turn with the motion its frames were taken under. */
FaceTrack.prototype.motionSince = function (now, windowMs) {
  var log = this.metrics.stepLog, total = 0, peak = 0, n = 0;
  for (var i = 0; i < log.length; i++) {
    if (now - log[i].t > windowMs) continue;
    total += log[i].d; n++;
    if (log[i].d > peak) peak = log[i].d;
  }
  return {sweptDeg: Math.round(total * 10) / 10, peakStepDeg: Math.round(peak * 100) / 100,
          commands: n, movingWhileCapturing: total > 1};
};

/* A LOUD ANSWER TO "IS THE DETECTOR ACTUALLY THERE". 0917 carry-over: the analysis bridge
 * degrades silently when Worker/OffscreenCanvas/createImageBitmap are missing and reports
 * "still works" while producing no detections at all. Name that state instead of reading its
 * silence as "no face". */
export function detectorCapability(win) {
  var w = win || (typeof window !== 'undefined' ? window : {});
  var missing = [];
  if (typeof w.Worker === 'undefined') missing.push('Worker');
  if (typeof w.OffscreenCanvas === 'undefined') missing.push('OffscreenCanvas');
  if (typeof w.createImageBitmap === 'undefined') missing.push('createImageBitmap');
  if (typeof w.WebAssembly === 'undefined') missing.push('WebAssembly');
  return {ok:missing.length === 0, missing:missing,
    reason:missing.length ? 'detector cannot run here: ' + missing.join(', ') + ' unavailable' : ''};
}
export {readFaceSelection, readFaceWiring};
