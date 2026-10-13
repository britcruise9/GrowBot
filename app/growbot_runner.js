// GrowBot generic policy runner — channel-name-aware obs assembler.
//
// WHY THIS EXISTS: growbot_policy.js's GrowBotWalker has ONE hardcoded obs layout (classic obs16:
// euler+gyro+hist). This module assembles the obs by reading the channel NAMES from obs_spec, so a
// policy that declares a different channel set runs (e.g. contributor-trained obs72 = 8 channels
// accel+gyro+prevAction, no command; Harsh's DR/RMA obs80 with euler channels).
//
// WHO RUNS IT (0929): v3/next.html (loadGait: the agent's walks and spins), tester/policy.html and
// tester/minimal.html. Changes here reach live robots through next.html. GrowBotPolicy is kept only
// as the weights holder; the forward pass is this module's own runForward (swish/relu/tanh/linear).
//
// Scope:
//   - dialects: flat (obs_spec.channels+frames) AND schema (obs_spec.segments[]).
//   - channels: accel_x/y/z, gyro_x/y/z, euler_roll/pitch/yaw, prev_action_N, cmd_forward, cmd_yaw,
//     cmd_mode_*, cycle:<name> (a step-count clock at obs_spec.control_hz).
//   - action_map: a0=right, a1=left by default; a policy may declare the swap.
//   - order/layout: newest-first × frame-major ONLY (the only combo any real policy uses;
//     "oldest_first"/"channel_major" are refused, not silently mis-assembled).
//   - load-time validation: refuses (loud Error) on any obs-size / channel / std mismatch,
//     instead of feeding the net NaN.

import { GrowBotPolicy } from './growbot_policy.js';

// ── IMU frame transform (the 0623 gravity-axis fix) ──
// policy.html rotates the phone so gravity → +z (z-up). A policy trained in a frame where
// gravity sits on a DIFFERENT axis (e.g. a contributor's obs72: accel-mean gravity on +y) then gets an
// out-of-distribution obs and freezes (frozen split stance). We detect the policy's expected
// "up" from its accel-channel means and rotate the z-up accel/gyro onto it. z-up policies
// (official, a contributor) → identity → math unchanged.
function mat3mul(A, B) {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let s = 0; for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j]; C[i][j] = s; }
  return C;
}
// minimal rotation mapping z-up [0,0,1] -> unit vector u (Rodrigues); null = no rotation needed
function rotZto(u) {
  const bz = u[2];
  if (bz > 0.999999) return null;
  if (bz < -0.999999) return [[1, 0, 0], [0, -1, 0], [0, 0, -1]];   // 180° flip
  const V = [[0, 0, u[0]], [0, 0, u[1]], [-u[0], -u[1], 0]];        // skew(cross([0,0,1], u))
  const V2 = mat3mul(V, V), f = 1 / (1 + bz), R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[i][j] = (i === j ? 1 : 0) + V[i][j] + V2[i][j] * f;
  return R;
}
function applyR(R, v) {
  return { x: R[0][0] * v.x + R[0][1] * v.y + R[0][2] * v.z,
           y: R[1][0] * v.x + R[1][1] * v.y + R[1][2] * v.z,
           z: R[2][0] * v.x + R[2][1] * v.y + R[2][2] * v.z };
}
const norm3 = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

// Explicit gravity-up declaration: obs_spec.imu_frame.up / .gravity (or obs_spec.gravity_axis),
// as an axis token ('+z','-x',…) or a 3-vector. The accelerometer reads +g along this axis at
// rest. Authoritative over the accel-mean guess. Freeform imu_frame.convention/.note are NOT
// parsed (human docs; can be inconsistent — see a contributor's obs72). null = nothing usable declared.
function parseDeclaredUp(spec) {
  const f = spec.imu_frame || {};
  // (no ?? in this file: nullish coalescing is iOS 13.4+ SYNTAX, and tester/policy.html imports
  //  this statically — one ?? anywhere here parse-kills that whole tab on older iPhones. Found via
  //  a tester's iPhone 6 "Tap to Wake shows pressed, does nothing" report, 0810.)
  const g = (f.up != null) ? f.up : ((f.gravity != null) ? f.gravity : spec.gravity_axis);
  if (g == null) return null;
  if (Array.isArray(g) && g.length === 3 && g.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    const u = norm3(g);
    return Number.isFinite(u[0]) ? u : null;
  }
  if (typeof g === 'string') {
    const m = /^([+-]?)\s*([xyz])$/.exec(g.trim().toLowerCase());
    if (m) { const v = [0, 0, 0]; v[{ x: 0, y: 1, z: 2 }[m[2]]] = m[1] === '-' ? -1 : 1; return v; }
  }
  return null;   // unrecognized -> ignore, fall back to the accel-mean inference
}

