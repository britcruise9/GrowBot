"""Interactive MuJoCo viewer for GrowBot.

Usage:
    python3 mujoco-run-growbot-basic.py                        # Passive viewer — physics runs, you watch
    python3 mujoco-run-growbot-basic.py --random               # Random actions to see movement
    python3 mujoco-run-growbot-basic.py --walk                 # Simple sine-wave gait demo
    python3 mujoco-run-growbot-basic.py --policy ppo_policy_v5_5M.zip   # Run trained PPO policy
    python3 mujoco-run-growbot-basic.py --policy checkpoints/ppo_ckpt_3000000_v5.zip  # Specific checkpoint

Controls (passive mode):
    Arrow keys / WASD  — orbit camera
    Q/E                — zoom in/out
    R                  — reset simulation
    Esc                — close viewer
"""
import mujoco
import mujoco.viewer
import numpy as np
import argparse
import os

XML_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "growbot_current_body.xml")


def run_passive():
    """Passive viewer — physics runs with gravity, no control input."""
    model = mujoco.MjModel.from_xml_path(XML_PATH)
    data = mujoco.MjData(model)

    print("GrowBot Passive Viewer")
    print("  R = reset simulation")
    print("  Esc = quit")
    print()

    with mujoco.viewer.launch_passive(model, data) as viewer:
        while viewer.is_running():
            mujoco.mj_step(model, data)
            viewer.sync()


def run_random():
    """Apply random joint commands to see the robot flail around."""
    model = mujoco.MjModel.from_xml_path(XML_PATH)
    data = mujoco.MjData(model)

    print("GrowBot Random Actions")
    print("  Watch it flail — helps verify physics are correct")
    print("  Esc = quit")
    print()

    with mujoco.viewer.launch_passive(model, data) as viewer:
        step_count = 0
        while viewer.is_running():
            # Random positions in [-45°, +45°]
            left_target = np.deg2rad(np.random.uniform(-45, 45))
            right_target = np.deg2rad(np.random.uniform(-45, 45))
            data.ctrl[0] = left_target
            data.ctrl[1] = right_target

            for _ in range(5):
                mujoco.mj_step(model, data)
            viewer.sync()
            step_count += 1


def run_sine_gait(speed=1.0):
    """Simple sine-wave alternating gait — shows what walking *should* look like.

    speed: multiplier for real-time (0.1 = 10x slower, 1.0 = real-time)
    """
    model = mujoco.MjModel.from_xml_path(XML_PATH)
    data = mujoco.MjData(model)

    print(f"GrowBot Sine-Wave Gait Demo (speed={speed}x)")
    print("  Left/right legs oscillate in opposition at ~2 Hz")
    print("  Esc = quit")
    print()

    freq = 2.0          # Hz — gait frequency
    amp_forward = 30.0  # degrees forward swing
    amp_backward = 45.0 # degrees backward swing (more reach back)
    dt = model.opt.timestep

    # Orient robot so front (camera) faces upward at a natural angle.
    # Front of robot = -X in MuJoCo. Rotate ~30° around Y for slight upward tilt.
    quat = np.zeros(4)
    euler = np.array([[0], [np.deg2rad(30)], [0]])  # 30° pitch around Y
    mujoco.mju_euler2Quat(quat, euler, 'xyz')
    data.qpos[3:7] = quat
    data.qpos[2] = 0.0635  # keep body height

    with mujoco.viewer.launch_passive(model, data) as viewer:
        t = 0.0
        import time
        while viewer.is_running():
            t += dt
            # Alternating asymmetric sine waves — left leads right by π (180°)
            # Forward swing: amp_forward, Backward swing: amp_backward
            phase = 2 * np.pi * freq * t
            sin_val = np.sin(phase)
            if sin_val > 0:
                left_angle = np.deg2rad(amp_forward * sin_val)
            else:
                left_angle = np.deg2rad(amp_backward * sin_val)
            
            sin_val_r = np.sin(phase + np.pi)
            if sin_val_r > 0:
                right_angle = np.deg2rad(amp_forward * sin_val_r)
            else:
                right_angle = np.deg2rad(amp_backward * sin_val_r)

            data.ctrl[0] = left_angle
            data.ctrl[1] = right_angle

            mujoco.mj_step(model, data)
            viewer.sync()

            # Slow down: sleep proportional to physics timestep / speed
            if speed < 1.0:
                time.sleep(dt / speed - dt)  # subtract the ~2ms mj_step already took


