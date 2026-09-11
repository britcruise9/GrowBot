// GrowBot mimic planner — turns a target IMU trace into a chunk of leg commands by
// searching through the forward model's imagination. Pure JS, no deps. Separate from
// the runner so ports and the harness can take the imagination without the planner.
//
//   import { GrowBotForward } from './growbot_forward.js';
//   import { planToMatch } from './growbot_planner.js';
//   const chunk = planToMatch(fwd, targetImu6Trace);   // H × [aRight, aLeft]

// ---- optional: a small planner that uses the imagination to hit a target ----
// Cross-entropy search over an action chunk. Score = mean squared roll/pitch error
// between imagined and target imu6 traces. ~256 candidates × 4 iterations × H ticks
// of a 25k-param net: a few ms in a phone browser for H = 15.
export function planToMatch(fwd, target6, opts = {}) {
  const H = target6.length, n = opts.n ?? 256, iters = opts.iters ?? 4, elite = opts.elite ?? 32;
  const smooth = opts.smooth ?? 0.6, rand = opts.rand ?? Math.random;
  let mean = opts.init ?? Array.from({ length: H }, () => [0, 0]);
  let std = Array.from({ length: H }, () => [0.6, 0.6]);
  const gauss = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand();
                        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const wrap = (e) => Math.atan2(Math.sin(e), Math.cos(e));
  for (let it = 0; it < iters; it++) {
    const cands = [];
    for (let c = 0; c < n; c++) {
      const plan = [];
      for (let h = 0; h < H; h++) {
        let a = [mean[h][0] + std[h][0] * gauss(), mean[h][1] + std[h][1] * gauss()];
        if (h) a = [smooth * plan[h - 1][0] + (1 - smooth) * a[0], smooth * plan[h - 1][1] + (1 - smooth) * a[1]];
        plan.push([Math.max(-1.4, Math.min(1.4, a[0])), Math.max(-1.4, Math.min(1.4, a[1]))]);
      }
      const im = fwd.imagine(plan).imu6;
      let cost = 0;
      for (let h = 0; h < H; h++) { const e0 = wrap(im[h][0] - target6[h][0]), e1 = wrap(im[h][1] - target6[h][1]); cost += e0 * e0 + e1 * e1; }
      cands.push({ plan, cost });
    }
    cands.sort((a, b) => a.cost - b.cost);
    const top = cands.slice(0, elite);
    mean = Array.from({ length: H }, (_, h) => [0, 1].map((j) => top.reduce((s, c) => s + c.plan[h][j], 0) / elite));
    std = Array.from({ length: H }, (_, h) => [0, 1].map((j) => {
      const m = mean[h][j]; return Math.sqrt(top.reduce((s, c) => s + (c.plan[h][j] - m) ** 2, 0) / elite) + 0.02; }));
  }
  return mean;   // the action chunk to send, tick by tick
}