// Activations. The frozen GrowBotPolicy.forward only special-cases swish (everything else ran
// LINEAR silently — a trap for the common tanh/relu MLP). This module's forward honors all four
// and refuses anything else, and is bit-identical to the frozen one for swish/linear layers.
function swish(x) { return x / (1 + Math.exp(-x)); }
function applyAct(name, out) {
  switch (name) {
    case 'swish': return out.map(swish);
    case 'relu': return out.map((x) => (x > 0 ? x : 0));
    case 'tanh': return out.map(Math.tanh);
    case 'linear': case undefined: case null: return out;
    default: throw new Error(`unknown activation "${name}" (swish/relu/tanh/linear only)`);
  }
}
function runForward(p, obs) {
  let x = new Array(p.n);
  for (let i = 0; i < p.n; i++) x[i] = (obs[i] - p.mean[i]) / p.std[i];
  for (const L of p.layers) {
    const W = L.W, b = L.b, out = new Array(b.length).fill(0);
    for (let i = 0; i < W.length; i++) { const xi = x[i], Wi = W[i]; for (let j = 0; j < Wi.length; j++) out[j] += xi * Wi[j]; }
    for (let j = 0; j < b.length; j++) out[j] += b[j];
    x = applyAct(L.act, out);
  }
  return [Math.tanh(x[0]), Math.tanh(x[1])];   // final action always tanh-squashed (output, not a layer act)
}

// Lenient order/layout: accept "newest_first", "newest_first_frame_major", null; refuse the
// genuinely-unimplemented combos. The real files spell them differently, so we normalize rather
// than match a literal.
function checkOrderLayout(seg, where) {
  const order = String(seg.order || 'newest_first').toLowerCase();
  const layout = String(seg.layout || 'frame_major').toLowerCase();
  if (order.includes('oldest')) throw new Error(`${where}: order "${seg.order}" (oldest-first) not supported yet`);
  if (layout === 'channel_major') throw new Error(`${where}: layout "channel_major" not supported yet`);
}

// obs_spec (either dialect, or absent) -> { segments:[{channels[],frames}], action_to_rad }
function normalizeSpec(pj) {
  const sp = pj.obs_spec || {};
  let segments;
  if (Array.isArray(sp.segments)) {
    segments = sp.segments.map((s, i) => {
      if (!Array.isArray(s.channels) || !s.channels.length) throw new Error(`segment[${i}] has no channels`);
      checkOrderLayout(s, `segment[${i}]`);
      return { channels: s.channels.slice(), frames: Number.isInteger(s.frames) && s.frames > 0 ? s.frames : 1 };
    });
  } else if (Array.isArray(sp.channels) && sp.channels.length) {
    checkOrderLayout(sp, 'obs_spec');
    segments = [{ channels: sp.channels.slice(), frames: Number.isInteger(sp.frames) && sp.frames > 0 ? sp.frames : 1 }];
  } else {
    throw new Error('obs_spec missing channels/segments (classic obs16 policies use GrowBotWalker, not this runner)');
  }
  // action -> radians: obs_spec wins, then top-level, then the sim ctrlrange ±1.5708 (=±90°).
  const action_to_rad = (sp.action_to_rad != null) ? sp.action_to_rad : ((pj.action_to_rad != null) ? pj.action_to_rad : 1.5707963267948966);
  // action_map: default convention is a0=right, a1=left (both frozen walkers). A policy may
  // declare the opposite ({"0":"left_leg","1":"right_leg"} — contributor 0703 calibrated exports) and
  // the walker HONORS it by swapping at the servo stage. Only a malformed/one-sided map throws.
  const am = sp.action_map;
  let swapDeclared = false;
  if (am && typeof am === 'object') {
    const _a0 = (am['0'] != null) ? am['0'] : ((am[0] != null) ? am[0] : '');
    const _a1 = (am['1'] != null) ? am['1'] : ((am[1] != null) ? am[1] : '');
    const m0 = String(_a0).toLowerCase(), m1 = String(_a1).toLowerCase();
    if (m0.includes('left') && m1.includes('right')) swapDeclared = true;
    else if (m0.includes('left') || m1.includes('right')) throw new Error(`action_map ${JSON.stringify(am)} is one-sided/ambiguous — declare both legs`);
  }
  return { segments, action_to_rad, swapDeclared };
}

