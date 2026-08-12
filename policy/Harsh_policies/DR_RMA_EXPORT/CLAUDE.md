# GrowBot DR/RMA forward-walking policy — export

A trained reinforcement-learning **forward-walking** policy for **GrowBot**, a crude
2-servo-leg robot (flat torso, "sagittal paddler") with a phone brain, controlled at
**25 Hz**. This folder contains the training notebook, a deploy/viewer script, and the
full checkpoint history. Everything needed to load, watch, and continue training is here.

> This is a **forward-only** walker (no steering). It was trained with heavy domain
> randomization and an RMA-style asymmetric critic so it transfers to a real, imperfect body.

## Contents

| Path | What it is |
|---|---|
| `growbot_DR_RMA_train.ipynb` | The training notebook. **Self-contained** — the MJCF body is embedded inline; one-click `Runtime → Run all` on Colab (T4). |
| `growbot_public_rollout_body.xml` | The MuJoCo MJCF body (nominal, non-randomized). Identical to the notebook's embedded copy. Needed by `view_policy.py`. |
| `view_policy.py` | Load a checkpoint and watch it walk in the interactive MuJoCo viewer. |
| `DR_RMA_checkpoint/step_*.pkl` | 51 periodic checkpoints, `step_1310720` → `step_66846720` (~396 KB each). |
| `DR_RMA_logs/` | TensorBoard event file for the run (35 scalar tags). |

## Quick start (watch it walk)

```bash
python3 view_policy.py                                  # uses DR_RMA_checkpoint/step_60293120.pkl
python3 view_policy.py DR_RMA_checkpoint/step_62914560.pkl   # any other checkpoint
```

**Recommended checkpoint: `step_60293120.pkl`** (the default; clean stable gait). Later
checkpoints (up to `step_66846720`) are also fine.

## Environment — pinned stack is mandatory

A fresh `pip install brax jax` **breaks**: current `brax` calls a JAX API that current
`jax` removed. Use exactly these (verified to work together):

```bash
pip install "jax[cuda12]==0.4.36" "jaxlib==0.4.36" \
  "brax==0.12.1" "flax==0.10.2" "optax==0.2.4" "orbax-checkpoint==0.6.4" \
  "mujoco==3.2.7" "mujoco-mjx==3.2.7" "tensorboardX"
```

For CPU-only local viewing, `jax==0.4.36` (without the `[cuda12]` extra) is fine.

## How the policy works (what to know before using it)

- **Control:** 25 Hz. MJX/MuJoCo `timestep=0.005`, `n_frames=8` → one action every 0.04 s.
- **Action:** 2 values → the two leg servos (`d.ctrl[:] = action`, `nu=2`).
- **Observation is a dict with two keys** — this is an **asymmetric actor-critic (RMA-style)** setup:
  - `state` — **the only thing the policy sees, and the only thing you need to deploy.**
    Size **80** = a 10-frame history of `[roll, pitch, yaw, gyro_x, gyro_y, gyro_z, last_action_0, last_action_1]` (8 dims × 10 frames), newest frame first.
  - `privileged` — size **24**, a training-only input to the **critic**. The policy network
    **never reads it**. It's kept in the obs dict at deploy time only because the saved
    observation normalizer was fit on the full tree and expects the same structure.
    Its values are irrelevant to the action (verified: all-zeros vs all-999s → bit-identical actions), so feed `zeros(24)`.
- **Networks:** policy MLP `(128, 128)`, critic MLP `(256, 256)`, `tanh`-Gaussian PPO policy.
  Deploy with `deterministic=True`.

### Checkpoint format

Each `.pkl` loads via `brax.io.model.load_params` to a **tuple** `(normalizer_params, PPONetworkParams)`
where `PPONetworkParams` has `.policy` and `.value`. To build an inference fn you pass
`(normalizer_params, params.policy)` to `make_inference_fn`. See `load_policy()` in
`view_policy.py` for the exact, working recipe — copy it.

Minimal load + step:

```python
import jax, numpy as np
from jax import numpy as jnp
from brax.training.agents.ppo import networks as ppo_networks
from brax.training.acme import running_statistics
from brax.io import model

raw = model.load_params("DR_RMA_checkpoint/step_60293120.pkl")
params = (raw[0], raw[1].policy)                       # (normalizer, policy-only)
net = ppo_networks.make_ppo_networks(
    {"state": 80, "privileged": 24}, 2,
    preprocess_observations_fn=running_statistics.normalize,
    policy_hidden_layer_sizes=(128, 128), value_hidden_layer_sizes=(256, 256),
    policy_obs_key="state", value_obs_key="privileged")
infer = jax.jit(ppo_networks.make_inference_fn(net)(params, deterministic=True))
action, _ = infer({"state": jnp.zeros(80), "privileged": jnp.zeros(24)}, jax.random.PRNGKey(0))
```

## Deploying on the real robot (important)

- Build `state` from the robot's **IMU** (roll/pitch/yaw + 3-axis gyro) and the **last action
  you sent**, stacked over the last 10 control ticks, newest first, then flattened to 80.
- **Normalize with the saved normalizer** (it's `raw[0]`; `make_inference_fn` applies it) —
  do not feed raw units.
- The policy was trained **with** IMU noise, mount misalignment, cloud-relay delay/packet-loss,
  and actuator slew/lag (domain randomization). `view_policy.py` deliberately runs a **clean,
  noise-free nominal body** for a visual sanity check. When deploying, real IMU noise is
  expected and fine — in fact a perfectly clean, deterministic sim can fall into a
  "walk-in-place" limit cycle that real-world noise naturally kicks it out of.

## Continue / retrain

Open `growbot_DR_RMA_train.ipynb` in Colab → `Runtime → Run all`. Checkpoints + TensorBoard
logs save to Google Drive if you allow the auth popup (survives disconnects; resumable),
otherwise to local `/content`. To resume from a checkpoint, set `restore = model.load_params(".../step_*.pkl")`
in the Train cell (see the notebook's last markdown cell).

## Run health (from the included logs)

Trained to **~60.3M steps** (47 evals). `Diagnostics/FallRate → 0.0` (never falls),
`Reward/1_Total` climbed and plateaued. This is a stable, non-falling forward gait — crude
and slow (it's a 2-leg paddler), but robust across the randomized-body distribution.
