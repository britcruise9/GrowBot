# The V0 walk policy

The trained walk policy for the **V0** body, plus the simulation setup it was trained in.
This is the thing the [v0 tag](https://github.com/britcruise9/GrowBot/releases/tag/v0) said
was "coming with the next version".

**This is not the policy the live app uses.** That one is V1, one directory up in
[`policy/`](../) — a different body (85 mm legs), a different observation vector, and a
different stack. The two are not interchangeable. Read the contract below before assuming
anything transfers.

## Files

| file | what it is |
|---|---|
| `ppo_policy_v35_final.zip` | the trained weights. Stable-Baselines3 PPO, `policy.pth` inside |
| `ppo_policy_v35_final.pkl` | the **VecNormalize observation statistics** |
| `growbot_env.py` | the Gymnasium environment and the reward function |
| `domain_randomization.py` | the domain randomization used during training |
| `mujoco-run-growbot-basic.py` | runner, loads a policy into the MuJoCo viewer |
| `growbot_body.xml` | the MuJoCo body this policy was trained against |

> **You need both the `.zip` and the `.pkl`.** The `.pkl` is not a second policy, it is the
> observation normalizer. The net was trained on normalized observations, so feeding it raw
> ones produces garbage that looks like a broken policy rather than a loading error.

```bash
python3 mujoco-run-growbot-basic.py --policy ppo_policy_v35_final.zip
```

The runner looks for the `.pkl` beside the `.zip` and wraps the env in `VecNormalize` with it.

## The contract

**Observation, 16 floats:**

| index | meaning |
|---|---|
| 0, 1 | left and right joint position, **degrees** |
| 2, 3 | left and right joint velocity, **degrees/s** |
| 4, 5, 6 | base linear velocity, `qvel[0:3]` |
| 7, 8, 9 | IMU accelerometer |
| 10, 11, 12 | IMU gyro |
| 13 | uprightness, `abs(body_z · world_z)`, 1.0 upright and 0.0 flat on its side |
| 14, 15 | target-relative position, `dx` ahead and `dy` lateral, robot-centric |

**Action, 2 floats:** `[left, right]` joint angle in radians, clipped to ±π/2.

**Net:** 64×64 MLP, separate policy and value heads, `log_std_init=-1.0`.

### Porting this to real hardware

Four of those sixteen numbers are privileged simulator state, and an IMU alone cannot give
them to you:

- **4, 5, 6** come from `qvel`, the simulator's ground-truth base velocity.
- **14, 15** are the offset to a virtual target point that only exists in the trainer. The
  reward chases it, which is how the robot was taught that turning in place earns nothing.

So a port has to estimate those or stub them, and the policy's behaviour depends on what you
choose. That is the honest reason this was never shipped as a drop-in: it walks in
simulation, and closing the last gap to hardware is real work rather than a download. If you
would rather not fight that, the V1 policy one directory up takes only IMU and its own past
actions, all of which a real robot can actually measure.

## Provenance

`v35` is the run that stuck. The reward function in `growbot_env.py` carries its own history
in the comments, including v30 spending 3M steps learning to spin in place because the goal
reward paid out for micro-displacement. v32 onward is the hybrid goal plus anti-spin shaping
that fixed it. The body XML is the measured one, updated 2026-06-18 with the full Pi Zero and
battery BOM at 243 g total, and it is a later revision than the XML published at the v0 tag.

Trained on Stable-Baselines3 2.9.0, PyTorch 2.10, Gymnasium 1.2.2, Python 3.12.

## License

PolyForm Noncommercial 1.0.0, same as the rest of the repository, weights included.
