# GrowBot DR/RMA **spin-in-place** policy — **Olie body** export

A trained reinforcement-learning **spin-in-place** (turn-on-the-spot) policy for the
**Olie body** — a GrowBot build with a **hollow enclosure torso** (tub + backplate) and a
battery mounted **rear-flush on the underside**, controlled at **25 Hz** by a phone brain.
The robot turns about its vertical axis while holding position, using an asymmetric
paddling motion of its two fore/aft legs. This folder has the training notebook, a
deploy/viewer script, the full checkpoint history, the 9-body showcase, and a DR
robustness tool — everything needed to load, watch, deploy, and continue training.

> This is a **single-direction spinner: CCW (yaw-left)**, trained with heavy domain
> randomization and an RMA-style asymmetric critic so it transfers to a real, imperfect
> body. There is **no runtime steering/direction command** — for CW, train a second
> policy with `SPIN_DIR = -1` (see the notebook).

> **Relation to the walking export (`DR_RMA_OLIE_EXPORT`):** the policy **interface is
> identical** — same 25 Hz, same `state`(80)/`privileged`(24) obs, same 2 actions, same
> `(128,128)`/`(256,256)` network shapes. **A coworker who has deploy code for the walk
> policy can run this one with zero changes to that code** — only the *behaviour* differs
> (spin vs. walk). What's new here is the **reward/objective** and a **two-phase
> curriculum** in training (below).

## What's different from the walk policy

Only the **reward** — the body, obs, actuator model, control rate, and network are all
unchanged from the walk run.

| | Walk policy | **Spin policy (this export)** |
|---|---|---|
| Objective | maximize forward velocity | maximize **yaw rate** while holding position |
| Reward | `5·v_forward − ctrl − action_rate` | `alive + 4·tanh(yaw_rate) − drift(deadbanded) − 0.15·\|roll\| − ctrl − action_rate` |
| Result | ~3.6 cm/s forward | **~0.38 rad/s CCW** on the nominal body (~3.6 s/rev), **~0.21 rad/s averaged over the full DR distribution** |
| Stays in place | n/a | yes — drift held within ~0.15 m; never falls across the DR sweep |

## ⚠️ Read this first: the v1→v2 story (why `deterministic_eval=True` matters)

An earlier **v1** run of this policy **looked** like it was learning to spin — its
TensorBoard `YawRate` climbed to ~0.05 rad/s and its reward curves rose. **It was not
spinning.** A *deterministic* rollout of the v1 final checkpoint (i.e. the policy as it
actually deploys) turned at **0.0004 rad/s** — it parked on its battery-heavy tail and
sat. The curves were measured with brax's **default `deterministic_eval=False`**, so every
eval ran the *exploring* (action-sampling) policy; almost all the "yaw" in the v1 logs was
sampling jitter, not a gait.

**This v2 export fixes that:** every `ppo.train()` call passes **`deterministic_eval=True`**,
so the logged curves reflect the policy that ships. The lesson for anyone extending this:
**always sanity-check an RL policy with a deterministic video rollout — never trust the
training curves alone.** (`view_policy.py` and the showcase are both deterministic.)

## Contents

| Path | What it is |
|---|---|
| `growbot_olie_spin_in_place_DR_RMA_train_v2.ipynb` | The training notebook. **Self-contained** — the olie MJCF is embedded inline; one-click `Runtime → Run all` on Colab (T4). Two-phase curriculum built in. |
| `growbot_olie_body.xml` | The MuJoCo MJCF body (nominal, non-randomized). Identical to the notebook's embedded copy and to the walk export's. Needed by `view_policy.py` / `dr_sweep_spin.py`. |
| `view_policy.py` | Load a checkpoint and watch it spin in the interactive MuJoCo viewer, with a live yaw/rev/drift readout. Handles **both** pkl formats automatically. |
| `dr_sweep_spin.py` | Robustness tool: runs the deterministic policy across 13 corners of the DR distribution (mass/CoM/leg/gain/friction extremes + worst-case combo) and reports yaw rate / drift / fall per corner. |
| `growbot_spin_v2_DR_RMA_final.pkl` | **Recommended deploy artifact** — the final phase-2 policy. |
| `growbot_spin_v2_phase1_warmup.pkl` | The end-of-phase-1 (spin-only warmup) snapshot, for reference/debugging — lets you see the gait *before* the position-holding fine-tune reshaped it. Not for deploy. |
| `checkpoints/phase1/step_*.pkl` | 19 checkpoints of the **spin-only warmup** phase (`step_1310720` → `step_24903680`). |
| `checkpoints/phase2/step_*.pkl` | 39 checkpoints of the **full-penalty fine-tune** phase (`step_1310720` → `step_51118080`). |
| `logs/events.*` | TensorBoard event file (both phases on one continuous step axis). |
| `growbot_olie_spin_showcase_collage.mp4` | 3×3 video: the same policy on 9 randomized bodies, fixed spawn-centered camera, live rev-counter + drift. |

