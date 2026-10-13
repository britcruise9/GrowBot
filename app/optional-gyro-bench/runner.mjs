import {seedJoints} from './baseline-runner.mjs';
// EXPERIMENT ONLY. Pure optional-gyro numerical runner; no transport, timers or motor IO.
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const clip=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
export function rawFrame(event,now,sign,maxAgeMs=1000){
 if(!finite(now)||!event||!finite(event.t)||event.t>now||now-event.t>maxAgeMs||![1,-1].includes(sign))throw Error('fresh signed gravity required');
 const ag=event.accelerationIncludingGravity;if(!ag||![ag.x,ag.y,ag.z].every(finite))throw Error('gravity missing');
 const rr=event.rotationRate||{},gt=event.gyroT===undefined?event.t:event.gyroT,gyroFresh=finite(gt)&&gt<=now&&now-gt<=maxAgeMs;
 const keys=['beta','alpha','gamma'],mask=keys.map(k=>Number(gyroFresh&&finite(rr[k]))),sg=[1,-1,1];
 return {gyro:keys.map((k,i)=>mask[i]?rr[k]*Math.PI/180*sg[i]:0),acc:[ag.y*sign,-ag.x*sign,ag.z*sign],mask};
}
export function encode(old,mask){
 if(old.length!==10||mask.length!==3||!mask.every(x=>x===0||x===1)||!old.slice(3).every(finite)||!old.slice(0,3).every((x,i)=>!mask[i]||finite(x)))throw Error('invalid frame');
 return old.map((x,i)=>i<3&&!mask[i]?0:x).concat(mask);
}
export function net(obs,p){
 if(obs.length!==39||!obs.every(finite))throw Error('invalid observation');let x=obs;
 for(let k=0;k<p.layers.length;k++){const l=p.layers[k];x=l.W.map((w,i)=>{let s=l.b[i];for(let j=0;j<w.length;j++)s+=w[j]*x[j];return k<p.layers.length-1?Math.tanh(s):clip(s,-1,1);});}return x;
}
export class Policy{
 constructor(p,cal=p.contract.cal){
  if(p.contract.version!=='optional-gyro-v1'||p.contract.input_count!==39||p.contract.hist!==3||p.contract.control_hz!==25||p.contract.res_deg!==4)throw Error('wrong contract');
  if(!p.layers||p.layers.length!==3||p.layers.some((l,k)=>l.W.length!==[64,64,2][k]||l.b.length!==l.W.length||!l.b.every(finite)||l.W.some(w=>w.length!==[39,64,64][k]||!w.every(finite))))throw Error('bad weights');
  if(cal.SWAP||cal.L_SIGN!==-1||cal.R_SIGN!==-1||cal.gain!==.99||![cal.L_OFF,cal.R_OFF].every(x=>finite(x)&&Math.abs(x)<=45))throw Error('unsupported cal');
  const seed=p.contract.seed;if(!seed||seed.mode!=='stroke'||seed.hz!==1.80969723562966||seed.height!==55||seed.amplitude!==14||seed.duty!==.5||seed.dir!==1)throw Error('seed changed');
  this.p=p;this.cal={...cal};this.cycle=0;this.t=0;this.prev=[0,0];this.frames=null;
 }
 tickBody(g,a,mask){
  if(g.length!==3||a.length!==3||mask.length!==3||!g.every((x,i)=>!mask[i]||finite(x)))throw Error('bad sensors');const ph=2*Math.PI*(((this.cycle%1)+1)%1),f=encode(g.map(x=>clip(x/5,-3,3)).concat(a.map(x=>x/9.81),this.prev,[Math.sin(ph),Math.cos(ph)]),mask);
  this.frames=this.frames?this.frames.slice(1).concat([f]):[f.slice(),f.slice(),f.slice()];const obs=this.frames.slice().reverse().flat(),action=net(obs,this.p),s=this.p.contract.seed;
  this.cycle+=(1/25)*s.hz*s.dir;const joints=seedJoints(s,this.cycle),z=clip(this.t/.7,0,1),ramp=z*z*(3-2*z),c=this.cal;
  const servo=[90+c.L_OFF+c.L_SIGN*(joints[0]*ramp+4*action[0])*c.gain,90+c.R_OFF+c.R_SIGN*(joints[1]*ramp+4*action[1])*c.gain].map(x=>Math.round(clip(x,0,180)));
  this.prev=action;this.t+=1/25;return {obs,action,servo};
 }
}