export class Walker {
  constructor(policyJson, cal = {}) {
    this.p = new GrowBotPolicy(policyJson);
    this.spec = normalizeSpec(policyJson);
    this.toRad = this.spec.action_to_rad;
    this.actSize = Number.isInteger(policyJson.act_size) && policyJson.act_size > 0 ? policyJson.act_size : 2;
    this.cal = Object.assign({ L_SIGN: -1, R_SIGN: 1, L_OFF: 0, R_OFF: 0, IMU_SIGN: [1, -1, 1], gain: 1, turn: 0 }, cal);

    const all = this.spec.segments.flatMap((s) => s.channels);
    this.usesAccel = all.some((c) => c === 'accel_x' || c === 'accel_y' || c === 'accel_z');
    this.usesCmd = all.some((c) => c === 'cmd_forward' || c === 'cmd_yaw');
    this.modeChannels = all.filter((c) => /^cmd_mode_/.test(c));   // discrete one-hot joystick modes (Harsh steerable v3)
    this.usesMode = this.modeChannels.length > 0;
    this.modeIndex = {}; this.modeChannels.forEach((c, i) => { this.modeIndex[c] = i; });   // channel -> its one-hot slot; cmd.mode selects the active slot
    const sp = policyJson.obs_spec || {};
    this.cycles = (sp.cycles && typeof sp.cycles === 'object') ? sp.cycles : {};   // clock-channel declarations
    this.controlHz = Number(sp.control_hz) || 0;                                   // immutable rate the cycle clock steps at
    this._validate(policyJson, all);
    this._initFrame(policyJson);     // pick the IMU frame transform (auto from accel-mean, else z-up)
    this.reset();
  }

  // Detect the policy's expected "up" from its accel-channel means; auto-correct if it's not z-up.
  // Override at runtime with setFrame('zup'|'auto'|'g2y'|'g2x') — e.g. ?frame= in policy.html.
  _initFrame(pj) {
    const declared = parseDeclaredUp(pj.obs_spec || {});   // explicit imu_frame.up wins over the mean guess
    this._meanUp = this._accelUp(pj);                      // data-inferred up, kept for an explicit setFrame('auto')
    this.up = declared || this._meanUp;                    // unit "up" in the policy's frame, or null
    this.upSource = declared ? 'declared' : (this.up ? 'mean' : 'none');
    this.frame = 'zup'; this.R = null; this.mirror = false; this.swap = !!this.spec.swapDeclared; this.reverse = false;
    if (this.up && this.up[2] < 0.966) { this.frame = 'auto'; this.R = rotZto(this.up); }   // >15° off z-up -> rotate gravity onto it
  }
  // up = normalized mean of the newest frame's accel_{x,y,z} (at rest the accel reads +g along up)
  _accelUp(pj) {
    let off = 0;
    for (const seg of this.spec.segments) {
      const ix = seg.channels.indexOf('accel_x'), iy = seg.channels.indexOf('accel_y'), iz = seg.channels.indexOf('accel_z');
      if (ix >= 0 && iy >= 0 && iz >= 0) return norm3([pj.mean[off + ix], pj.mean[off + iy], pj.mean[off + iz]]);
      off += seg.channels.length * seg.frames;
    }
    return null;
  }
  setFrame(name) {
    if (name === 'auto') {   // explicit auto = trust the DATA: a wrong declared up (contributor 0702 stand-up) must not neuter the override
      const u = this._meanUp || this.up;
      if (u) { this.up = u; this.upSource = 'mean'; }
      this.frame = 'auto'; this.R = u ? rotZto(u) : null;
    }
    else if (name === 'g2y') { this.frame = 'g2y'; this.R = rotZto([0, 1, 0]); }
    else if (name === 'g2x') { this.frame = 'g2x'; this.R = rotZto([1, 0, 0]); }
    else { this.frame = 'zup'; this.R = null; }
    return this.frame;
  }
  // Sagittal mirror (reflection across the x-z plane) for bench A/B: gravity pins only one axis,
  // so a sim whose y runs OPPOSITE the phone's is invisible to the frame rotation — a stand-up
  // policy then recovers the wrong way. Vectors flip y; angular rate is a PSEUDOvector: (-x, y, -z).
  setMirror(on) { this.mirror = !!on; return this.mirror; }
  // Leg-swap for bench A/B: route the net's a[0]/a[1] to the OPPOSITE servos, in case an export's
  // action channels are swapped vs its declared action_map. Physical routing only — this.last
  // (the net's prev_action feedback) keeps the net's own output order, staying self-consistent.
  setSwap(on) { this.swap = !!on; return this.swap; }
  // Reverse travel for bench A/B: negate BOTH legs' swing so a correct-but-backwards gait walks
  // the other way. Per-walker only (does NOT touch the shared Manual L_SIGN/R_SIGN cal).
  setReverse(on) { this.reverse = !!on; return this.reverse; }

