# The open forward model

A physical imagination for the 85 mm body: a tiny net that predicts what the IMU
will read next given what the legs are told to do. Learned on the MuJoCo twin in
`policy/Harsh_policies/DR_RMA_EXPORT`, same body the walk policy was trained in.

- `growbot_forward.js` is the runner. Pure JS, zero dependencies, browser or Node. Verified against the trained PyTorch net to float32 precision (`node test_forward.mjs`).
- `forward_85mm.json` is the weights, for the 85 mm leg body. 24,841 parameters, about the size of the walk policy.
- `growbot_planner.js` is optional: a small planner that searches through the imagination to reproduce a target motion. Separate so ports and the harness can take the runner alone.

## Why

The launch video names the wall: the creature can read the last second of its
sensors but cannot imagine the next one, so it fails the mimic game and cannot
learn fine motor skill from experience. This is the predicting half of that
cerebellum. Roll it forward on its own output and you get "what happens if I move
like this" before anything moves.

## The contract

Mirrors the walk policy's so the two share one calibration:

- **History**: the last 5 `(imu, action)` pairs, newest first.
  - `imu6 = [roll, pitch, yaw, gyroRoll, gyroPitch, gyroYaw]` — the same frame and sign calibration you already feed `GrowBotPolicy`.
  - `action2 = [aRight, aLeft]` in radians of leg swing — the walk policy's output units, before the degrees conversion.
- **Output**: the change in the IMU over one 20 ms tick. Angles live as `(sin, cos)` internally so yaw wrap and a roll through ±π in a fall never jump; `imagine()` hands you plain `imu6` back.

```js
import { GrowBotForward } from "./growbot_forward.js";
import { planToMatch } from "./growbot_planner.js";   // optional
const fwd = new GrowBotForward(await (await fetch("forward_85mm.json")).json());

// every tick, tell it what you sensed and what you commanded
fwd.observe(imu6, [aRight, aLeft]);

// what would happen if I did this for the next 300 ms?
const { imu6: imagined } = fwd.imagine(plan15);      // 15 × [aRight, aLeft]

// optional: find the leg commands that reproduce a target motion (the mimic game)
const chunk = planToMatch(fwd, targetImu6Trace);      // returns 15 × [aRight, aLeft]
```

`planToMatch` is a small cross-entropy search over an action chunk. 256 candidates ×
4 rounds × 15 ticks of a 25k-param net is a few milliseconds in a phone browser.
Send the chunk tick by tick, replan every ~100 ms.

## What it does, measured in the twin

Held-out episodes, model rolled forward on its own predictions, fraction of starts
whose imagined roll/pitch stays within 0.2 rad of the truth:

| horizon | persistence ("nothing changes") | linear | **this model** |
|---|---|---|---|
| 100 ms | 85.9 % | 93.5 % | **95.9 %** |
| 500 ms | 59.0 % | 75.0 % | **83.6 %** |

Where the body is calm the three tie; the model earns its keep under fast motion
(41 → 86 %) and while tipping or fallen (58 → 89 %) — the bounces and shakes the
video says the creature cannot picture.

Mimic game, 40 held-out 2 s traces, plan through imagination and execute in the twin:

| planner | roll/pitch error (rad) | beats holding still |
|---|---|---|
| hold still | 0.210 | — |
| plan without imagination | 0.220 | 42 % |
| **plan with this model** | **0.095** | **98 %** |

Planning without a forward model is worse than doing nothing. Replanning every
100 ms is the sweet spot — every tick chases noise, pure 2 s imagination drifts.

## What it does not do

It was trained in MuJoCo, so it has learned MuJoCo. Sim-to-real is the same gap
the walk policy crosses; expect it to be right about the shape of a motion and off
about the magnitudes until it has seen the real body. The other half of the
cerebellum — comparing prediction with what actually happened and updating from
the error, on-device — is the follow-up this file is for. Everything needed to
train it is in the source repository linked below.

Source, data generation and evaluation: https://github.com/xebastian153/growbot-cerebellum.
License: PolyForm Noncommercial 1.0.0, weights included, same as the walk policy.
