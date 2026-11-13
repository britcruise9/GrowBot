/* parts.js, 1104. THE PARTS CONTRACT, gb-parts/1: extra servos that the creature moves by name.
   The human version is CONTRACT-PARTS.md beside this file. Pinned by test/harness/partstest.js.

   WHY ONE FILE. The same record has to give the same prompt line, the same reply check and the same wire
   frames on a Pico GrowBot (the arm lane, firmware/arm/arm_body.py), on the Pi kits and on the public
   agent-harness. Three hand copies of these rules would drift, so this file is the rules, copied
   byte-identical (md5) wherever they run.

   ZERO SETUP FIRST. A robot with the arm lane already says what is plugged in when asked ({t:"arm",q:1}:
   names, min, max, rest, hold_s). fromQ() turns that answer into a record with no setup at all: each part
   by its name, moved anywhere between its two limits as 0..1. A record the person measured on /bodies
   (named ends like open/closed, taught moves) is an OPTIONAL upgrade, and choose() prefers it only when it
   still matches the robot.

   WHY ENDS AND NOT DEGREES OR SIGNS. A part has two ends in raw degrees, a and b. The order carries the
   direction, so there is no sign to get wrong, and a move is a fraction f between the ends: a + f * (b - a).
   Measured ends also carry the person's words for them ("left", "open"). This is the tank kit's shipped
   model (tank_body.py POSES, tank_check.py marks), made generic. The chip's own DEFAULT_POSES are offsets
   from a neutral with no direction (arm_body.py:63-74), so nothing here ever sends {t:"arm",pose}.

   A MOVE HOLDS. Frames end at the move's pose and hold it there: the app keeps the lease alive (keepalive(),
   at most every KEEP_MS) for at most HOLD_MAX_MS after the last part move, then sends ending(). No hold is
   ever longer than a powered part's own hold_s on the chip, less a second (holdMs()). ending() rests only
   the parts nobody needs to ask about: a grip-like part, or one whose own hold_s is under 66 s, is only let go.

   ES2018 floor, written ES5-style (var, function): the iPhone 6 law, one ?? parse-killed a tester tab. No
   dependencies. module.exports in node, window.GBParts in a page. Nothing here throws on bad input: every
   check answers {ok, why}. */