def run_policy(policy_path):
    """Run a trained PPO policy in the MuJoCo viewer.

    Loads the policy via Stable Baselines 3, creates the GrowBot env,
    and renders each step in the passive viewer with live telemetry.

    Supports both old policies (raw observations) and new policies
    trained with VecNormalize (normalized observations).
    """
    from stable_baselines3 import PPO
    from stable_baselines3.common.vec_env import VecNormalize, DummyVecEnv
    from growbot_env import GrowBotEnv

    # Resolve policy path relative to simulation directory if not absolute
    sim_dir = os.path.dirname(os.path.abspath(__file__))
    if not os.path.isabs(policy_path):
        policy_path = os.path.join(sim_dir, policy_path)

    print(f"Loading policy: {policy_path}")

    # Check if a .pkl normalization file exists alongside the policy.
    # Strip .zip extension before appending .pkl so that both
    # "ppo_policy_v5_best.zip" and "ppo_policy_v5_best" resolve to
    # "ppo_policy_v5_best.pkl" (not "ppo_policy_v5_best.zip.pkl").
    base_path = policy_path[:-4] if policy_path.endswith(".zip") else policy_path
    norm_file = base_path + ".pkl"
    has_normalization = os.path.exists(norm_file)

    try:
        model = PPO.load(policy_path, device="auto")
    except Exception as e:
        print(f"  Failed to load policy: {e}")
        return

    if has_normalization:
        # New training run — wrap env with VecNormalize and load stats
        def make_env():
            return GrowBotEnv(xml_path=XML_PATH, domain_rand=False)

        vec_env = DummyVecEnv([make_env])
        vec_env = VecNormalize.load(norm_file, vec_env)
        vec_env.training = False  # Don't update running stats during eval

        obs = vec_env.reset()
        mujoco_model = vec_env.envs[0].model
        mujoco_data = vec_env.envs[0].data
        print(f"  Loaded with VecNormalize (normalized observations)")
    else:
        # Old policy — raw observations, no normalization
        env_raw = GrowBotEnv(xml_path=XML_PATH, domain_rand=False)
        obs, _ = env_raw.reset(seed=42)
        mujoco_model = env_raw.model
        mujoco_data = env_raw.data
        print(f"  Loaded without VecNormalize (raw observations)")

    # Cold-start fix: small forward velocity nudge prevents initial backward slip
    # The policy needs momentum to find its gait rhythm from rest
    mujoco_data.qvel[0] += 0.025

    basename = os.path.basename(policy_path).replace(".zip", "")
    print(f"\nGrowBot Policy Runner — {basename}")
    print("  R = reset (press in viewer)")
    print("  Esc = quit")
    print()

    step_count = 0
    init_xpos = float(mujoco_data.qpos[0])

    with mujoco.viewer.launch_passive(mujoco_model, mujoco_data) as viewer:
        while viewer.is_running():
            action, _ = model.predict(obs, deterministic=True)

            if has_normalization:
                obs, reward, terms, infos = vec_env.step(action)
                reward_val = float(reward[0])
                terminated = bool(terms[0])
            else:
                obs, reward_val, terminated, truncated, info = env_raw.step(action)

            step_count += 1
            if step_count % 500 == 0:
                current_xpos = float(mujoco_data.qpos[0])
                fwd_vel = float(mujoco_data.qvel[0])
                dist = current_xpos - init_xpos
                print(f"  Step {step_count:>7,d} | "
                      f"fwd_vel: {fwd_vel:+.4f} m/s | "
                      f"dist: {dist:+.4f} m | "
                      f"reward: {reward_val:.2f}")

            if terminated:
                current_xpos = float(mujoco_data.qpos[0])
                dist = current_xpos - init_xpos
                print(f"  Episode ended at step {step_count:,} — distance: {dist:+.4f} m")
                if has_normalization:
                    obs = vec_env.reset()
                else:
                    obs, _ = env_raw.reset(seed=None)
                init_xpos = float(mujoco_data.qpos[0])
                step_count = 0

            viewer.sync()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="GrowBot MuJoCo Viewer")
    parser.add_argument("--random", action="store_true", help="Random actions")
    parser.add_argument("--walk", action="store_true", help="Sine-wave gait demo")
    parser.add_argument("--speed", type=float, default=1.0,
                        help="Speed multiplier for --walk mode (0.1 = 10x slower, default=1.0)")
    parser.add_argument("--policy", type=str, default=None,
                        help="Path to trained PPO policy zip file")
    args = parser.parse_args()

    if args.policy:
        run_policy(args.policy)
    elif args.random:
        run_random()
    elif args.walk:
        run_sine_gait(speed=args.speed)
    else:
        run_passive()
