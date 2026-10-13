// GrowBot DIY v1 residual-policy runner (browser/Node, ES2018-safe: no ?? or ?.).
// Reproduces growbot_env.py exactly: seed gait (motion.mjs stroke/rhythm) + 12 deg * policy(obs),
// then the Motion Lab servoTargets(). SIM-ONLY candidates until hardware A/B.
//
// Phone -> body frame (body X = long axis toward board/camera end, Y lateral, Z = screen normal):
//   measured 0929 on the bench robot: at stance, accelerationIncludingGravity reads mostly +devY/+devZ,
//   so the phone top points to the board end:  body = (devY, -devX, devZ).
//   rotationRate (W3C DeviceMotionEventRotationRate): alpha = about device X, beta = Y, gamma = Z; measured
//   0923 on the bench robot vs overhead camera. (deviceorientation's alpha is a different thing: an angle about Z.)
//   rateOrder stays explicit so a phone that reports otherwise can be adapted without a code change.
const D = Math.PI / 180;
const smooth = function (t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

export function seedJoints(p, cycle) {
  const q = ((cycle % 1) + 1) % 1;
  if (p.mode === 'rhythm') {
    const s = function (x) { return Math.sin(2 * Math.PI * x); };
    return [p.height + p.amplitude * s(q), -p.height + p.amplitude * s(q + p.phase / 360)];
  }
  const d = p.duty;
  const w = q < d ? -1 + 2 * smooth(q / d) : 1 - 2 * smooth((q - d) / (1 - d));
  return [p.height + p.amplitude * w, -p.height - p.amplitude * w];
}

export function forward(policy, obs) {
  let x = obs;
  const L = policy.layers;
  for (let k = 0; k < L.length; k++) {
    const W = L[k].W, b = L[k].b, y = new Array(W.length);
    for (let i = 0; i < W.length; i++) {
      let s = b[i];
      const row = W[i];
      for (let j = 0; j < row.length; j++) s += row[j] * x[j];
      y[i] = k < L.length - 1 ? Math.tanh(s) : Math.max(-1, Math.min(1, s));
    }
    x = y;
  }
  return x;
}

export function phoneToBody(rate, accel, rateOrder) {
  // rate: {alpha,beta,gamma} deg/s ; accel: {x,y,z} m/s^2 (accelerationIncludingGravity, spec sign)
  const dev = [0, 0, 0];
  const names = ['alpha', 'beta', 'gamma'];
  for (let k = 0; k < 3; k++) dev[rateOrder[k]] = rate[names[k]] * D; // rateOrder[k] = device axis of that field
  return {
    gyro: [dev[1], -dev[0], dev[2]],
    acc: [accel.y, -accel.x, accel.z],
  };
}

export class ResidualPolicy {
  constructor(policy, opts) {
    const c = policy.contract;
    if (c.control_hz !== 25 || c.hist !== 3) throw Error('Unexpected policy contract');
    this.p = policy; this.seed = c.seed; this.cal = c.cal; this.hist = c.hist;
    this.rateOrder = (opts && opts.rateOrder) || [0, 1, 2]; // W3C: alpha->dev x, beta->dev y, gamma->dev z
    this.reset();
  }
  reset() { this.t = 0; this.cycle = 0; this.prev = [0, 0]; this.frames = null; }
  frame(gyro, acc) {
    const ph = 2 * Math.PI * (((this.cycle % 1) + 1) % 1);
    const clip = function (v) { return Math.max(-3, Math.min(3, v)); };
    return [clip(gyro[0] / 5), clip(gyro[1] / 5), clip(gyro[2] / 5), acc[0] / 9.81, acc[1] / 9.81, acc[2] / 9.81,
      this.prev[0], this.prev[1], Math.sin(ph), Math.cos(ph)];
  }
  // One 25 Hz tick. Returns integer servo degrees [L, R] for the wire.
  tickBody(gyro, acc) {
    const f = this.frame(gyro, acc);
    if (!this.frames) { this.frames = []; for (let i = 0; i < this.hist; i++) this.frames.push(f); }
    else { this.frames.push(f); this.frames.shift(); }
    const obs = [];
    for (let i = this.frames.length - 1; i >= 0; i--) for (let j = 0; j < f.length; j++) obs.push(this.frames[i][j]);
    const a = forward(this.p, obs);
    this.cycle += (1 / 25) * this.seed.hz * this.seed.dir;
    const j = seedJoints(this.seed, this.cycle), ramp = smooth(this.t / 0.7);
    const res = this.p.contract.res_deg || 12;  // per-task residual range (stand 35, gaits 12)
    const jl = j[0] * ramp + res * a[0], jr = j[1] * ramp + res * a[1];
    const c = this.cal;
    const s = [90 + c.L_OFF + c.L_SIGN * jl * c.gain, 90 + c.R_OFF + c.R_SIGN * jr * c.gain].map(function (v) { return Math.max(0, Math.min(180, Math.round(v))); });
    this.prev = a; this.t += 1 / 25;
    return { servo: s, action: a, obs: obs };
  }
  tick(rate, accel) { const b = phoneToBody(rate, accel, this.rateOrder); return this.tickBody(b.gyro, b.acc); }
}
