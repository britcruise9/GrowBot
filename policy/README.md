# The open walk policy

This is the walk policy the GrowBot app launched with in August 2026, open sourced. The live app has moved to newer walks and spins since, and those are not in this repo yet. A tiny neural net that turns body motion into leg commands, learned in simulation.

- `growbot_policy.js` is the runner. Pure JS forward pass, zero dependencies, runs in a browser or Node. Verified bit-equal to the trained JAX net.
- `policy_85mm.json` is the weights, for the 85 mm leg body.

## The contract

- **Input** (16 numbers): `[roll, pitch, yaw, gyroRoll, gyroPitch, gyroYaw]` from an IMU, plus the last 5 action pairs, newest first.
- **Output** (2 numbers): `[aRight, aLeft]` in -1..1, treated as radians of leg swing.

```js
import { GrowBotPolicy } from "./growbot_policy.js";
const policy = new GrowBotPolicy(await (await fetch("policy_85mm.json")).json());
const [aRight, aLeft] = policy.forward(obs16);
```

Note the IMU is the PHONE'S, not the chip's: the brain runs this at ~30 Hz against its own sensors and streams the resulting poses to the body as `pose` messages (see [body-docs](https://growbot.dev/body-docs.html)). Your port does not need to run this at all to walk with the hosted brain. It is here so you can study it, run it against your own rig, or retrain your own and swap the JSON.

Wheels instead of legs? Don't run a walk on wheels, it makes a rover twitch instead of drive. Use wheels mode, see [PORTING.md](../PORTING.md).

## Also in this folder

- [`forward/`](forward/): a forward model for the 85 mm body. It predicts the next IMU reading from the leg commands. Contributed by @xebastian153 (#7).
- [`Harsh_policies/`](Harsh_policies/): Harsh's DR+RMA forward walk and spin-in-place training exports, with notebooks, MuJoCo bodies, checkpoints and viewers (#4).

License: PolyForm Noncommercial 1.0.0, same as the rest of the code, weights included.