### Three things a coworker will trip on

1. **Two checkpoint pkl formats** (same as the walk export).
   - `checkpoints/phase*/step_*.pkl` → a **2-tuple** `(normalizer, PPONetworkParams(policy,value))` (from the notebook's `save_ckpt`).
   - `growbot_spin_v2_DR_RMA_final.pkl` / `*_phase1_warmup.pkl` → a **3-tuple** `(normalizer, policy_params, value_params)` (from `ppo.train()`'s return value).
   - `load_policy()` in `view_policy.py` detects `len(raw)` and handles both. **Copy that recipe.**

2. **Two training phases, and the step axis has a small overlap.** Phase 1 (spin-only,
   no drift/tilt penalty) ran to ~25 M steps to *find* the paddling gait; phase 2 restored
   those weights into the full-penalty env and ran ~51 M more to teach it to hold position.
   Total ≈ **76 M effective steps**. brax counts `env_steps` from 0 per `ppo.train()` call,
   so phase 2's checkpoints are numbered from 0 again — and the log's phase-2 curve is
   offset by the *configured* phase-1 budget (20 M), which is slightly less than the ~25 M
   phase 1 actually ran, so there's a tiny overlap in the logged x-axis. Don't over-read
   step numbers; compare curves.

3. **Single spin direction, no command input.** This policy only spins **CCW**. The obs
   has no direction/command channel (kept identical to the walk policy on purpose), so you
   cannot ask it to reverse at runtime. Train a second policy with `SPIN_DIR = -1` for CW
   and switch between the two `.pkl`s on the robot.

## Quick start (watch it spin)

```bash
python3 view_policy.py                                       # uses growbot_spin_v2_DR_RMA_final.pkl
python3 view_policy.py checkpoints/phase2/step_51118080.pkl  # any other checkpoint
python3 dr_sweep_spin.py growbot_spin_v2_DR_RMA_final.pkl 10 # robustness across the DR corners
```

**Recommended: `growbot_spin_v2_DR_RMA_final.pkl`** (the default; the converged,
position-holding spinner).

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
- **Observation is a dict with two keys** — an **asymmetric actor-critic (RMA-style)** setup:
  - `state` — **the only thing the policy sees, and the only thing you need to deploy.**
    Size **80** = a 10-frame history of `[roll, pitch, yaw, gyro_x, gyro_y, gyro_z, last_action_0, last_action_1]` (8 dims × 10 frames), newest frame first.
  - `privileged` — size **24**, a training-only input to the **critic**. The policy network
    **never reads it** (verified: `zeros(24)` vs `999s(24)` → bit-identical action). It's kept
    in the obs dict at deploy only because the saved normalizer was fit on the full tree.
    Feed `zeros(24)`.
- **Networks:** policy MLP `(128, 128)`, critic MLP `(256, 256)`, `tanh`-Gaussian PPO policy.
  Deploy with `deterministic=True`.

Minimal load + step (works for both pkl formats):

```python
import jax
from jax import numpy as jnp
from brax.training.agents.ppo import networks as ppo_networks
from brax.training.acme import running_statistics
from brax.io import model

raw = model.load_params("growbot_spin_v2_DR_RMA_final.pkl")
params = (raw[0], raw[1]) if len(raw) == 3 else (raw[0], raw[1].policy)
net = ppo_networks.make_ppo_networks(
    {"state": 80, "privileged": 24}, 2,
    preprocess_observations_fn=running_statistics.normalize,
    policy_hidden_layer_sizes=(128, 128), value_hidden_layer_sizes=(256, 256),
    policy_obs_key="state", value_obs_key="privileged")
infer = jax.jit(ppo_networks.make_inference_fn(net)(params, deterministic=True))
action, _ = infer({"state": jnp.zeros(80), "privileged": jnp.zeros(24)}, jax.random.PRNGKey(0))
```

## Deploying on the real robot

- Build `state` from the robot's **IMU** (roll/pitch/yaw + 3-axis gyro) and the **last
  action you sent**, stacked over the last 10 control ticks, newest first, flattened to 80.
  This is byte-for-byte the **same `state` layout as the walk policy** — reuse that code.
- **Normalize with the saved normalizer** (`raw[0]`; `make_inference_fn` applies it) — do not
  feed raw units.
- **`yaw_rate` is the reward channel**, and it's exactly the robot's IMU **gyro-z** — so what
  the policy optimizes is directly observable on hardware.
- The policy trained **with** IMU noise, mount misalignment, cloud-relay delay/packet-loss,
  and actuator slew/lag. `view_policy.py` runs a **clean nominal body** for a visual sanity
  check; real IMU noise at deploy is expected and fine.
- **Expect it to spin while tilted back ~30° on its battery tail** — that's the body's
  natural rest posture (a rear-heavy 2-hinge body), not a fault. Training only penalizes
  *roll*, not this pitch, because the pitch isn't a controllable quantity.

### Two known sim caveats (shared with the walk export; deployed fine there)

- `forcerange=1.5` in the MJCF is ~7× a real MG90S stall torque, and the DR gain range
  (0.75–1.25×) doesn't span that gap — so the sim servos are stronger than reality. Expect
  the real robot to spin a bit slower than the sim.
- The notebook's `Diagnostics/ActionSaturation` metric is inert (tests `|action| > 0.95×1.57`,
  but tanh-squashed actions never exceed 1) — it logs a flat 0. (Note: this policy achieves
  its spin *without* saturating actions anyway, so there's nothing to see there regardless.)

## Continue / retrain

Open `growbot_olie_spin_in_place_DR_RMA_train_v2.ipynb` in Colab → `Runtime → Run all`.
Both phases run automatically; checkpoints + logs save to Google Drive if you allow the
auth popup (resumable), else to local `/content`. The notebook's phase-2 cell shows the
exact **`restore_checkpoint_path`** resume recipe (brax 0.12.1 has **no** `restore_params`
kwarg — you must write the params to an orbax checkpoint dir first; the cell does this for
you). To make a **CW** spinner, set `SPIN_DIR = -1` in the config cell and rerun.

**Reward-tuning levers** (all in the config cell, documented there): `SPIN_SCALE`/`YAW_SAT`
(how hard to reward turning), `DRIFT_COST`/`DRIFT_DEADBAND` (how tightly to hold position),
`ROLL_TILT_COST` (keep it flat), `ENTROPY_COST` and `PHASE1_STEPS` (exploration budget to
*find* the gait — raise these if a retrain plateaus near zero yaw).

## Run health (from the included logs + showcase + DR sweep)

- **Converged & non-falling.** Across the full DR distribution the eval yaw rate settles at
  **~0.21 rad/s**; on the nominal body a clean deterministic rollout turns at **~0.38 rad/s**
  (~1 rev/2.6 s). The nominal rate sitting *above* the DR-averaged rate is the expected
  direction (the DR distribution includes harder bodies) — and, unlike v1, the deterministic
  rollout **agrees with** the curves instead of contradicting them.
- **9-body showcase:** every one of the 9 randomized bodies spins; **zero falls anywhere**,
  including one config deliberately **beyond** the training distribution.
- **DR corner sweep (`dr_sweep_spin.py`):** yaw rate stays in **0.28–0.40 rad/s across all 13
  corners, no falls**. The single worst axis is **CoM offset** (battery-position tolerance) at
  ~0.28 rad/s (79% of nominal); mass, servo gain, friction, and leg length each cost <10%.
- **Plateau / ceiling:** spin rate plateaus at ~0.2 rad/s (across DR) from ~12 M steps on;
  phase 2 held that while tightening position, it didn't add speed. This is very likely a
  **morphology ceiling** — two fore/aft hinges turning by friction while resting on a
  rear-heavy tail — not a reward-tuning gap. Faster/flatter spin is a body-design question.
