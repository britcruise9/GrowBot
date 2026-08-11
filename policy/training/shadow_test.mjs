// Shadow harness: assert the JS forward() matches the recorded JAX actions.
import { readFileSync } from 'node:fs';
import { GrowBotPolicy } from './growbot_policy.js';
const policy = JSON.parse(readFileSync('./policy_85mm.json','utf8'));
const vectors = JSON.parse(readFileSync('./policy_test_vectors.json','utf8'));
const gb = new GrowBotPolicy(policy);
let maxErr=0, worst=null;
for (const v of vectors){
  const js = gb.forward(v.obs);
  const e = Math.max(Math.abs(js[0]-v.action[0]), Math.abs(js[1]-v.action[1]));
  if (e>maxErr){ maxErr=e; worst=v.action; }
}
console.log(`JS-vs-JAX shadow test: ${vectors.length} vectors | MAX abs action error: ${maxErr.toExponential(3)}`);
console.log(maxErr<1e-5 ? "PASS — in-browser policy matches the trained gait" : "FAIL — diverges, do NOT ship");
process.exit(maxErr<1e-5?0:1);
