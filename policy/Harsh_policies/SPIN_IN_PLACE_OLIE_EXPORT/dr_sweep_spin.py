"""DR corner-sweep for a spin-in-place checkpoint: how fast does it spin (or does it
fall/stall) at the edges of the domain-randomization distribution it trained on?

Applies the SAME per-episode randomization formulas as GrowbotSpinEnv._randomize
(mass_scale, CoM offset, leg length, servo gain, friction) directly to a plain
mujoco.MjModel, then runs the DETERMINISTIC policy (what actually deploys) on each
corner body. Nominal-body performance alone (as in render_spin_ckpt_video.py) says
nothing about the worst 10% of real builds -- that's what this checks.

Usage: python3 dr_sweep_spin.py <ckpt.pkl> [n_seconds]
"""
import os, sys
import numpy as np
import jax
from jax import numpy as jnp
import mujoco
from brax.training.agents.ppo import networks as ppo_networks
from brax.training.acme import running_statistics
from brax.io import model

HERE = os.path.dirname(os.path.abspath(__file__))
XML_PATH = os.environ.get("GROWBOT_XML", os.path.join(HERE, "growbot_olie_body.xml"))

HISTORY_LEN, FRAME_DIM = 10, 8
STATE_SIZE = HISTORY_LEN * FRAME_DIM
PRIVILEGED_SIZE = 24
ACT_SIZE = 2
CTRL_HZ_NFRAMES = 8
POLICY_HIDDEN, VALUE_HIDDEN = (128, 128), (256, 256)

# ---- same DR ranges as GrowbotSpinEnv (training-time domain randomization) ----
MASS_SCALE = (0.80, 1.25)
DCOM_X, DCOM_Y, DCOM_Z = (-0.030, 0.030), (-0.015, 0.015), (-0.010, 0.015)
LEG_SHARED = (0.85, 1.15)
GAIN_MULT = (0.75, 1.25)
FRICTION = (0.6, 1.4)


def load_policy(ckpt_path):
    raw = model.load_params(ckpt_path)
    normalizer_params, policy_params = raw[0], raw[1]
    if hasattr(policy_params, "policy"):
        policy_params = policy_params.policy
    params = (normalizer_params, policy_params)
    obs_size = {"state": STATE_SIZE, "privileged": PRIVILEGED_SIZE}
    net = ppo_networks.make_ppo_networks(
        obs_size, ACT_SIZE,
        preprocess_observations_fn=running_statistics.normalize,
        policy_hidden_layer_sizes=POLICY_HIDDEN,
        value_hidden_layer_sizes=VALUE_HIDDEN,
        policy_obs_key="state", value_obs_key="privileged",
    )
    return jax.jit(ppo_networks.make_inference_fn(net)(params, deterministic=True))


def build_model(mass_scale=1.0, dcom=(0.0, 0.0, 0.0), leg_scale=1.0, gain_mult=1.0, friction=None):
    """Apply the same _randomize() formulas GrowbotSpinEnv uses, to a plain MjModel."""
    m = mujoco.MjModel.from_xml_string(open(XML_PATH).read())
    m.opt.solver = mujoco.mjtSolver.mjSOL_CG
    m.opt.iterations, m.opt.ls_iterations = 6, 6

    torso_bid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, "base_body")
    legR_bid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, "right_leg")
    legL_bid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, "left_leg")
    legR_gid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "lower_leg_1")
    legL_gid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "lower_leg_2")

    leg_half_len0 = float(m.geom_size[legR_gid, 2])
    leg_hx = float(m.geom_size[legR_gid, 0])
    leg_hy = float(m.geom_size[legR_gid, 1])
    leg_mass0 = float(m.body_mass[legR_bid])
    torso_ipos0 = np.array(m.body_ipos[torso_bid])

    m.body_mass[:] *= mass_scale
    m.body_inertia[:] *= mass_scale

    for gid, bid in [(legR_gid, legR_bid), (legL_gid, legL_bid)]:
        half = leg_half_len0 * leg_scale
        m.geom_size[gid, 2] = half
        m.geom_pos[gid, 2] = -half
        mm = leg_mass0 * leg_scale * mass_scale
        m.body_mass[bid] = mm
        m.body_ipos[bid, 2] = -half
        a, b, c = 2 * leg_hx, 2 * leg_hy, 2 * half
        m.body_inertia[bid] = [mm / 12.0 * (b*b + c*c), mm / 12.0 * (a*a + c*c), mm / 12.0 * (a*a + b*b)]

    m.body_ipos[torso_bid] = torso_ipos0 + np.array(dcom)
    m.actuator_gainprm[:] *= gain_mult
    m.actuator_biasprm[:] *= gain_mult
    if friction is not None:
        m.geom_friction[:, 0] = friction

    return m


