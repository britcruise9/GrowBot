"""Load a growbot_DR_RMA_train.ipynb checkpoint and watch it walk in the
interactive MuJoCo viewer.

Usage:
    python3 view_policy.py [checkpoint.pkl]

Defaults to DR_RMA_checkpoint/step_60293120.pkl if no path is given.

Notes:
- The policy is deployed exactly as it will run on the real robot: it only
  ever sees `obs['state']` (the non-privileged 10-frame history of
  [roll, pitch, yaw, gyro_xyz, last_action]). The `privileged` key in the obs
  dict is a training-time-only input to the critic and is never read by the
  policy network -- it's included here only because the saved observation
  normalizer was fit on the full dict and expects the same tree structure.
  Its actual values are irrelevant to the action (verified locally: feeding
  it all-zeros vs all-999s produces bit-identical actions).
- Unlike training, this does NOT inject IMU noise, IMU mount misalignment,
  cloud-relay delay/packet-loss, or actuator slew/lag -- this shows the
  policy's clean, nominal behavior on the (also nominal, non-randomized)
  public-rollout body. Domain randomization is what the policy trained
  against, not what you want cluttering a visual sanity check.
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
DEFAULT_CKPT = os.path.join(HERE, "DR_RMA_checkpoint", "step_60293120.pkl")
XML_PATH = os.path.join(HERE, "growbot_public_rollout_body.xml")

# Must match growbot_DR_RMA_train.ipynb's config exactly.
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
    normalizer_params, ppo_net_params = raw[0], raw[1]
    # ppo.train's policy_params_fn saves (normalizer, PPONetworkParams(policy,value));
    # make_policy only wants (normalizer, policy_params).
    params = (normalizer_params, ppo_net_params.policy)

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
    return np.concatenate([[roll, pitch, yaw], gyro, last_action])


def main():
    ckpt_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CKPT
    if not os.path.exists(ckpt_path):
        raise FileNotFoundError(f"Checkpoint not found: {ckpt_path}")
    step_str = os.path.basename(ckpt_path).replace("step_", "").replace(".pkl", "")
    print(f"Loading checkpoint: {ckpt_path}  (step {step_str})")

    infer = load_policy(ckpt_path)
    rng = jax.random.PRNGKey(0)

    print(f"Loading MJCF: {XML_PATH}")
    m = mujoco.MjModel.from_xml_string(open(XML_PATH).read())
    d = mujoco.MjData(m)
    mujoco.mj_resetData(m, d)

    dt_policy = m.opt.timestep * CTRL_HZ_NFRAMES
    print(f"Control rate: {1/dt_policy:.1f} Hz  |  obs: state({STATE_SIZE}) "
          f"privileged({PRIVILEGED_SIZE}, unused-by-policy)  |  actions: {ACT_SIZE}")

    # warm up JIT before the render loop so the first real step isn't laggy
    dummy = {"state": jnp.zeros(STATE_SIZE), "privileged": jnp.zeros(PRIVILEGED_SIZE)}
    infer(dummy, rng)

    obs_hist = np.zeros((HISTORY_LEN, FRAME_DIM))
    obs_hist[0] = proprio_frame(d, np.zeros(2))  # matches env.reset()'s zero-action first frame

    print("Launching viewer (close the window to stop)...")
    with mujoco.viewer.launch_passive(m, d) as viewer:
        viewer.cam.distance = 0.6
        viewer.cam.elevation = -20
        viewer.cam.azimuth = 90

        while viewer.is_running():
            step_start = time.time()

            state_obs = jnp.array(obs_hist.reshape(-1))
            obs = {"state": state_obs, "privileged": jnp.zeros(PRIVILEGED_SIZE)}
            act, _ = infer(obs, rng)
            action_np = np.array(act)

            d.ctrl[:] = action_np
            for _ in range(CTRL_HZ_NFRAMES):
                mujoco.mj_step(m, d)

            new_frame = proprio_frame(d, action_np)
            obs_hist = np.concatenate([new_frame[None, :], obs_hist[:-1]])

            viewer.sync()

            time_left = dt_policy - (time.time() - step_start)
            if time_left > 0:
                time.sleep(time_left)


if __name__ == "__main__":
    main()
