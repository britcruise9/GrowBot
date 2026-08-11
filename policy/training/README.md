# Training the walk policy

The complete pipeline that produced the shipped walk policy, as one worked example. Train in simulation, export to JSON, verify against the JS runner, swap it into your robot.

The official 85 mm policy came out of exactly this loop, with sim tuning by community builder Harsh Dadwal.

## The loop

1. **Train**: `simple_walk.ipynb`. Runs in Google Colab (free GPU works, bigger is faster). MuJoCo + Brax PPO on the GrowBot body model. The MJCF body is inline, tweak legs, friction, and rewards there.
2. **Watch it**: `view_policy.py` + `growbot_simple_walk.xml`. Opens a MuJoCo viewer on your machine and plays a checkpoint. Point `WEIGHTS_PATH` at your `.pkl`.
3. **Export**: `export_policy.py` turns the Brax `.pkl` checkpoint into the plain-JSON weights format the runner uses.
4. **Verify**: `node shadow_test.mjs` proves your exported JSON gives bit-identical outputs (within 2e-6) to the trained net, using `policy_test_vectors.json`.
5. **Run it**: drop your JSON in place of `../policy_85mm.json`. Same 16-obs contract, see [../README.md](../README.md).

## Starting point

`growbot_ppo_2nd_try_obs_stack_gyro_data_phone_body_85mm20260612-141727.pkl` is the official trained checkpoint (44 KB). Fine tune from it or train from scratch.

## What would help most

Better sim-to-real. The current gap: the walk that scores well in sim is more conservative on real hardware, and grass or carpet defeats it. Domain randomization over friction, mass, servo strength, and sensor noise is the obvious lever and PRs there are very welcome. If you train something that walks better, open a PR with your `.pkl` + exported JSON + a clip of real hardware.

License: PolyForm Noncommercial 1.0.0, same as the rest of the code.
