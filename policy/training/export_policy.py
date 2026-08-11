"""Export Harsh's 85mm walk policy (.pkl) to plain JSON + verify a pure-numpy
forward pass matches the real JAX inference_fn bit-for-bit. Stage 1 of the
in-browser policy port (no Mac at runtime)."""
import json, numpy as np, jax
from jax import numpy as jnp
from brax.training.agents.ppo import networks as ppo_networks
from brax.training.acme import running_statistics
from brax.io import model

PKL = 'harsh_v2/box_85mm_leg_no_encoder/growbot_ppo_2nd_try_obs_stack_gyro_data_phone_body_85mm20260612-141727.pkl'
params = model.load_params(PKL)
print("params type:", type(params), "len:", len(params) if isinstance(params,(list,tuple)) else 'n/a')

net = ppo_networks.make_ppo_networks(
    16, 2, preprocess_observations_fn=running_statistics.normalize,
    policy_hidden_layer_sizes=(64,64), value_hidden_layer_sizes=(64,64))
inference_fn = jax.jit(ppo_networks.make_inference_fn(net)(params, deterministic=True))
rng = jax.random.PRNGKey(0)

# --- inspect structure ---
norm = params[0]
print("\nnormalizer type:", type(norm).__name__)
for f in ('mean','std','summed_variance','count'):
    v = getattr(norm, f, None)
    if v is not None:
        a = np.array(v)
        print(f"  norm.{f}: shape {a.shape}  sample {np.ravel(a)[:4]}")

policy_params = params[1]
print("\npolicy param leaves:")
leaves = jax.tree_util.tree_flatten_with_path(policy_params)[0]
for path, val in leaves:
    key = '/'.join(str(getattr(p,'key',p)) for p in path)
    print(f"  {key}: {np.array(val).shape}")

# ================= extract =================
mean = np.array(norm.mean, dtype=np.float64)
std  = np.array(norm.std,  dtype=np.float64)
def leaf(name):
    for path, val in leaves:
        key = '/'.join(str(getattr(p,'key',p)) for p in path)
        if key == name: return np.array(val, dtype=np.float64)
    raise KeyError(name)
W0,b0 = leaf('params/hidden_0/kernel'), leaf('params/hidden_0/bias')
W1,b1 = leaf('params/hidden_1/kernel'), leaf('params/hidden_1/bias')
W2,b2 = leaf('params/hidden_2/kernel'), leaf('params/hidden_2/bias')

def swish(x): return x * (1.0/(1.0+np.exp(-x)))
def np_forward(obs):
    x = (np.asarray(obs,dtype=np.float64) - mean) / std       # normalize
    x = swish(x @ W0 + b0)
    x = swish(x @ W1 + b1)
    out = x @ W2 + b2                                         # 4 = loc(2)+scale(2)
    loc = out[:2]
    return np.tanh(loc)                                       # deterministic mode

# ================= verify vs real jax inference_fn =================
def jax_act(obs):
    a,_ = inference_fn(jnp.asarray(obs,dtype=jnp.float32), rng)
    return np.array(a, dtype=np.float64)

# test obs: random across plausible ranges + a real sim rollout
import mujoco
rngnp = np.random.default_rng(0)
obs_set = []
# random obs scaled to each dim's std (so we probe the real operating region)
for _ in range(300):
    obs_set.append(mean + std * rngnp.standard_normal(16))
# extreme obs (saturate tanh)
for _ in range(50):
    obs_set.append(mean + std * rngnp.standard_normal(16)*6)
# a true closed rollout from the sim model
m = mujoco.MjModel.from_xml_path('harsh_v2/box_85mm_leg_no_encoder/growbot_simple_walk.xml')
d = mujoco.MjData(m); hist = np.zeros((5,2))
for _ in range(200):
    w,x,y,z = d.qpos[3],d.qpos[4],d.qpos[5],d.qpos[6]
    roll=np.arctan2(2*(w*x+y*z),1-2*(x*x+y*y)); pitch=np.arcsin(np.clip(2*(w*y-z*x),-1,1)); yaw=np.arctan2(2*(w*z+x*y),1-2*(y*y+z*z))
    obs=np.concatenate([[roll,pitch,yaw],d.qvel[3:6],hist.flatten()])
    obs_set.append(obs.copy())
    a=jax_act(obs); d.ctrl[:]=a
    for _ in range(4): mujoco.mj_step(m,d)
    hist=np.concatenate([a[None],hist[:-1]])

maxerr=0.0; vectors=[]
for obs in obs_set:
    ja=jax_act(obs); na=np_forward(obs)
    e=float(np.max(np.abs(ja-na))); maxerr=max(maxerr,e)
    vectors.append({"obs":[float(v) for v in obs], "action":[float(v) for v in ja]})
print("\n=== numpy-forward vs JAX inference_fn ===")
print(f"  obs tested: {len(obs_set)}  | MAX abs action error: {maxerr:.3e}")
print("  VERDICT:", "MATCH (numpy replicates the trained net)" if maxerr<1e-5 else "MISMATCH — investigate")

if maxerr<1e-5:
    policy = {
      "note":"GrowBot 85mm walk policy. obs16=[roll,pitch,yaw,gyro_r,gyro_p,gyro_y, hist5x2 newest-first]. action=[a_right(a0),a_left(a1)] in [-1,1] treated as radians. forward=tanh((swish(swish(norm(obs)@W0+b0)@W1+b1)@W2+b2)[:2]); norm=(obs-mean)/std.",
      "obs_size":16,"act_size":2,"activation":"swish",
      "mean":[float(v) for v in mean],"std":[float(v) for v in std],
      "layers":[
        {"W":[[float(v) for v in row] for row in W0],"b":[float(v) for v in b0],"act":"swish"},
        {"W":[[float(v) for v in row] for row in W1],"b":[float(v) for v in b1],"act":"swish"},
        {"W":[[float(v) for v in row] for row in W2],"b":[float(v) for v in b2],"act":"linear"}
      ]}
    json.dump(policy, open('policy_85mm.json','w'))
    json.dump(vectors[:120], open('policy_test_vectors.json','w'))
    import os
    print(f"  exported policy_85mm.json ({os.path.getsize('policy_85mm.json')//1024}KB) + {len(vectors[:120])} test vectors")
