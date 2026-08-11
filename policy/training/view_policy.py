import time
import jax
from jax import numpy as jnp
import numpy as np
import mujoco
import mujoco.viewer
from brax import envs
from brax.training.agents.ppo import networks as ppo_networks
from brax.training.acme import running_statistics
from brax.io import model

# --- 1. SET YOUR WEIGHTS PATH HERE ---
WEIGHTS_PATH = 'growbot_ppo_2nd_try_obs_stack_gyro_data_phone_body_85mm20260612-141727.pkl'  # Update this with your NEW checkpoint file!

# --- 2. The MJCF XML (Updated to 85mm box legs & wider torso) ---
XML_STRING = """
<mujoco model="Growbot">
  <option gravity="0 0 -9.81" timestep="0.005" integrator="RK4" solver="CG" iterations="10" ls_iterations="10"/>

  <default>
    <geom friction="1.2 0.1 0.1" solref="0.005 1" solimp="0.99 0.99 0.01" condim="3"/>
    <joint damping="0.03" armature="0.002"/>
    <position kp="0.75" kv="0.05" ctrlrange="-1.57 1.57" forcerange="-1.5 1.5"/>
  </default>

  <worldbody>
    <light name="sun" pos="0 0 3" dir="0 0 -1" diffuse="0.8 0.8 0.8" specular="0.2 0.2 0.2" castshadow="true"/>
    <geom name="floor" type="plane" size="0 0 0.05" rgba="0.76 0.87 0.70 1"/>

    <body name="base_body" pos="0 0 0.3">
      <joint name="root_joint" type="free"/>
      <geom name="torso_geom" type="box" size="0.0825 0.045 0.012" mass="0.3" rgba="0.7 0.7 0.7 1"/>

      <body name="right_leg" pos="0 -0.048 0">
        <joint name="joint_1" type="hinge" axis="0 1 0" limited="true" range="-90 90" />
        <geom name="lower_leg_1" type="box" size="0.0105 0.0065 0.0425" pos="0 0 -0.0425" mass="0.03" rgba="0.2 0.2 0.8 1"/>
      </body>

      <body name="left_leg" pos="0 0.048 0">
        <joint name="joint_2" type="hinge" axis="0 1 0" limited="true" range="-90 90" />
        <geom name="lower_leg_2" type="box" size="0.0105 0.0065 0.0425" pos="0 0 -0.0425" mass="0.03" rgba="0.2 0.2 0.8 1"/>
      </body>
    </body>
  </worldbody>

  <actuator>
    <position name="servo_1" joint="joint_1"/>
    <position name="servo_2" joint="joint_2"/>
  </actuator>
</mujoco>
"""

# --- 3. Load the Model and Rebuild the Policy ---
print("Loading weights and compiling policy...")
params = model.load_params(WEIGHTS_PATH)

# NEW: Observation size is now 16 (3 Angles + 3 Gyro + 10 History)
obs_size = 16
act_size = 2

# Recreate the normalizer
normalize_fn = running_statistics.normalize

# Rebuild the exact network architecture
ppo_network = ppo_networks.make_ppo_networks(
    obs_size,
    act_size,
    preprocess_observations_fn=normalize_fn,
    policy_hidden_layer_sizes=(64, 64),
    value_hidden_layer_sizes=(64, 64)
)

make_policy = ppo_networks.make_inference_fn(ppo_network)
inference_fn = jax.jit(make_policy(params, deterministic=True))
rng = jax.random.PRNGKey(0)

# --- 4. Setup MuJoCo and Viewer ---
m = mujoco.MjModel.from_xml_string(XML_STRING)
d = mujoco.MjData(m)

# Training hyperparams
n_frames = 4
dt_policy = m.opt.timestep * n_frames  # 0.02 seconds per policy step

print("Launching viewer...")
with mujoco.viewer.launch_passive(m, d) as viewer:
    
    viewer.cam.distance = 1.0
    viewer.cam.elevation = -20
    
    # Run a dummy inference step to pre-compile JAX
    dummy_obs = jnp.zeros(obs_size)
    inference_fn(dummy_obs, rng)
    
    # NEW: Initialize the 5-frame action history matrix
    action_history = np.zeros((5, 2))

    while viewer.is_running():
        step_start = time.time()

        # --- THE NEW SIM2REAL OBSERVATION LOGIC ---
        
        # 1. IMU: Extract and convert quaternion to Euler
        w, x, y, z = d.qpos[3], d.qpos[4], d.qpos[5], d.qpos[6]
        roll = np.arctan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y))
        pitch = np.arcsin(np.clip(2.0 * (w * y - z * x), -1.0, 1.0))
        yaw = np.arctan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))
        imu_angles = np.array([roll, pitch, yaw])
        
        # 2. Gyroscope: Angular velocity
        gyro = d.qvel[3:6]
        
        # 3. Concatenate and pass to JAX (Resulting in a 16-element array)
        obs = np.concatenate([imu_angles, gyro, action_history.flatten()])
        obs_jax = jnp.array(obs)
        
        # -------------------------------------------

        # Ask the AI for an action
        act, _ = inference_fn(obs_jax, rng)
        action_np = np.array(act)

        # Apply the action to the servos
        d.ctrl[:] = action_np

        # Step the physics engine `n_frames` times
        for _ in range(n_frames):
            mujoco.mj_step(m, d)
        
        # NEW: Update the action history stack 
        # (Expands the new action, puts it at index 0, and drops the 5th oldest action)
        action_history = np.concatenate([np.expand_dims(action_np, 0), action_history[:-1]])
        
        # Sync the viewer to update the 3D graphics
        viewer.sync()

        # Throttle the loop to run in real-time
        time_until_next_step = dt_policy - (time.time() - step_start)
        if time_until_next_step > 0:
            time.sleep(time_until_next_step)