(function (root) {
  'use strict';
  var FORMAT = 'gb-parts/1';
  var MAX_PARTS = 8;            // arm_body.py MAX_JOINTS: the CSV on the wire is one field per chip joint
  var MAX_MOVES = 24;           // arm.html keeps 24 pose names at most
  var MAX_KEYFRAMES = 16;       // arm_body.py clean_poses keeps 16 keyframes at most
  var LINE_MAX = 400;           // the prompt line's hard cap: past it, trailing moves drop, never parts
  var MOVE_MAX_MS = 10000;      // reaching a move's pose (every keyframe but the last one's hold) takes no longer
  var END_HOLD_MS = 3000;       // a part that cannot hold a pose this long is never moved (short_hold)
  var HOLD_MAX_MS = 60000;      // the app holds a pose at most this long after the last part move, then rest()
  var KEEP_MS = 10000;          // and sends keepalive() whenever this long passes with no other arm frame
  var SETTLE_MS = 500;          // at rest, this long before the let go, so it is still when it goes limp
  var WAKE_MS = 400;            // arm_body.py WAKE_MS: limp joints wake one at a time, this far apart
  var SLACK_MS = 1000;          // a hold stays this far under a timer that would let a part go: the relay round
                                // trip before the next frame lands, and the q answer's whole seconds (rounded)
  var END_MS = 5000;            // the hold's end is a q, its answer, then the rest: two relay round trips on a weak
                                // link, all before the robot's idle runs out (idle_s 65 at least)
  var MIN_SPAN = 5;             // tank_check.py MIN_SPAN: ends closer than this are refused
  var CHIP_KEYS = ['n', 'names', 'min', 'max', 'rest', 'dps', 'hold_s'];   // the q answer fields a record pins
  var KINDS = { servo_pos: true, servo_cont: false, dc_motor: false };   // true = can move today; the others are reserved
  var CAPS = { pose: true, to: true };   // pose: named moves. to: {part: 0..1 or an end word}
  var SOCKETS = [2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15];   // Waveshare: 0/1 legs, 8/9 I2C, the rest servo sockets
  var SETUP = { min: 40, max: 140, mid: 90, dps: 30, hold_s: 5, idle_s: 120, lease_s: 15 };
  // a part the robot names like this can pinch: only when the person asks (Brit's list, and other pinching words)
  var GRIP_RE = /grip|claw|hand|jaw|pinc|pinz|finger|grab|grasp|effector|plier|tweez|talon|mouth|beak|tong|clamp|bite|teeth|nip/;
  // Plain words only: the record is the person's (or the robot's) text and it lands in the prompt, so it can
  // never carry quotes, newlines, "==" headers or anything but a short name.
  var ID_RE = /^[a-z][a-z0-9_]{0,11}$/;
  var MOVE_RE = /^[a-z][a-z0-9_]{0,15}$/;
  var END_RE = /^[a-z](?:[a-z -]{0,10}[a-z])?$/;
  var ROLE_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9 '-]{0,38}[A-Za-z0-9])?)?$/;
  var ROBOT_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function no(why) { return { ok: false, why: why }; }
  function yes() { return { ok: true, why: '' }; }
  function clip(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function half(v) { return Math.floor(v + 0.5); }   // round half up, the same on every runtime (Python round() is not)

  // ---------- the chip snapshot: the exact q answer the record was made from ----------
  function ints(s, n) {
    if (typeof s !== 'string') return null;
    var p = s.split(','), out = [];
    if (p.length !== n) return null;
    for (var i = 0; i < n; i++) { if (!/^-?\d{1,4}$/.test(p[i])) return null; out.push(+p[i]); }
    return out;
  }
  function chipOf(c) {
    if (!isObj(c) || !isInt(c.n) || c.n < 1 || c.n > MAX_PARTS || typeof c.names !== 'string') return null;
    var n = c.n, names = c.names.split(',');
    if (names.length !== n || names.some(function (x) { return !x; })) return null;
    var k = { n: n, names: names, min: ints(c.min, n), max: ints(c.max, n), rest: ints(c.rest, n), dps: ints(c.dps, n), hold: ints(c.hold_s, n) };
    if (!k.min || !k.max || !k.rest || !k.dps || !k.hold) return null;
    for (var i = 0; i < n; i++) {
      if (!(k.min[i] >= 0 && k.min[i] < k.max[i] && k.max[i] <= 180)) return null;
      if (k.rest[i] < k.min[i] || k.rest[i] > k.max[i]) return null;
      if (k.dps[i] < 1 || k.dps[i] > 360 || k.hold[i] < 0 || k.hold[i] > 3600) return null;
    }
    return k;
  }

  // ---------- validate: the record's own shape. Arming (status, brain, the q match) is armed() ----------
  function check(r) {
    if (!isObj(r)) return { why: 'not_a_record' };
    if (r.format !== FORMAT) return { why: 'format' };
    if (typeof r.robot !== 'string' || !ROBOT_RE.test(r.robot)) return { why: 'robot' };
    if (r.source !== undefined && r.source !== 'measured' && r.source !== 'robot') return { why: 'source' };
    var robot = r.source === 'robot';   // made by fromQ from the robot's own answer: nobody measured it
    if ((r.status !== 'MEASURED' && r.status !== 'UNMEASURED') || (robot && r.status !== 'UNMEASURED')) return { why: 'status' };
    if (typeof r.brain !== 'boolean') return { why: 'brain' };
    if (r.at !== undefined && typeof r.at !== 'string') return { why: 'at' };
    if (!Array.isArray(r.caps) || !r.caps.length || r.caps.some(function (x, i) { return !own(CAPS, x) || r.caps.indexOf(x) !== i; }) ||
        (robot && (r.caps.length !== 1 || r.caps[0] !== 'to'))) return { why: 'caps' };
    var c = chipOf(r.chip);
    if (!c) return { why: 'chip' };
    if (!Array.isArray(r.parts) || r.parts.length < 1 || r.parts.length > c.n || (robot && r.parts.length !== c.n)) return { why: 'parts' };
    var byId = {}, usedJ = {};
    for (var i = 0; i < r.parts.length; i++) {
      var p = r.parts[i];
      if (!isObj(p)) return { why: 'part:' + i };
      if (typeof p.id !== 'string' || !ID_RE.test(p.id)) return { why: 'part_id:' + i };
      if (own(byId, p.id)) return { why: 'part_dup:' + p.id };
      if (typeof p.role !== 'string' || !ROLE_RE.test(p.role)) return { why: 'part_role:' + p.id };
      if (typeof p.kind !== 'string' || !own(KINDS, p.kind) || (robot && p.kind !== 'servo_pos')) return { why: 'part_kind:' + p.id };
      if (!isInt(p.j) || p.j < 0 || p.j >= c.n || own(usedJ, p.j) || (robot && p.j !== i)) return { why: 'part_j:' + p.id };
      if (KINDS[p.kind]) {   // servo_pos: the end fields. A reserved kind carries only id, role, kind and j for now
        if (!isInt(p.a) || !isInt(p.b) || p.a < 0 || p.a > 180 || p.b < 0 || p.b > 180) return { why: 'part_ab:' + p.id };
        if (robot && (p.a !== c.min[p.j] || p.b !== c.max[p.j])) return { why: 'part_ab:' + p.id };   // the robot's own limits
        if (Math.abs(p.a - p.b) < MIN_SPAN) return { why: 'part_span:' + p.id };
        var lo = Math.min(p.a, p.b), hi = Math.max(p.a, p.b);
        if (lo < c.min[p.j] || hi > c.max[p.j]) return { why: 'part_outside_chip:' + p.id };
        if (!isInt(p.rest) || p.rest < lo || p.rest > hi || (robot && p.rest !== c.rest[p.j])) return { why: 'part_rest:' + p.id };
        if (!Array.isArray(p.ends) || (robot ? p.ends.length !== 0 : p.ends.length !== 2 || typeof p.ends[0] !== 'string' || typeof p.ends[1] !== 'string' ||
            !END_RE.test(p.ends[0]) || !END_RE.test(p.ends[1]) || p.ends[0] === p.ends[1])) return { why: 'part_ends:' + p.id };   // robot: unnamed, []
        if (typeof p.ask !== 'boolean') return { why: 'part_ask:' + p.id };
        if (p.hold_s !== undefined && !(isInt(p.hold_s) && p.hold_s >= 1 && p.hold_s <= 3600)) return { why: 'part_hold_s:' + p.id };
      }
      byId[p.id] = p;
      usedJ[p.j] = true;
    }
    if (!isObj(r.poses)) return { why: 'poses' };
    var names = Object.keys(r.poses);
    if (names.length && r.caps.indexOf('pose') < 0) return { why: 'caps' };   // moves need the pose cap
    if (names.length > MAX_MOVES) return { why: 'poses_too_many' };
    for (var m = 0; m < names.length; m++) {
      var name = names[m], kf = r.poses[name];
      if (!MOVE_RE.test(name) || name === 'rest') return { why: 'pose_name:' + name };
      if (!Array.isArray(kf) || kf.length < 1 || kf.length > MAX_KEYFRAMES) return { why: 'pose_frames:' + name };
      for (var f = 0; f < kf.length; f++) {
        var fr = kf[f];
        if (!Array.isArray(fr) || fr.length !== 2 || !isObj(fr[0]) || !Object.keys(fr[0]).length) return { why: 'pose_frames:' + name };
        if (!isInt(fr[1]) || fr[1] < 0 || fr[1] > MOVE_MAX_MS) return { why: 'pose_hold:' + name };
        var ids = Object.keys(fr[0]);
        for (var q = 0; q < ids.length; q++) {
          if (!own(byId, ids[q])) return { why: 'pose_part:' + name };
          var v = fr[0][ids[q]];
          if (!isNum(v) || v < 0 || v > 1) return { why: 'pose_f:' + name };
        }
      }
    }
    var k = { r: r, c: c, byId: byId, robot: robot, to: r.caps.indexOf('to') >= 0, why: '' };
    var offer = offered(k);
    if ((offer.length || (k.to && movable(k).length)) && !lineOf(k, offer.slice(0, 1))) return { why: 'line_too_long' };   // the parts alone must fit
    return k;
  }
  function validate(r) { var k = check(r); return k.why ? no(k.why) : yes(); }

  // ---------- fromQ: ZERO SETUP. The robot's own q answer as a record: parts by name, 0..1 between limits ----------
  function idOf(name, j, used) {   // the robot's name as a plain id, else part<N>; null if even that is taken
    var s = name.toLowerCase().replace(/^\s+|\s+$/g, '').replace(/[\s-]+/g, '_');
    if (!ID_RE.test(s) || own(used, s)) s = 'part' + (j + 1);
    return own(used, s) ? null : s;
  }
  function fromQ(q, robot) {
    if (typeof robot !== 'string' || !ROBOT_RE.test(robot)) return { ok: false, record: null, why: 'robot' };
    if (!isObj(q)) return { ok: false, record: null, why: 'no_answer' };
    if (own(q, 'ok') && q.ok !== 1) return { ok: false, record: null, why: 'q_refused' };
    var c = chipOf(q);
    if (!c) return { ok: false, record: null, why: 'chip' };
    var used = {}, parts = [];
    for (var j = 0; j < c.n; j++) {
      var id = idOf(c.names[j], j, used);
      if (!id) return { ok: false, record: null, why: 'names' };
      used[id] = true;
      var p = { id: id, role: '', kind: 'servo_pos', j: j, a: c.min[j], b: c.max[j], ends: [], rest: c.rest[j],
                ask: GRIP_RE.test(c.names[j].toLowerCase()) };
      if (c.hold[j]) p.hold_s = c.hold[j];
      parts.push(p);
    }
    var chip = {};
    CHIP_KEYS.forEach(function (key) { chip[key] = q[key]; });
    var rec = { format: FORMAT, robot: robot, source: 'robot', status: 'UNMEASURED', brain: true, chip: chip, parts: parts, poses: {}, caps: ['to'] };
    var v = validate(rec);
    return v.ok ? { ok: true, record: rec, why: '' } : { ok: false, record: null, why: 'robot_' + v.why };
  }

  // ---------- match: the robot's q answer against the snapshot, field for field ----------
  function match(r, qReply) {
    var k = check(r);
    if (k.why) return no('record_' + k.why);
    if (!isObj(qReply)) return no('no_answer');
    if (own(qReply, 'ok') && qReply.ok !== 1) return no('q_refused');
    for (var i = 0; i < CHIP_KEYS.length; i++) {
      var key = CHIP_KEYS[i];
      if (r.chip[key] !== qReply[key]) return no('chip_' + key);
    }
    return yes();
  }

  // ---------- armed: every rule before the creature sees one byte. Otherwise 0 bytes and 0 frames ----------
  function armed(r, qReply, robot) {
    if (r === null || r === undefined) return no('no_record');
    var k = check(r);
    if (k.why) return no('record_' + k.why);
    if (typeof robot !== 'string') return no('no_robot');   // always passed: the gb- id, or a Pi kit's id
    if (r.robot !== robot) return no('other_robot');
    if (!k.robot && r.status !== 'MEASURED') return no('unmeasured');   // a measured record arms only when measured
    if (r.brain !== true) return no('brain_off');
    var m = match(r, qReply);
    if (!m.ok) return m;
    // The app holds a pose up to 60 s and renews the lease at most 10 s apart, so the chip's own idle and lease
    // timers must outlast both (or a part goes limp mid-hold and the next frame wakes it where it sagged)
    if (!isNum(qReply.idle_s) || qReply.idle_s * 1000 < HOLD_MAX_MS + END_MS) return no('idle_short');
    if (!isNum(qReply.lease_s) || qReply.lease_s * 1000 < KEEP_MS + SLACK_MS) return no('lease_short');
    if (!offered(k).length && !(k.to && movable(k).length)) return no('no_moves');
    return yes();
  }

  // ---------- choose: the measured record when it still fits this robot, else zero setup ----------
  function choose(saved, qReply, robot) {
    var d = fromQ(qReply, robot);
    if (!d.ok) return { ok: false, record: null, why: d.why };
    if (saved === null || saved === undefined) return { ok: true, record: d.record, why: 'no_record' };
    var k = check(saved);
    if (!k.why && !k.robot && saved.robot === robot && saved.brain === false) return { ok: false, record: null, why: 'brain_off' };   // the person said no
    var a = k.robot ? no('saved_from_robot') : armed(saved, qReply, robot);
    return a.ok ? { ok: true, record: saved, why: '' } : { ok: true, record: d.record, why: a.why };
  }

  // ---------- angles and frames ----------
  function angleOf(k, p, f) {   // clamped inside the ends, which validate keeps inside the chip's own clamp
    return clip(half(p.a + clip(f, 0, 1) * (p.b - p.a)), Math.min(p.a, p.b), Math.max(p.a, p.b));
  }
  function angle(r, id, f) {
    var k = check(r);
    if (k.why || !own(k.byId, id) || !KINDS[k.byId[id].kind] || !isNum(f)) return null;
    return angleOf(k, k.byId[id], f);
  }
  function csv(k, degs) {   // {j: deg} -> "d1,,d3": one field per chip joint, in q names order, blank = leave alone
    var out = [];
    for (var j = 0; j < k.c.n; j++) out.push(own(degs, j) ? String(degs[j]) : '');
    return out.join(',');
  }
  function fracs(k, move, strict) {   // {id: 0..1 or an end word} -> {id: f} in record order, or null
    var ids = Object.keys(move), f = {}, out = {};
    if (!ids.length) return null;
    for (var i = 0; i < ids.length; i++) {
      var p = own(k.byId, ids[i]) ? k.byId[ids[i]] : null, v = move[ids[i]];
      var end = p && typeof v === 'string' ? p.ends.indexOf(v.trim().toLowerCase()) : -1;
      if (!p || !KINDS[p.kind]) return null;
      if (isNum(v) && (!strict || (v >= 0 && v <= 1))) f[p.id] = v;   // not strict (resolve): angleOf clamps it
      else if (end >= 0) f[p.id] = end;
      else return null;
    }
    k.r.parts.forEach(function (x) { if (own(f, x.id)) out[x.id] = f[x.id]; });
    return out;
  }
  function keysOf(k, move) {   // a move -> its keyframes [[{id: f}, hold_ms]]: a named move, or one {id: f}
    if (typeof move === 'string') return move !== 'rest' && own(k.r.poses, move) ? k.r.poses[move] : null;
    var f = isObj(move) ? fracs(k, move, false) : null;   // clamped: a value past an end is that end
    return f ? [[f, 0]] : null;
  }
  function touchedBy(k, kf) {   // part ids the keyframes move, in record order
    var seen = Object.create(null);   // a part may be named "constructor": nothing inherited counts as touched
    kf.forEach(function (fr) { Object.keys(fr[0]).forEach(function (id) { seen[id] = true; }); });
    return k.r.parts.filter(function (p) { return seen[p.id]; }).map(function (p) { return p.id; });
  }
  function movable(k) {   // the parts the creature may move by the "to" cap, in record order
    return k.r.parts.filter(function (p) { return KINDS[p.kind] && holdCap(k, p.id) >= END_HOLD_MS; });
  }

  // ms the move takes on the chip, from every part limp at its own rest: the same model as arm_body.py's
  // queued_ms (a limp joint waits its turn to wake, WAKE_MS apart, then slews at its dps), plus each hold.
  // Only for the 10 s cap: the app times each frame by the chip's own ack (queued_ms), not by this.
  function reaches(k, frames) {   // ms each frame takes to reach its pose (0 for the let go), in order
    var n = k.c.n, pos = k.c.rest.slice(), on = [], out = [];
    k.r.parts.forEach(function (p) { if (KINDS[p.kind]) pos[p.j] = p.rest; });
    for (var i = 0; i < frames.length; i++) {
      var fr = frames[i], t = fr.stop ? [] : fr.a.split(','), ms = 0, woke = 0;
      for (var j = 0; j < n; j++) {
        if (t[j] === undefined || t[j] === '') continue;
        var to = clip(+t[j], k.c.min[j], k.c.max[j]), wait = 0;
        if (!on[j]) { wait = woke * WAKE_MS; woke++; on[j] = true; }
        ms = Math.max(ms, wait + Math.abs(to - pos[j]) * 1000 / k.c.dps[j]);
        pos[j] = to;
      }
      out.push(ms);
    }
    return out;
  }
  function estimateOf(k, frames) {
    var r = reaches(k, frames), total = 0;
    frames.forEach(function (fr, i) { total += r[i] + (fr.hold_ms || 0); });
    return half(total);
  }
  function estimate(r, frames) {
    var k = check(r);
    if (k.why || !Array.isArray(frames)) return null;
    return estimateOf(k, frames);
  }

  // The chip's hold_s lets a joint go once the arm is still that long (arm_body.py), and the next frame then
  // wakes it where it was before it sagged: a drop, then a snap. So no hold outlasts hold_s minus SLACK_MS for
  // any part powered by then, and a part whose hold_s cannot cover END_HOLD_MS is never moved (short_hold).
  function holdCap(k, id) { var h = k.c.hold[k.byId[id].j]; return h ? h * 1000 - SLACK_MS : HOLD_MAX_MS; }
  function shortHold(k, ids) { return ids.some(function (id) { return holdCap(k, id) < END_HOLD_MS; }); }
  function powered(k, ctx) {   // ctx.powered: ids still holding from an earlier move (their hold_s counts too)
    var list = ctx && Array.isArray(ctx.powered) ? ctx.powered : [];
    return list.filter(function (id) { return typeof id === 'string' && own(k.byId, id) && KINDS[k.byId[id].kind]; });
  }

  // rest: the parts back to their rest, a moment still, then let go. ids: which parts (default every one
  // that can move). With none to rest it is only the let go.
  function restOf(k, ids) {
    var degs = {};
    k.r.parts.forEach(function (p) { if (KINDS[p.kind] && (!ids || ids.indexOf(p.id) >= 0)) degs[p.j] = p.rest; });
    return (Object.keys(degs).length ? [{ a: csv(k, degs), hold_ms: SETTLE_MS }] : []).concat([{ stop: 1 }]);
  }
  function rest(r, ids) {
    var k = check(r);
    if (k.why || (ids !== undefined && !Array.isArray(ids))) return null;
    return restOf(k, ids);
  }
  // ending: the end of a hold, for the parts the robot still holds (ids). Each goes back to its rest, a moment
  // still, then the let go, except a grip-like part (ask) or one whose own hold_s is under 66 s, which is only let
  // go: nobody asked it to move (a claw's rest can be on its closed side), and the robot's own hold_s may let it go
  // just before the rest lands, which would wake it to snap back where it was. A longer hold_s outlasts the hold's
  // end (HOLD_MAX_MS plus END_MS), so that part rests like any other.
  function ending(r, ids) {
    var k = check(r);
    if (k.why || !Array.isArray(ids)) return null;
    return restOf(k, ids.filter(function (id) { return typeof id === 'string' && own(k.byId, id) && !k.byId[id].ask &&
      (!k.c.hold[k.byId[id].j] || holdCap(k, id) >= HOLD_MAX_MS + END_MS); }));
  }
  // holdMs: the longest the app may hold a part once it got there (HOLD_MAX_MS, or its hold_s less SLACK_MS),
  // whatever moves after it. null = no such part, or a kind that never moves.
  function holdMs(r, id) {
    var k = check(r);
    return k.why || typeof id !== 'string' || !own(k.byId, id) || !KINDS[k.byId[id].kind] ? null : Math.min(holdCap(k, id), HOLD_MAX_MS);
  }
  function keepalive(r) { return check(r).why ? null : { t: 'arm', q: 1 }; }   // the whole frame: no rid, no reply

  // A move -> its frames, each {a, hold_ms}, ending at the move's pose. The last hold_ms is the longest the app
  // may hold it (HOLD_MAX_MS, or less for a part with hold_s); the app then sends ending(). Reaching the pose
  // takes 10 s at most: past that, trailing keyframes drop. null = no such move, a reserved kind, a part that
  // lets go too soon (short_hold), or too slow to reach even one keyframe in 10 s. "rest" is rest().
  function planOf(k, move, ctx) {
    var held = powered(k, ctx);
    if (move === 'rest') return restOf(k, ctx && Array.isArray(ctx.powered) ? held : null);
    var kf = keysOf(k, move);
    if (!kf) return null;
    var ids = touchedBy(k, kf);
    if (!ids.length || ids.some(function (id) { return !KINDS[k.byId[id].kind]; }) || shortHold(k, ids)) return null;
    var keys = kf.map(function (fr) {
      var degs = {};
      Object.keys(fr[0]).forEach(function (id) { var p = k.byId[id]; degs[p.j] = angleOf(k, p, fr[0][id]); });
      return { degs: degs, ids: Object.keys(fr[0]), hold_ms: fr[1] };
    });
    function build(list) {
      var cap = HOLD_MAX_MS;
      held.forEach(function (id) { cap = Math.min(cap, holdCap(k, id)); });
      var out = list.map(function (x, i) {
        x.ids.forEach(function (id) { cap = Math.min(cap, holdCap(k, id)); });   // powered from here on
        return { a: csv(k, x.degs), hold_ms: i === list.length - 1 ? cap : Math.min(x.hold_ms, cap) };
      });
      // arm_body.py keeps a still clock per joint (1104): a part with hold_s counts from the keyframe that last
      // moved it, so the last hold also stays under its cap less every hold and reach since that keyframe
      var r = reaches(k, out), last = out.length - 1, since = 0, seen = Object.create(null);
      for (var i = last; i >= 0; i--) {
        if (i < last) since += out[i].hold_ms + r[i + 1];
        list[i].ids.forEach(function (id) {
          if (!seen[id] && k.c.hold[k.byId[id].j]) out[last].hold_ms = Math.max(0, Math.min(out[last].hold_ms, holdCap(k, id) - half(since)));
          seen[id] = true;
        });
      }
      return out;
    }
    function reach(frames) { return estimateOf(k, frames) - frames[frames.length - 1].hold_ms; }
    var keep = keys.slice(), frames = build(keep);
    while (keep.length > 1 && reach(frames) > MOVE_MAX_MS) { keep.pop(); frames = build(keep); }
    return reach(frames) > MOVE_MAX_MS ? null : frames;
  }
  function resolve(r, move, ctx) {
    var k = check(r);
    return k.why ? null : planOf(k, move, ctx);
  }

  // ---------- the prompt line ----------
  function offered(k) {   // the named moves the creature is told about, in record order. "rest" is never offered
    return Object.keys(k.r.poses).filter(function (name) { return !!planOf(k, name); });
  }
  function asks(k, name) { return touchedBy(k, k.r.poses[name]).some(function (id) { return k.byId[id].ask === true; }); }
  function quoted(list) { return list.map(function (m) { return '"' + m + '"'; }).join('|'); }
  var TAIL = ' Only when it means something, never with a leg move.';
  function robotLine(k) {   // zero setup: names only, 0..1, as small as it can be
    var ps = movable(k), free = ps.filter(function (p) { return !p.ask; }), asked = ps.filter(function (p) { return p.ask; });
    if (!ps.length) return '';
    function ids(list) { return list.map(function (p) { return p.id; }).join(', '); }
    var who = (free.length ? ids(free) + '.' : '') + (asked.length ? (free.length ? ' ' : '') + 'Only when your person asks: ' + ids(asked) + '.' : '');
    return '\n== YOUR PARTS ==\n' + who + '\n"parts":{"' + (free[0] || asked[0]).id + '":0.5} moves a part between its ends (0 to 1) and holds.' + TAIL;
  }
  function lineOf(k, moves) {
    var s;
    if (k.robot) s = robotLine(k);
    else {
      var ps = movable(k), ex = ps.filter(function (p) { return !p.ask; })[0] || ps[0], to = k.to && !!ex;
      if (!moves.length && !to) return '';
      var desc = k.r.parts.filter(function (p) { return KINDS[p.kind]; }).map(function (p) {
        var role = p.role && p.role.toLowerCase().indexOf(p.id) !== 0 ? ' (' + p.role + ')' : '';   // a role adds bytes only when the id does not already say it
        return p.id + role + ': ' + p.ends[0] + '..' + p.ends[1] + (to && p.ask ? ', only when your person asks' : '') + '.';
      }).join(' ');
      var free = moves.filter(function (m) { return !asks(k, m); }), asked = moves.filter(function (m) { return asks(k, m); });
      var verb = 'parts:' + quoted(free) + (asked.length ? (free.length ? ' or, ' : ' ') + 'only when your person asks, ' + quoted(asked) : '');
      if (to) verb = (moves.length ? verb + ', or ' : 'parts:') + '{"' + ex.id + '":"' + ex.ends[0] + '"}: an end word or 0 to 1';
      s = '\n== YOUR PARTS (your person measured them) ==\n' + desc + '\n' + verb + '. It holds, then rests.' + TAIL;
    }
    return s.length <= LINE_MAX ? s : '';
  }
  function line(r) {
    var k = check(r);
    if (k.why) return '';
    var moves = offered(k);
    while (moves.length && !lineOf(k, moves)) moves.pop();   // past 400 chars: trailing moves drop, never parts
    return lineOf(k, moves);
  }

  // ---------- the reply: {"parts":"<move name>"} or {"parts":{"<part>":0..1 or an end word}} ----------
  // ctx.personTurn: this turn came from the person's own words. ctx.bodyMove: the same reply also moves the
  // body (body, gesture, walk or track). One mover per turn, and the legs win. move comes back normalized:
  // the name, or {id: f} in record order with each end word as 0 or 1.
  function parseMove(value, r, ctx) {
    ctx = ctx || {};
    var k = check(r);
    if (k.why) return { ok: false, move: null, why: 'record_' + k.why };
    var move, ids;
    if (typeof value === 'string') {
      move = value.trim().toLowerCase();
      if (!move) return { ok: false, move: null, why: 'empty' };
      if (ctx.bodyMove) return { ok: false, move: null, why: 'one_mover' };
      if (move !== 'rest' && !own(r.poses, move)) return { ok: false, move: null, why: 'unknown_move' };
      ids = move === 'rest' ? r.parts.filter(function (p) { return KINDS[p.kind]; }).map(function (p) { return p.id; }) : touchedBy(k, r.poses[move]);
    } else if (isObj(value) && k.to) {
      var keys = Object.keys(value);
      if (!keys.length) return { ok: false, move: null, why: 'empty' };
      if (ctx.bodyMove) return { ok: false, move: null, why: 'one_mover' };
      for (var i = 0; i < keys.length; i++) {
        if (!own(k.byId, keys[i])) return { ok: false, move: null, why: 'unknown_part' };
        if (!KINDS[k.byId[keys[i]].kind]) return { ok: false, move: null, why: 'kind' };
      }
      move = fracs(k, value, true);   // strict: a number outside 0..1, or a word that is not one of its ends
      if (!move) return { ok: false, move: null, why: 'bad_value' };
      ids = Object.keys(move);
    } else return { ok: false, move: null, why: 'not_a_name' };
    if (ids.some(function (id) { return !KINDS[k.byId[id].kind]; })) return { ok: false, move: null, why: 'kind' };
    if (move !== 'rest' && shortHold(k, ids)) return { ok: false, move: null, why: 'short_hold' };
    if (ctx.personTurn !== true && ids.some(function (id) { return k.byId[id].ask === true; })) return { ok: false, move: null, why: 'ask_first' };
    if (!planOf(k, move)) return { ok: false, move: null, why: 'too_long' };
    return { ok: true, move: move, why: '' };
  }

  // ---------- arm_config.py for today's arm_body.py (travel-1026), from the Set up page's cards ----------
  // cards, in joint order (keep the setup order when locking: the record's j is that order):
  //   {id, socket, a?, b?, rest?, hold_s?, dps?}. "setup": a cautious window to measure in, every part at
  //   90. "final" (Lock limits): each joint's min/max become the measured ends, so the chip itself refuses to
  //   go past them. After a final copy the q answer changes: the page asks again and saves the new snapshot.
  function toArmConfig(cards, mode) {
    if (mode !== 'setup' && mode !== 'final') return { ok: false, text: '', why: 'mode' };
    if (!Array.isArray(cards) || cards.length < 1 || cards.length > MAX_PARTS) return { ok: false, text: '', why: 'cards' };
    var ids = {}, socks = {}, rows = [], slew = SETUP.dps;
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (!isObj(c) || typeof c.id !== 'string' || !ID_RE.test(c.id) || own(ids, c.id)) return { ok: false, text: '', why: 'card_id:' + i };
      if (!isInt(c.socket) || SOCKETS.indexOf(c.socket) < 0 || own(socks, c.socket)) return { ok: false, text: '', why: 'card_socket:' + c.id };
      ids[c.id] = socks[c.socket] = true;
      var row = '{"name": "' + c.id + '", "socket": ' + c.socket;
      if (mode === 'setup') {
        row += ', "min": ' + SETUP.min + ', "max": ' + SETUP.max + ', "neutral": ' + SETUP.mid + ', "rest": ' + SETUP.mid + ', "hold_s": ' + SETUP.hold_s;
      } else {
        if (!isInt(c.a) || !isInt(c.b) || c.a < 0 || c.a > 180 || c.b < 0 || c.b > 180 || Math.abs(c.a - c.b) < MIN_SPAN) return { ok: false, text: '', why: 'card_ends:' + c.id };
        var lo = Math.min(c.a, c.b), hi = Math.max(c.a, c.b);
        if (!isInt(c.rest) || c.rest < lo || c.rest > hi) return { ok: false, text: '', why: 'card_rest:' + c.id };
        row += ', "min": ' + lo + ', "max": ' + hi + ', "neutral": ' + half((lo + hi) / 2) + ', "rest": ' + c.rest;
        if (c.dps !== undefined) {
          if (!isInt(c.dps) || c.dps < 1 || c.dps > 360) return { ok: false, text: '', why: 'card_dps:' + c.id };
          row += ', "dps": ' + c.dps;
        }
        if (c.hold_s !== undefined) {
          if (!isInt(c.hold_s) || c.hold_s < 1 || c.hold_s > 3600) return { ok: false, text: '', why: 'card_hold_s:' + c.id };
          row += ', "hold_s": ' + c.hold_s;
        }
      }
      rows.push('    ' + row + '},');
    }
    var head = mode === 'setup' ? [
      '# arm_config.py for the parts lane (gb-parts/1), made by growbot.dev/bodies. SETUP: read by arm_body.py at',
      '# power-on. Every part starts at 90 (its middle), moves slowly inside 40 to 140 and lets go after 5 s',
      '# still. Attach each horn after the robot has centred its servo, so the part sits mid-travel.'
    ] : [
      '# arm_config.py for the parts lane (gb-parts/1), made by growbot.dev/bodies. LOCKED: read by arm_body.py at',
      '# power-on. Each part\'s min and max are the two ends you measured, so the robot itself never goes past',
      '# them, whatever any page sends. rest is the rest you tested.'
    ];
    var text = head.concat([
      'JOINTS = ['
    ], rows, [
      ']',
      '',
      'SLEW_DPS = ' + slew + '   # top speed of every part, degrees per second',
      'IDLE_S = ' + SETUP.idle_s + '    # holding still this long with no new command, every part goes limp',
      'LEASE_S = ' + SETUP.lease_s + '    # no word from any page this long, every part goes limp',
      'POSES = {}      # no built-in poses: GrowBot moves parts between their measured ends, never by offsets',
      ''
    ]).join('\n');
    return { ok: true, text: text, why: '' };
  }

  // ---------- fromTank: the RaspTank kit's arm (tank/body.v0.json) as a gb-parts/1 record ----------
  // The tank already uses this model. Its poses live in tank_body.py:145-152 (copied below, pinned by the
  // harness against the shipped zip). Its "chip" is the tank body's own clamp: the measured ends, its
  // slew_dps, and grip_hold_s on the grip. The Pi side (S6) answers these same q fields.
  var TANK_JOINTS = ['lift', 'hand', 'turn', 'grip', 'tilt'];
  var TANK_ENDS = { lift: ['down', 'up'], hand: ['down', 'up'], turn: ['left', 'right'], grip: ['closed', 'open'], tilt: ['down', 'up'] };
  var TANK_ROLES = { lift: 'lift', hand: 'hand', turn: 'turn', grip: 'grip', tilt: 'camera tilt' };
  var TANK_POSES = [   // tank_body.py POSES in its POSE_NAMES order ("rest" is every gb-parts/1 record's own)
    ['wave', [[{ lift: 1.0, hand: 0.8 }, 200], [{ hand: 0.4 }, 0], [{ hand: 0.9 }, 0], [{ hand: 0.4 }, 0], [{ hand: 0.9 }, 0], [{ hand: 0.7 }, 0]]],
    ['point', [[{ lift: 0.6, hand: 0.9, turn: 0.5 }, 1500]]],
    ['up', [[{ lift: 1.0, hand: 0.7 }, 0]]],
    ['grab', [[{ grip: 1.0 }, 800], [{ lift: 0.3, hand: 0.3 }, 600], [{ grip: 0.0 }, 600], [{ lift: 0.7 }, 0]]],
    ['grab_open', [[{ grip: 1.0 }, 0]]],
    ['grab_closed', [[{ grip: 0.0 }, 0]]]
  ];
  function tankEnds(name, s) {
    // "a down, b up", "a closed (the fingers just meet), b open" (tank_check.py writes that one), else the defaults
    var m = /^a\s+([a-z][a-z -]*?)\s*(?:\([^)]*\))?\s*,\s*b\s+([a-z][a-z -]*?)\s*(?:\(|$)/.exec(typeof s === 'string' ? s.trim() : '');
    return m ? [m[1], m[2]] : TANK_ENDS[name].slice();
  }
  function fromTank(doc) {
    var arm = isObj(doc) ? doc.arm : null;
    if (!isObj(arm) || !Array.isArray(arm.joints) || arm.joints.length < 1 || arm.joints.length > 5) return { ok: false, record: null, why: 'tank_no_arm' };
    var js = [];
    for (var i = 0; i < arm.joints.length; i++) {
      var j = arm.joints[i];
      if (!isObj(j) || TANK_JOINTS.indexOf(j.name) < 0 || js.some(function (x) { return x.name === j.name; })) return { ok: false, record: null, why: 'tank_joint:' + i };
      js.push(j);
    }
    js.sort(function (x, y) { return TANK_JOINTS.indexOf(x.name) - TANK_JOINTS.indexOf(y.name); });   // tank_body.py sorts them so
    var dps = isNum(arm.slew_dps) ? half(arm.slew_dps) : 60, grip = isNum(arm.grip_hold_s) ? half(arm.grip_hold_s) : 10;
    var parts = [], lo = [], hi = [], rests = [];
    js.forEach(function (x, n) {
      parts.push({ id: x.name, role: TANK_ROLES[x.name], kind: 'servo_pos', j: n, a: x.a, b: x.b, ends: tankEnds(x.name, x._ends),
                   rest: isNum(x.rest) ? half(x.rest) : x.rest, ask: x.name === 'grip' });
      lo.push(Math.min(x.a, x.b)); hi.push(Math.max(x.a, x.b)); rests.push(isNum(x.rest) ? half(x.rest) : x.rest);
    });
    var poses = {};
    TANK_POSES.forEach(function (p) {
      var kf = [];
      p[1].forEach(function (fr) {
        var t = {};
        Object.keys(fr[0]).forEach(function (id) { if (js.some(function (x) { return x.name === id; })) t[id] = fr[0][id]; });
        if (Object.keys(t).length) kf.push([t, fr[1]]);   // tank_body.py frames(): a joint it does not have is left out
      });
      if (kf.length) poses[p[0]] = kf;
    });
    var rec = {
      format: FORMAT, robot: typeof doc.id === 'string' && ROBOT_RE.test(doc.id) ? doc.id : 'tank',
      status: arm.status === 'MEASURED' ? 'MEASURED' : 'UNMEASURED', brain: arm.enabled !== false,
      chip: { n: js.length, names: js.map(function (x) { return x.name; }).join(','), min: lo.join(','), max: hi.join(','), rest: rests.join(','),
              dps: js.map(function () { return String(dps); }).join(','), hold_s: js.map(function (x) { return x.name === 'grip' ? String(grip) : '0'; }).join(',') },
      parts: parts, poses: poses, caps: ['pose']
    };
    var v = validate(rec);
    return v.ok ? { ok: true, record: rec, why: '' } : { ok: false, record: null, why: 'tank_' + v.why };
  }

  var api = {
    FORMAT: FORMAT, LINE_MAX: LINE_MAX, MOVE_MAX_MS: MOVE_MAX_MS, END_HOLD_MS: END_HOLD_MS, HOLD_MAX_MS: HOLD_MAX_MS, KEEP_MS: KEEP_MS,
    SETTLE_MS: SETTLE_MS, MAX_PARTS: MAX_PARTS, SOCKETS: SOCKETS.slice(),
    SETUP: { min: SETUP.min, max: SETUP.max, mid: SETUP.mid, dps: SETUP.dps, hold_s: SETUP.hold_s },
    validate: validate, fromQ: fromQ, choose: choose, match: match, armed: armed, resolve: resolve, rest: rest, ending: ending, holdMs: holdMs, keepalive: keepalive,
    estimate: estimate, angle: angle, line: line, parseMove: parseMove, toArmConfig: toArmConfig, fromTank: fromTank
  };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.GBParts = api;
})(typeof window !== 'undefined' ? window : this);
