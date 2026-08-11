# The open walk policy

This is the actual trained walk policy the live GrowBot app uses, open sourced. A tiny neural net that turns body motion into leg commands, learned in simulation.

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

Note the IMU is the PHONE'S, not the chip's: the brain runs this at ~30 Hz against its own sensors and streams the resulting poses to the body (see [protocol](../protocol/PROTOCOL.md), path B). Your port does not need to run this at all to walk with the hosted brain. It is here so you can study it, run it against your own rig, or retrain your own and swap the JSON.

Wheels instead of legs? Mirroring left/right makes wheeled bases twitch instead of drive (the gait alternates on purpose). See [ports/automower](../ports/automower/) for the wheeled-base notes.

Want to retrain it? The full training pipeline (Colab notebook, sim model, checkpoint, exporter, verifier) is in [training/](training/).

License: PolyForm Noncommercial 1.0.0, same as the rest of the code, weights included.