  // Refuse loudly on any contract mismatch — the net would otherwise silently eat NaN.
  _validate(pj, all) {
    const KNOWN = new Set(['accel_x', 'accel_y', 'accel_z', 'gyro_x', 'gyro_y', 'gyro_z', 'cmd_forward', 'cmd_yaw',
      'euler_roll', 'euler_pitch', 'euler_yaw']);   // euler channels (rad): Harsh's DR/RMA obs80 exports (0710)
    for (const c of all) {
      if (KNOWN.has(c)) continue;
      const m = /^prev_action_(\d+)$/.exec(c);
      if (m) { if (+m[1] >= this.actSize) throw new Error(`channel ${c}: index >= act_size (${this.actSize})`); continue; }
      const cy = /^cycle:(.+)$/.exec(c);
      if (cy) {
        const nm = cy[1], decl = this.cycles[nm];
        if (!decl) throw new Error(`channel ${c}: no cycle "${nm}" declared in obs_spec.cycles`);
        if (!(this.controlHz > 0)) throw new Error(`channel ${c}: obs_spec.control_hz (>0) is required for cycle channels`);
        if (decl.type != null && decl.type !== 'sin' && decl.type !== 'cos') throw new Error(`cycle "${nm}": type must be "sin" or "cos"`);
        continue;
      }
      if (/^cmd_mode_[a-z0-9_]+$/.test(c)) continue;   // discrete joystick mode one-hot slot (Harsh steerable)
      throw new Error(`channel "${c}" not supported by this runner (accel_*/gyro_*/euler_*/prev_action_N/cmd_forward/cmd_yaw/cmd_mode_*/cycle:<name> only)`);
    }
    const assembled = this.spec.segments.reduce((n, s) => n + s.channels.length * s.frames, 0);
    const n = pj.obs_size;
    if (assembled !== n) throw new Error(`assembled obs length ${assembled} != obs_size ${n} (channels×frames mismatch)`);
    if (!Array.isArray(pj.mean) || pj.mean.length !== n) throw new Error(`mean length != obs_size (${n})`);
    if (!Array.isArray(pj.std) || pj.std.length !== n) throw new Error(`std length != obs_size (${n})`);
    if (pj.std.some((v) => !v)) throw new Error('std contains a zero (would divide by zero)');
    if (!Array.isArray(pj.layers) || !pj.layers.length) throw new Error('no layers');
    if (!Array.isArray(pj.layers[0].W) || pj.layers[0].W.length !== n) throw new Error(`layer[0].W rows != obs_size (${n})`);
    for (const L of pj.layers) {
      const a = L.act;
      if (!(a == null || a === 'swish' || a === 'relu' || a === 'tanh' || a === 'linear'))
        throw new Error(`unknown layer activation "${a}" (swish/relu/tanh/linear only)`);
    }
  }

  reset() {
    this.rings = this.spec.segments.map((s) => Array.from({ length: s.frames }, () => new Array(s.channels.length).fill(0)));
    this.last = new Array(this.actSize).fill(0);
    this.stepIndex = 0;   // cycle-clock phase counter; advances once per step() (walk only), reset per episode
  }

  // cycle:<name> clock value = scale · fn(2π·frequency·(stepIndex/control_hz) + phase offset).
  // Deterministic STEP-count clock (not wall-clock); uses the policy's immutable control_hz, not the
  // cadence slider. The value is frozen into the frame at build time, so history frames carry past phase.
  // Phase offset: phase_offset_rad, else offset_seconds·2π·f (contributor obs90 exports declare offset_seconds;
  // dropping it collapses a staggered clock PAIR into identical twins and erases the gait's direction — 0709 bug).
  _cycle(name) {
    const c = this.cycles[name] || {};
    const fn = c.type === 'cos' ? Math.cos : Math.sin;   // default sin
    const off = c.phase_offset_rad != null ? Number(c.phase_offset_rad)
              : 2 * Math.PI * (Number(c.frequency) || 0) * (Number(c.offset_seconds) || 0);
    const arg = 2 * Math.PI * (Number(c.frequency) || 0) * (this.stepIndex / this.controlHz) + off;
    return (c.scale == null ? 1 : Number(c.scale)) * fn(arg);
  }

