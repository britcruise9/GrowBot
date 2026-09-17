"""GrowBot arm-drag locomotion environment for MuJoCo + Gymnasium."""

import collections
import os
from typing import Optional, Tuple

import gymnasium as gym
import mujoco
import numpy as np

from domain_randomization import DomainRandomizer, DOMAIN_RANGES

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
LEFT_JOINT = "joint_left"
RIGHT_JOINT = "joint_right"
BASE_BODY = "base_body"

# ---------------------------------------------------------------------------
# Reward Weights - v32: Hybrid Goal + Anti-Spin (2026-07-15)
#
# v30 FAILED — spent 3M steps spinning. Root cause: exponential decay goal reward
# gave dense reward even from micro-displacement during spinning (~3.4/step at 40cm).
# Combined with gait alternation (gated on delta_x>0, which spinning satisfies via
# micro-forward drift) and survival, spinning earned positive net reward.
#
# v31 FAILED — std exploded to 24.5, KL≈0 at 1.7M steps. Root cause: sparse thresholded
# reward gave zero gradient during early exploration. Policy had no signal to learn direction.
#
# v32 fixes (HYBRID approach):
#   - Dense guide: GOAL_DENSE_W=2.0 × max(0, dist_delta) — small reward for ANY progress
#     Gives gradient signal for direction finding without enabling spinning exploit
#   - Sparse lock: GOAL_SPARSE_W=25.0 × ((dist_delta - 2cm)/2cm) — only fires on genuine progress
#     Prevents spinning from earning meaningful reward
#   - YAW_PENALTY_W: 50 with deadzone below 0.3 rad/s (normal motion exempt)
#   - GAIT_ALT gate: delta_x > GOAL_PROGRESS_THRESH (same 2cm threshold)
#
# Lesson #50: Dense rewards create dense exploits.
# Lesson #51: Sparse rewards starve early learning. Hybrid is the answer.
# Lesson #52: Anti-spin penalty needs deadzone — normal motion is punished too.

HEIGHT_TARGET_W     = 0.5
UPRIGHT_W           = 1.0
GOAL_DENSE_W        = 10.0   # v32b: strong dense guide — meaningful gradient for direction finding
GOAL_SPARSE_W       = 25.0   # large sparse lock — only fires on genuine progress
GOAL_INITIAL_DIST   = 0.40   # target starts 40cm ahead (-X direction)
GOAL_RESPAWN_DIST   = 0.15   # respawn when robot gets within 15cm
GOAL_RESPAWN_STEP   = 0.30   # move target 30cm further on respawn
GOAL_PROGRESS_THRESH = 0.005  # v32b: lowered from 2cm to 5mm — reachable during early exploration
GAIT_ALT_W          = 10.0   # kept from v28 - gait alternation reward
GAIT_SYNC_W         = 10.0
JOINT_HUNT_W        = 20.0
LEG_RANGE_PENALTY_W = 8.0
LEG_RANGE_FLOOR_DEG = 20.0
LEG_RANGE_HIST_LEN  = 50

CTRL_EFFORT_W       = 0.003
ANG_VEL_PENALTY_W   = 0.02
YAW_PENALTY_W       = 50.0   # v31: raised from 30 — deadzone below 0.3 rad/s
JOINT_LIMIT_W       = 3.0
ACCELERATION_W      = 0.05

SURVIVAL_REWARD     = 0.5    # v27: stays un-gated - only fully accessible reward
SURVIVAL_MIN_VEL    = 0.005
REST_PENALTY        = 0.5    # still active - makes true idleness costly

TARGET_HEIGHT       = 0.0635
TARGET_FORWARD_VEL  = 0.04
JOINT_LIMIT_SOFT    = 70.0

# Done condition: body too tilted or fallen
MAX_TILT_ANGLE      = np.deg2rad(85)  # ~85 degrees (more lenient)
MIN_HEIGHT          = 0.005           # very low threshold


