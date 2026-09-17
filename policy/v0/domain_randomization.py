"""Domain randomization for GrowBot sim-to-real robustness.

Randomizes physics parameters each episode so the trained policy tolerates:
- Floor friction variation (tile vs carpet vs wood)
- Mass/inertia tolerance (battery state, servo manufacturing variance)
- Actuator gain/response delay (servo calibration drift)
- Action latency (real servos don't respond instantly)

Ranges are chosen to match documented hardware specs and real-world conditions.
"""

from __future__ import annotations

import numpy as np
from typing import Dict, Any, Optional

# ---------------------------------------------------------------------------
# Randomization ranges — tuned to GrowBot BOM and real-world variance
# ---------------------------------------------------------------------------

DOMAIN_RANGES = {
    # Floor friction (tangential): hardwood ~0.4-0.6, tile ~0.5-0.8, carpet ~0.7-1.0
    # Nominal is 0.95; we randomize the first component (tangential)
    "friction_tangential": (0.4, 1.2),

    # Mass scale: battery drain (-15% to +10%), manufacturing tolerance
    # Affects all body masses proportionally
    "mass_scale": (0.85, 1.10),

    # Actuator kp gain: servo stiffness varies with temperature/aging
    # Nominal kp = 0.85; real servos can vary ±30%
    "actuator_kp_scale": (0.7, 1.3),

    # Action delay: number of control steps to buffer before applying
    # Real servos have ~2-4 step latency at 50Hz control rate
    # Our env runs 5 sub-steps per action; nominal delay = 0
    "action_delay_steps": (0, 3),

    # Gravity variation: simulates slight floor tilt or uneven weight distribution
    # Nominal -9.81 m/s^2; vary ±3% for slope effects
    "gravity_z_scale": (0.97, 1.03),

    # Joint damping: represents servo internal friction variance
    # Nominal 0.040; real servos can vary significantly
    "joint_damping_scale": (0.6, 1.5),
}


class DomainRandomizer:
    """Applies domain randomization to a MuJoCo model at episode reset.

    Stores nominal values on first call; restores them before each new
    randomization so scaling never compounds across episodes.
    """

    def __init__(self, enabled: bool = True, seed: int | None = None):
        self.enabled = enabled
        self.rng = np.random.default_rng(seed)
        self._current_params: Dict[str, float] = {}
        # Nominal (factory) values — populated on first randomize() call
        self._nominal_friction: Optional[np.ndarray] = None
        self._nominal_mass: Optional[np.ndarray] = None
        self._nominal_gain: Optional[np.ndarray] = None
        self._nominal_damping: Optional[np.ndarray] = None
        self._nominal_gravity: Optional[np.ndarray] = None

    @property
    def current_params(self) -> Dict[str, float]:
        """Return the randomized parameters for the current episode."""
        return dict(self._current_params)

    def _capture_nominals(self, model):
        """Save original parameter values (idempotent)."""
        if self._nominal_friction is not None:
            return  # Already captured
        self._nominal_friction = model.geom_friction[0].copy()
        self._nominal_mass = model.body_mass.copy()
        self._nominal_gain = model.actuator_gainprm[:, 0].copy()
        self._nominal_damping = model.dof_damping.copy()
        self._nominal_gravity = model.opt.gravity.copy()

    def randomize(self, model):
        """Mutate model parameters in-place. Call at each env reset().

        Restores nominals first, then applies fresh randomization.
        """
        self._capture_nominals(model)

        if not self.enabled:
            # Restore nominals even when disabled (undo previous episode's DR)
            self._restore_nominals(model)
            self._current_params = {
                "friction_tangential": float(self._nominal_friction[0]),
                "mass_scale": 1.0,
                "actuator_kp_scale": 1.0,
                "joint_damping_scale": 1.0,
                "gravity_z_scale": 1.0,
                "action_delay_steps": 0,
            }
            return

        # --- Friction ---
        lo, hi = DOMAIN_RANGES["friction_tangential"]
        friction_val = float(self.rng.uniform(lo, hi))

        # --- Mass scale ---
        lo, hi = DOMAIN_RANGES["mass_scale"]
        mass_scale = float(self.rng.uniform(lo, hi))

        # --- Actuator kp scale ---
        lo, hi = DOMAIN_RANGES["actuator_kp_scale"]
        kp_scale = float(self.rng.uniform(lo, hi))

        # --- Joint damping scale ---
        lo, hi = DOMAIN_RANGES["joint_damping_scale"]
        damp_scale = float(self.rng.uniform(lo, hi))

        # --- Gravity scale ---
        lo, hi = DOMAIN_RANGES["gravity_z_scale"]
        grav_scale = float(self.rng.uniform(lo, hi))

        # --- Action delay (applied in env step loop, not model) ---
        lo, hi = DOMAIN_RANGES["action_delay_steps"]
        delay = int(self.rng.integers(lo, hi + 1))

        # Apply: restore nominals first, then scale
        self._restore_nominals(model)

        # Friction: tangential component only (index 0)
        model.geom_friction[0, 0] = friction_val

        # Mass: scale bodies 1..N (skip worldbody id=0 which has mass=0)
        new_mass = self._nominal_mass.copy()
        new_mass[1:] *= mass_scale
        model.body_mass[:] = new_mass

        # Actuator gain: kp is column 0 of gainprm
        model.actuator_gainprm[:, 0] = self._nominal_gain * kp_scale

        # Joint damping: scale leg joints only (dof index 6,7 for joint_left/right)
        # dof 0-5 are free joint (x,y,z + euler x,y,z); dof 6-7 are leg joints
        new_damping = self._nominal_damping.copy()
        new_damping[6:] *= damp_scale
        model.dof_damping[:] = new_damping

        # Gravity: scale z component
        new_gravity = self._nominal_gravity.copy()
        new_gravity[2] *= grav_scale
        model.opt.gravity[:] = new_gravity

        self._current_params.update({
            "friction_tangential": friction_val,
            "mass_scale": mass_scale,
            "actuator_kp_scale": kp_scale,
            "joint_damping_scale": damp_scale,
            "gravity_z_scale": grav_scale,
            "action_delay_steps": delay,
        })

    def _restore_nominals(self, model):
        """Restore factory parameter values."""
        if self._nominal_friction is None:
            return
        model.geom_friction[0] = self._nominal_friction
        model.body_mass[:] = self._nominal_mass
        model.actuator_gainprm[:, 0] = self._nominal_gain
        model.dof_damping[:] = self._nominal_damping
        model.opt.gravity[:] = self._nominal_gravity