  // accel/gyro: {x,y,z} ALREADY rotated into the body frame (caller applies the z-up Rx). cmd:{fwd,yaw} optional.
  // euler: {roll,pitch,yaw} in rad (base-relative phone euler, same source as the classic obs16 path) —
  // only read by policies declaring euler_* channels; IMU_SIGN applies per-axis exactly as the classic walker.
  // Returns {l,r} servo degrees (0-180) + raw action.
  step(accel, gyro, cmd, euler) {
    cmd = cmd || { fwd: 0, yaw: 0 };
    let E = euler || { roll: 0, pitch: 0, yaw: 0 };
    if (this.mirror) E = { roll: -E.roll, pitch: E.pitch, yaw: -E.yaw };   // sagittal mirror: roll/yaw flip, pitch stays (matches the gyro pseudovector)
    // z-up (default): no rotation, apply the bench IMU_SIGN (preserves the proven contributor path).
    // Frame transform active ('auto'/'g2*'): rotate accel/gyro into the
    // policy's frame and DON'T apply IMU_SIGN (the rotation places the axes; signs are baked into
    // the policy's own training/mean).
    let A = accel, G = gyro, s = this.cal.IMU_SIGN || [1, 1, 1];
    if (this.R) { A = applyR(this.R, accel); G = applyR(this.R, gyro); s = [1, 1, 1]; }
    if (this.mirror) { A = { x: A.x, y: -A.y, z: A.z }; G = { x: -G.x, y: G.y, z: -G.z }; }
    const src = {
      accel_x: s[0] * A.x, accel_y: s[1] * A.y, accel_z: s[2] * A.z,
      gyro_x: s[0] * G.x, gyro_y: s[1] * G.y, gyro_z: s[2] * G.z,
      euler_roll: s[0] * E.roll, euler_pitch: s[1] * E.pitch, euler_yaw: s[2] * E.yaw,   // same per-axis bench signs as the classic obs16 walker
      cmd_forward: cmd.fwd, cmd_yaw: cmd.yaw,
    };
    const resolve = (ch) => {
      const v = src[ch];
      if (v !== undefined) return v;
      const m = /^prev_action_(\d+)$/.exec(ch);   // read t-1 action
      if (m) return this.last[+m[1]] || 0;
      if (this.modeIndex[ch] !== undefined) return this.modeIndex[ch] === (cmd.mode | 0) ? 1 : 0;   // discrete mode one-hot: 1 in the commanded slot
      return this._cycle(ch.slice(6));             // cycle:<name> -> clock value at the current stepIndex
    };
    const obs = [];
    for (let i = 0; i < this.spec.segments.length; i++) {
      const seg = this.spec.segments[i], ring = this.rings[i];
      ring.unshift(seg.channels.map(resolve));     // build this frame with the PRE-update action, push newest-first
      if (ring.length > seg.frames) ring.pop();
      for (const f of ring) for (const v of f) obs.push(v);   // flatten newest-first, frame-major
    }
    this.lastObs = obs;                             // read outside this repo by internal parity and bench tools
    const a = runForward(this.p, obs);              // [aRight, aLeft] in [-1,1] — honors swish/relu/tanh/linear
    this.last = a;                                  // feed the actually-sent action back
    const c = this.cal, rev = this.reverse ? -1 : 1, deg = (v) => v * rev * this.toRad * 180 / Math.PI;   // rev negates both legs' swing = reverse travel
    const [aL, aR] = this.swap ? [a[0], a[1]] : [a[1], a[0]];          // default a[1]=left/a[0]=right; swap = bench override
    const l = 90 + c.L_OFF + c.L_SIGN * deg(aL) * c.gain + c.turn;     // left -> port1
    const r = 90 + c.R_OFF + c.R_SIGN * deg(aR) * c.gain - c.turn;     // right -> port3
    const clamp = (v) => Math.max(0, Math.min(180, v));
    this.stepIndex++;                               // advance the cycle clock (once per walk step)
    return { l: clamp(l), r: clamp(r), action: a };
  }
}