class GrowBotEnv(gym.Env):
    """MuJoCo arm-drag locomotion env.

    Observation (14-D):
        [joint_left_pos_deg, joint_right_pos_deg,
         joint_left_vel_deg, joint_right_vel_deg,
         base_vx, base_vy, base_vz,
         acc_x, acc_y, acc_z,
         gyro_x, gyro_y, gyro_z,
         uprightness]                    # |body_z · world_z| ∈ [0, 1]

    Action (2-D): target joint positions for left and right servos, clamped to [-90°, 90°].
    """

    metadata = {"render_modes": [None], "render_fps": 50}

    def __init__(self, xml_path: str, render_mode: Optional[str] = None,
                 domain_rand: bool = True):
        super().__init__()

        self.xml_path = os.path.abspath(xml_path)
        self.model = mujoco.MjModel.from_xml_path(self.xml_path)
        self.data = mujoco.MjData(self.model)
        # Alias for external access (tests, rllib callbacks)
        self.d = self.data
        self.render_mode = render_mode

        # Resolve joint indices via MuJoCo 3.x API
        left_jnt = self.model.jnt(LEFT_JOINT)
        right_jnt = self.model.jnt(RIGHT_JOINT)
        self.left_qposadr = int(left_jnt.qposadr[0])
        self.right_qposadr = int(right_jnt.qposadr[0])
        self.left_dofadr = int(left_jnt.dofadr[0])
        self.right_dofadr = int(right_jnt.dofadr[0])

        # Body id for xmat access (uprightness metric)
        self.body_id = self.model.body(BASE_BODY).id

        # Domain randomization - Phase B4
        self.domain_rand = DomainRandomizer(enabled=domain_rand)
        # Action delay buffer (ring buffer for delayed control application)
        self._action_delay_steps = 0
        self._action_buffer: list[np.ndarray] = []
        # v16: rolling per-leg position history for range penalty
        self._left_pos_hist: collections.deque = collections.deque(maxlen=LEG_RANGE_HIST_LEN)
        self._right_pos_hist: collections.deque = collections.deque(maxlen=LEG_RANGE_HIST_LEN)
        # v19: rolling per-leg velocity history for gait alternation reward
        GAIT_VEL_HIST_LEN = 20  # steps to analyze for phase correlation
        self._left_vel_hist: collections.deque = collections.deque(maxlen=GAIT_VEL_HIST_LEN)
        self._right_vel_hist: collections.deque = collections.deque(maxlen=GAIT_VEL_HIST_LEN)
        # v30: goal-conditioned training - target position state
        self._target_pos = np.zeros(3, dtype=np.float32)
        self._start_xpos = 0.0

        # Observation: 16-D with explicit bounds for rllib observation filter (v30: +dx, dy to target)
        obs_dim = 16

        self.observation_space = gym.spaces.Box(
            low=np.array([
                -90., -90.,    # joint pos (degrees)
                -360., -360.,  # joint vel (deg/s)
                -5., -5., -5., # base linear vel
                -20., -20., -20., # acc
                -10., -10., -10., # gyro
                -1.,            # quat w
                -5., -5.,       # dx, dy to target (v30)
            ], dtype=np.float32),
            high=np.array([
                90., 90.,
                360., 360.,
                5., 5., 5.,
                20., 20., 20.,
                10., 10., 10.,
                1.,
                5., 5.,         # dx, dy to target (v30)
            ], dtype=np.float32),
        )
        # Action: target positions for two joints (radians)
        # v8: restored to full ±90° - the ±45° limit was too narrow and
        # contributed to boundary-hugging collapse. The actuators in MuJoCo
        # have their own kp/forcerange limits so the policy won't overshoot
        # physically even if it requests extreme angles.
        self.action_space = gym.spaces.Box(
            low=-np.pi / 2, high=np.pi / 2, shape=(2,), dtype=np.float32
        )

    # ------------------------------------------------------------------ reset
    def reset(self, seed: Optional[int] = None, options=None) -> Tuple[np.ndarray, dict]:
        super().reset(seed=seed)

        # Domain randomization - vary physics per episode (Phase B4)
        self.domain_rand.randomize(self.model)
        dr_params = self.domain_rand.current_params
        self._action_delay_steps = int(dr_params.get("action_delay_steps", 0))
        self._action_buffer = []

        mujoco.mj_resetData(self.model, self.data)
        # v32: Orient robot so front (camera) faces upward at ~30° — matches viewer --walk mode.
        # Front of robot = -X in MuJoCo. Rotate ~30° around Y for slight upward tilt.
        # This gives the correct starting posture for arm-drag locomotion.
        quat = np.zeros(4)
        euler = np.array([[0], [np.deg2rad(30)], [0]])  # 30° pitch around Y
        mujoco.mju_euler2Quat(quat, euler, 'xyz')
        self.data.qpos[3:7] = quat
        # Start upright with small random perturbation for robustness
        if seed is not None:
            rng = np.random.default_rng(seed)
            self.data.qpos[7] += rng.normal(0, 0.05)   # left joint offset
            self.data.qpos[8] += rng.normal(0, 0.05)   # right joint offset
        mujoco.mj_forward(self.model, self.data)
        self._last_xpos = float(self.data.qpos[0])  # Initialize x-position tracker
        self._last_ctrl = np.zeros(2, dtype=np.float32)  # Initialize for acceleration penalty
        # v30: place target ahead of robot (front = -X in MuJoCo)
        self._start_xpos = float(self.data.qpos[0])
        self._target_pos[0] = self._start_xpos - GOAL_INITIAL_DIST  # ahead along -X
        self._target_pos[1] = float(self.data.qpos[1])              # same Y (straight ahead)
        self._target_pos[2] = 0.0                                   # floor level (ignored)
        # v16: clear per-leg position history on episode reset
        self._left_pos_hist.clear()
        self._right_pos_hist.clear()
        # v19: clear velocity history for gait tracking
        self._left_vel_hist.clear()
        self._right_vel_hist.clear()
        info = {"domain_randomization": dr_params}
        return self._get_obs(), info

    # ------------------------------------------------------------------ step
    def step(
        self, action: np.ndarray
    ) -> Tuple[np.ndarray, float, bool, bool, dict]:
        action = np.clip(action, -np.pi / 2, np.pi / 2).astype(np.float32)

        # Action delay buffer - simulates servo response latency (Phase B4)
        if self._action_delay_steps > 0:
            self._action_buffer.append(action.copy())
            if len(self._action_buffer) > self._action_delay_steps:
                applied_action = self._action_buffer.pop(0)
            else:
                applied_action = np.zeros_like(action)
        else:
            applied_action = action

        self.data.ctrl[:] = applied_action
        # Run multiple sub-steps for stability (timestep=0.002, run 5 steps = 10ms per env step)
        for _ in range(5):
            mujoco.mj_step(self.model, self.data)

        obs = self._get_obs()
        reward = self._compute_reward(obs)
        terminated = self._check_done()
        truncated = False
        return obs, float(reward), terminated, truncated, {}

    # ------------------------------------------------------------------ obs
    def _get_obs(self) -> np.ndarray:
        """Return 16-D observation vector (v30: added target-relative position)."""
        qpos = self.data.qpos.copy()
        qvel = self.data.qvel.copy()

        obs = np.empty(16, dtype=np.float32)
        # Joint positions (radians -> degrees for readability)
        obs[0] = float(np.rad2deg(qpos[self.left_qposadr]))
        obs[1] = float(np.rad2deg(qpos[self.right_qposadr]))
        # Joint velocities
        obs[2] = float(np.rad2deg(qvel[self.left_dofadr]))
        obs[3] = float(np.rad2deg(qvel[self.right_dofadr]))
        # Base linear velocity (qvel[0:3])
        obs[4:7] = qvel[0:3].astype(np.float32)
        # IMU accelerometer from sensor data
        obs[7:10] = self.data.sensordata[0:3].astype(np.float32)
        # IMU gyro from sensor data
        obs[10:13] = self.data.sensordata[3:6].astype(np.float32)
        # Uprightness: |body_z · world_z| from xmat (1.0 = perfectly upright, 0.0 = flat on side)
        body_z_axis = self.data.xmat[self.body_id].reshape(3, 3)[2]
        obs[13] = float(abs(body_z_axis[2]))
        # v30: relative position to target (robot-centric coordinates)
        robot_x = float(self.data.qpos[0])
        robot_y = float(self.data.qpos[1])
        obs[14] = float(self._target_pos[0] - robot_x)  # dx (positive = target ahead along -X)
        obs[15] = float(self._target_pos[1] - robot_y)  # dy (lateral offset)
        return obs

    # ------------------------------------------------------------------ reward
    def _compute_reward(self, obs: np.ndarray) -> float:
        """Reward function v30 — Goal-Conditioned Training.

        The robot chases a virtual target point placed ahead (-X direction).
        Distance to target IS the outcome — not a proxy. Spinning doesn't reduce distance.
        Only honest forward displacement does.

        Key changes from v29:
        - FORWARD_VEL_W, PROGRESS_W, THRUST_PROXY_W → replaced by GOAL_W (distance-based)
        - PITCH_ORIENT_W → dropped; generic uprightness restored for fresh start
        - Observation space extended to 16D with dx, dy to target
        """
        qpos = self.data.qpos.copy()
        qvel = self.data.qvel.copy()

        # Camera hole at STL Y≈-65mm (negative Y=front). STL Y→MuJoCo X.
        # So front of robot = -X in MuJoCo. Negate to make +fwd_vel = toward camera.
        fwd_vel = -qvel[0]
        left_vel = qvel[self.left_dofadr]
        right_vel = qvel[self.right_dofadr]

        # ---- Goal-conditioned reward (v32) — HYBRID: dense guide + sparse lock ----
        # v30: dense exponential → spinning exploit earned ~3.4/step at 40cm
        # v31: sparse thresholded → zero gradient during early exploration, std exploded to 24.5
        # v32: small dense component guides direction finding, large sparse component locks in progress
        robot_x = float(self.data.qpos[0])
        robot_y = float(self.data.qpos[1])
        dist_to_target = np.sqrt(
            (self._target_pos[0] - robot_x) ** 2 +
            (self._target_pos[1] - robot_y) ** 2
        )
        # Dense guide: small reward for ANY movement toward target (gives gradient signal)
        prev_dist = getattr(self, '_prev_dist_to_target', dist_to_target)
        dist_delta = prev_dist - dist_to_target  # positive = got closer
        self._prev_dist_to_target = dist_to_target
        dense_guide = GOAL_DENSE_W * max(0.0, dist_delta)  # small weight, always fires on progress
        # Sparse lock: large reward only for genuine progress (prevents spinning exploit)
        if dist_delta > GOAL_PROGRESS_THRESH:
            sparse_lock = GOAL_SPARSE_W * ((dist_delta - GOAL_PROGRESS_THRESH) / GOAL_PROGRESS_THRESH)
        else:
            sparse_lock = 0.0
        goal_reward = dense_guide + sparse_lock

        # Respawn target when robot gets close enough — creates infinite curriculum
        if dist_to_target < GOAL_RESPAWN_DIST:
            self._target_pos[0] -= GOAL_RESPAWN_STEP  # move further along -X
            # Keep same Y (straight ahead) — no lateral movement for P1

        # ---- Secondary rewards ----

        # Height tracking: Gaussian
        body_height = qpos[2]
        height_err = abs(body_height - TARGET_HEIGHT)
        height_reward = HEIGHT_TARGET_W * np.exp(-8.0 * height_err ** 2)

        # Uprightness: generic body_z vertical reward (simplified for fresh start)
        body_z_axis = self.data.xmat[self.body_id].reshape(3, 3)[2]
        upright_reward = UPRIGHT_W * abs(body_z_axis[2])

        # Joint velocity magnitude (used by survival and gait checks below)
        _joint_vel_mag = abs(left_vel) + abs(right_vel)

        # Gait alternation reward (v31: gated on meaningful forward displacement)
        # v30 gate was delta_x > 0 — spinning produced micro-forward drift that passed.
        # Now requires GOAL_PROGRESS_THRESH (2cm) of actual forward movement.
        self._left_vel_hist.append(left_vel)
        self._right_vel_hist.append(right_vel)
        gait_reward = 0.0
        if len(self._left_vel_hist) >= 15:
            left_recent = np.array(list(self._left_vel_hist), dtype=np.float32)
            right_recent = np.array(list(self._right_vel_hist), dtype=np.float32)
            phase_corr = np.corrcoef(left_recent, -right_recent)[0, 1]
            # Gate on meaningful displacement — spinning produces mm-level drift only
            current_xpos = float(self.data.qpos[0])
            delta_x = -(current_xpos - getattr(self, '_last_xpos', current_xpos))
            if not np.isnan(phase_corr) and delta_x > GOAL_PROGRESS_THRESH:  # v32b: 5mm threshold
                gait_reward = GAIT_ALT_W * max(0.0, phase_corr)

        # Gait sync penalty — penalizes simultaneous actuation (both legs same direction)
        gait_penalty = 0.0
        if fwd_vel > 0 and left_vel * right_vel > 0:  # same sign = simultaneous
            gait_penalty = -GAIT_SYNC_W * min(abs(left_vel), abs(right_vel))

        # Per-leg range penalty (v17: floor increased to 20°)
        self._left_pos_hist.append(obs[0])
        self._right_pos_hist.append(obs[1])
        if len(self._left_pos_hist) >= 10:
            left_range  = float(max(self._left_pos_hist)) - float(min(self._left_pos_hist))
            right_range = float(max(self._right_pos_hist)) - float(min(self._right_pos_hist))
            left_deficit  = max(0.0, LEG_RANGE_FLOOR_DEG - left_range)
            right_deficit = max(0.0, LEG_RANGE_FLOOR_DEG - right_range)
            leg_range_penalty = -LEG_RANGE_PENALTY_W * (left_deficit + right_deficit) / LEG_RANGE_FLOOR_DEG
        else:
            leg_range_penalty = 0.0

        # ---- Penalties ----

        ctrl_effort = CTRL_EFFORT_W * float(np.sum(self.data.ctrl ** 2))

        ang_vel_x = self.data.sensordata[3]
        ang_vel_z = self.data.sensordata[5]
        ang_vel_penalty = ANG_VEL_PENALTY_W * ang_vel_x ** 2

        # v31: Yaw penalty with deadzone — normal motion (<0.3 rad/s) exempt,
        # spinning (>0.5 rad/s) gets catastrophic penalty
        abs_yaw = abs(ang_vel_z)
        if abs_yaw > 0.3:
            yaw_excess = abs_yaw - 0.3
            yaw_penalty = YAW_PENALTY_W * yaw_excess ** 2
        else:
            yaw_penalty = 0.0

        left_pos = obs[0]
        right_pos = obs[1]
        joint_limit_penalty = 0.0
        for pos in [left_pos, right_pos]:
            if abs(pos) > JOINT_LIMIT_SOFT:
                excess = abs(pos) - JOINT_LIMIT_SOFT
                joint_limit_penalty += (excess / 15.0) ** 2
        joint_limit_penalty *= JOINT_LIMIT_W

        accel_penalty = ACCELERATION_W * float(np.sum((self.data.ctrl - getattr(self, '_last_ctrl', self.data.ctrl)) ** 2))
        self._last_ctrl = self.data.ctrl.copy()

        # Track x-position for gait gate (reused above)
        current_xpos = float(self.data.qpos[0])
        self._last_xpos = current_xpos

        # Compute actuator effort (used by rest penalty and joint-hunt penalty below)
        avg_actuator_effort = float(np.mean(np.abs(self.data.ctrl)))

        # Survival: v27 un-gated from fwd_vel — fires when ANY joint is moving.
        survival = SURVIVAL_REWARD if _joint_vel_mag > 0.2 else 0.0
        # Rest penalty: subtracted every step when robot is truly idle
        rest_penalty = REST_PENALTY if avg_actuator_effort < 0.1 else 0.0

        # v20: Joint-limit hunting penalty (Lesson #28)
        joint_hunt_penalty = 0.0
        if avg_actuator_effort < 0.3:  # low effort — not genuinely actuating
            for pos in [left_pos, right_pos]:
                if abs(pos) > JOINT_LIMIT_SOFT:
                    excess = abs(pos) - JOINT_LIMIT_SOFT
                    joint_hunt_penalty += (excess / 15.0) ** 2
            joint_hunt_penalty *= JOINT_HUNT_W

        # Total — v30: goal-conditioned primary signal
        reward = (goal_reward + height_reward + upright_reward
                  + gait_reward + gait_penalty + leg_range_penalty
                  + survival
                  - ctrl_effort - ang_vel_penalty - yaw_penalty
                  - joint_limit_penalty - accel_penalty - joint_hunt_penalty
                  - rest_penalty)
        return float(reward)

    # ------------------------------------------------------------------ done
    def _check_done(self) -> bool:
        body_z_axis = self.data.xmat[self.body_id].reshape(3, 3)[2]
        uprightness = abs(body_z_axis[2])
        body_height = self.data.qpos[2]
        # Fallen: too tilted (uprightness < cos(60°) = 0.5)
        if uprightness < np.cos(MAX_TILT_ANGLE):
            return True
        if body_height < MIN_HEIGHT:
            return True
        return False

    # ------------------------------------------------------------------ v16 helpers
    def enable_domain_rand(self):
        """Enable domain randomization - called by DrDelayCallback at 1M steps."""
        self.domain_rand.enabled = True

    # ------------------------------------------------------------------ render
    def render(self):
        renderer = mujoco.Renderer(self.model)
        renderer.update_scene(self.data)
        return renderer.render()


# ---------------------------------------------------------------------------
# Gymnasium registration (for rllib parallel workers)
# ---------------------------------------------------------------------------
def _make_env(xml_path: str, **kwargs):
    def env_fn():
        return GrowBotEnv(xml_path=xml_path, **kwargs)
    return env_fn


try:
    gym.register(
        id="GrowBot-v0",
        entry_point=_make_env("growbot_current_body.xml"),
        max_episode_steps=1000,
    )
except Exception:
    pass  # Already registered or not needed