def proprio_frame(d, last_action):
    w, x, y, z = d.qpos[3], d.qpos[4], d.qpos[5], d.qpos[6]
    roll = np.arctan2(2*(w*x + y*z), 1 - 2*(x*x + y*y))
    pitch = np.arcsin(np.clip(2*(w*y - z*x), -1, 1))
    yaw = np.arctan2(2*(w*z + x*y), 1 - 2*(y*y + z*z))
    return np.concatenate([[roll, pitch, yaw], d.qvel[3:6], last_action]), (pitch, yaw)


def rollout(m, infer, n_sec, rng):
    dt_policy = m.opt.timestep * CTRL_HZ_NFRAMES
    fps = round(1 / dt_policy)
    n_settle, n_record = fps, int(n_sec * fps)

    d = mujoco.MjData(m)
    mujoco.mj_resetData(m, d)
    obs_hist = np.zeros((HISTORY_LEN, FRAME_DIM))
    obs_hist[0], _ = proprio_frame(d, np.zeros(2))

    def step():
        obs = {"state": jnp.array(obs_hist.reshape(-1)), "privileged": jnp.zeros(PRIVILEGED_SIZE)}
        act, _ = infer(obs, rng)
        a = np.array(act)
        d.ctrl[:] = a
        for _ in range(CTRL_HZ_NFRAMES):
            mujoco.mj_step(m, d)
        return proprio_frame(d, a)

    for _ in range(n_settle):
        fr, _ = step()
        obs_hist[:] = np.concatenate([fr[None], obs_hist[:-1]])

    xy0 = np.array(d.qpos[0:2], dtype=float)
    nominal_h = 2 * float(m.geom_size[mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "lower_leg_1"), 2])
    yaw_unwrap, prev_yaw, fell = 0.0, None, False
    pitches = []
    for _ in range(n_record):
        fr, (pitch, yaw) = step()
        obs_hist[:] = np.concatenate([fr[None], obs_hist[:-1]])
        if prev_yaw is not None:
            dyaw = yaw - prev_yaw
            dyaw = (dyaw + np.pi) % (2*np.pi) - np.pi
            yaw_unwrap += dyaw
        prev_yaw = yaw
        pitches.append(pitch)
        if d.qpos[2] < 0.4 * nominal_h * 0.5:   # 0.4*nominal_h matches training fall threshold
            fell = True

    drift = float(np.linalg.norm(np.array(d.qpos[0:2]) - xy0))
    return yaw_unwrap / n_sec, drift, np.degrees(np.mean(pitches)), fell


def main():
    ckpt = sys.argv[1]
    n_sec = float(sys.argv[2]) if len(sys.argv) > 2 else 10.0
    infer = load_policy(ckpt)
    rng = jax.random.PRNGKey(0)
    infer({"state": jnp.zeros(STATE_SIZE), "privileged": jnp.zeros(PRIVILEGED_SIZE)}, rng)  # warm JIT

    mlo, mhi = MASS_SCALE
    glo, ghi = GAIN_MULT
    flo, fhi = FRICTION
    llo, lhi = LEG_SHARED

    corners = {
        "nominal":            dict(),
        "mass_max (heavy)":   dict(mass_scale=mhi),
        "mass_min (light)":   dict(mass_scale=mlo),
        "gain_min (weak servo)": dict(gain_mult=glo),
        "gain_max (strong servo)": dict(gain_mult=ghi),
        "friction_min (slick floor)": dict(friction=flo),
        "friction_max (grippy floor)": dict(friction=fhi),
        "leg_min (short legs)": dict(leg_scale=llo),
        "leg_max (long legs)": dict(leg_scale=lhi),
        "dcom_min_corner":    dict(dcom=(DCOM_X[0], DCOM_Y[0], DCOM_Z[0])),
        "dcom_max_corner":    dict(dcom=(DCOM_X[1], DCOM_Y[1], DCOM_Z[1])),
        "WORST-CASE combo":   dict(mass_scale=mhi, gain_mult=glo, friction=flo, leg_scale=llo,
                                    dcom=(DCOM_X[1], DCOM_Y[0], DCOM_Z[1])),
        "best-case combo":    dict(mass_scale=mlo, gain_mult=ghi, friction=fhi, leg_scale=lhi),
    }

    print(f"{'corner':<28}|{'yaw rate rad/s':>15}|{'rev/10s':>9}|{'drift m':>9}|{'mean pitch':>11}|{'fell':>5}")
    print("-" * 84)
    results = {}
    for name, kw in corners.items():
        m = build_model(**kw)
        yr, drift, pitch, fell = rollout(m, infer, n_sec, rng)
        results[name] = yr
        print(f"{name:<28}|{yr:15.4f}|{yr*10/(2*np.pi):9.3f}|{drift:9.3f}|{pitch:10.1f}°|{'YES' if fell else 'no':>5}")

    print()
    nom = results["nominal"]
    worst = min(results.items(), key=lambda kv: kv[1])
    print(f"nominal: {nom:.3f} rad/s | worst corner: '{worst[0]}' @ {worst[1]:.3f} rad/s "
          f"({100*worst[1]/nom:.0f}% of nominal)")


if __name__ == "__main__":
    main()
