"""Load an olie-body spin-in-place checkpoint and watch it spin in the
interactive MuJoCo viewer, with a live yaw / revolutions / drift readout
printed to the terminal.

Usage:
    python3 view_policy.py [checkpoint.pkl]

Defaults to growbot_spin_v2_DR_RMA_final.pkl (the recommended deploy artifact)
if no path is given. Any checkpoints/phase*/step_*.pkl also works.

Notes:
- This is a SPIN-IN-PLACE policy: it turns the body about the vertical axis
  while holding position, rather than walking forward. It spins CCW (yaw-left,
  SPIN_DIR=+1 in training). For CW, a separate policy must be trained with
  SPIN_DIR=-1 (there is no runtime direction command).
- The policy is deployed exactly as it will run on the real robot: it only
  ever sees `obs['state']` (the non-privileged 10-frame history of
  [roll, pitch, yaw, gyro_xyz, last_action]). The `privileged` key is a
  training-time-only input to the critic and is never read by the policy
  network -- it's included here only because the saved observation normalizer
  was fit on the full dict and expects the same tree structure. Feed zeros(24).
- Unlike training, this does NOT inject IMU noise, IMU mount misalignment,
  cloud-relay delay/packet-loss, or actuator slew/lag -- it shows the policy's
  clean, nominal behavior on the (also nominal, non-randomized) olie body.

- TWO CHECKPOINT FORMATS (load_policy handles both automatically):
    * checkpoints/phase*/step_*.pkl -> 2-tuple (normalizer, PPONetworkParams)
      written by the notebook's save_ckpt callback during training.
    * growbot_spin_v2_DR_RMA_final.pkl / *_phase1_warmup.pkl -> 3-tuple
      (normalizer, policy, value) written by ppo.train()'s own return value.
"""
import os
import sys
import time

import jax
from jax import numpy as jnp
import numpy as np
import mujoco
import mujoco.viewer
from brax.training.agents.ppo import networks as ppo_networks
from brax.training.acme import running_statistics
from brax.io import model

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CKPT = os.path.join(HERE, "growbot_spin_v2_DR_RMA_final.pkl")
XML_PATH = os.path.join(HERE, "growbot_olie_body.xml")

# Must match growbot_olie_spin_in_place_DR_RMA_train_v2.ipynb's config exactly.
HISTORY_LEN = 10
FRAME_DIM = 8          # roll, pitch, yaw, gyro(3), last_action(2)
STATE_SIZE = HISTORY_LEN * FRAME_DIM   # 80
PRIVILEGED_SIZE = 24                   # unused by the policy; see module docstring
ACT_SIZE = 2
CTRL_HZ_NFRAMES = 8    # 25 Hz control (timestep 0.005 * 8 = 0.04s)
POLICY_HIDDEN = (128, 128)
VALUE_HIDDEN = (256, 256)


def load_policy(ckpt_path):
    raw = model.load_params(ckpt_path)
    # Two on-disk layouts (see module docstring):
    #   len==3: (normalizer, policy_params, value_params)  -- *_final.pkl / *_warmup.pkl
    #   len==2: (normalizer, PPONetworkParams(policy,value)) -- step_*.pkl
    # make_policy only wants (normalizer, policy_params) either way.
    if len(raw) == 3:
        params = (raw[0], raw[1])
    else:
        params = (raw[0], raw[1].policy)

    obs_size = {"state": STATE_SIZE, "privileged": PRIVILEGED_SIZE}
    net = ppo_networks.make_ppo_networks(
        obs_size, ACT_SIZE,
        preprocess_observations_fn=running_statistics.normalize,
        policy_hidden_layer_sizes=POLICY_HIDDEN,
        value_hidden_layer_sizes=VALUE_HIDDEN,
        policy_obs_key="state",
        value_obs_key="privileged",
    )
    make_policy = ppo_networks.make_inference_fn(net)
    infer = jax.jit(make_policy(params, deterministic=True))
    return infer


def proprio_frame(d, last_action):
    w, x, y, z = d.qpos[3], d.qpos[4], d.qpos[5], d.qpos[6]
    roll = np.arctan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y))
    pitch = np.arcsin(np.clip(2.0 * (w * y - z * x), -1.0, 1.0))
    yaw = np.arctan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))
    gyro = d.qvel[3:6]
    return np.concatenate([[roll, pitch, yaw], gyro, last_action]), yaw


def main():
    ckpt_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CKPT
    if not os.path.exists(ckpt_path):
        raise FileNotFoundError(f"Checkpoint not found: {ckpt_path}")
    print(f"Loading checkpoint: {ckpt_path}")

    infer = load_policy(ckpt_path)
    rng = jax.random.PRNGKey(0)

    print(f"Loading MJCF: {XML_PATH}")
    m = mujoco.MjModel.from_xml_string(open(XML_PATH).read())
    d = mujoco.MjData(m)
    mujoco.mj_resetData(m, d)

    dt_policy = m.opt.timestep * CTRL_HZ_NFRAMES
    print(f"Control rate: {1/dt_policy:.1f} Hz  |  obs: state({STATE_SIZE}) "
          f"privileged({PRIVILEGED_SIZE}, unused-by-policy)  |  actions: {ACT_SIZE}")
    print("Spin direction: CCW (yaw-left). Close the viewer window to stop.")

    # warm up JIT before the render loop so the first real step isn't laggy
    dummy = {"state": jnp.zeros(STATE_SIZE), "privileged": jnp.zeros(PRIVILEGED_SIZE)}
    infer(dummy, rng)

    obs_hist = np.zeros((HISTORY_LEN, FRAME_DIM))
    frame0, yaw0 = proprio_frame(d, np.zeros(2))
    obs_hist[0] = frame0

    xy0 = np.array(d.qpos[0:2], dtype=float)
    yaw_unwrap, prev_yaw = 0.0, yaw0
    step_i = 0

    with mujoco.viewer.launch_passive(m, d) as viewer:
        # fixed 3/4-elevated view centered on the spawn point (spinning in
        # place needs no chase cam -- rotation is the motion, not translation)
        viewer.cam.distance = 0.5
        viewer.cam.elevation = -30
        viewer.cam.azimuth = 90
        viewer.cam.lookat[:] = [xy0[0], xy0[1], 0.05]

        while viewer.is_running():
            step_start = time.time()

            state_obs = jnp.array(obs_hist.reshape(-1))
            obs = {"state": state_obs, "privileged": jnp.zeros(PRIVILEGED_SIZE)}
            act, _ = infer(obs, rng)
            action_np = np.array(act)

            d.ctrl[:] = action_np
            for _ in range(CTRL_HZ_NFRAMES):
                mujoco.mj_step(m, d)

            new_frame, yaw = proprio_frame(d, action_np)
            obs_hist = np.concatenate([new_frame[None, :], obs_hist[:-1]])

            dyaw = yaw - prev_yaw
            dyaw = (dyaw + np.pi) % (2 * np.pi) - np.pi   # unwrap
            yaw_unwrap += dyaw
            prev_yaw = yaw
            step_i += 1
            if step_i % 25 == 0:   # ~once/sec
                drift = float(np.linalg.norm(np.array(d.qpos[0:2]) - xy0))
                print(f"  t={step_i*dt_policy:5.1f}s  yaw={np.degrees(yaw_unwrap):+7.1f} deg "
                      f"({yaw_unwrap/(2*np.pi):+.2f} rev)  drift={drift:.3f} m", end="\r")

            viewer.sync()

            time_left = dt_policy - (time.time() - step_start)
            if time_left > 0:
                time.sleep(time_left)


if __name__ == "__main__":
    main()
