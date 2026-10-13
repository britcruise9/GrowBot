/* Runtime selection is per walk, from actual readings, never a phone-model table.
   Reuses the exact numerical policy and measured-gravity collector exercised on the bench. */
import {Policy} from './optional-gyro-bench/runner.mjs';
import {Sensors} from './optional-gyro-bench/sensors.mjs';
const root=typeof window==='undefined'?globalThis:window;
const SHA='aa136d27272e63452068883cb9578026fd167e4ee472054a672863ead14b3b45';
function basic(){if(!root.GBForwardBasic)throw Error('Gravity walk adapter is not loaded');return root.GBForwardBasic;}
function live(){if(!root.GBForwardWalk)throw Error('Forward walk adapter is not loaded');return root.GBForwardWalk;}
function diagnostic(s,now,sign,info){const d=basic().diagnostic(s,now,sign,info);if(d.ok&&now-s.t>250){d.ok=false;d.code='motion_stale';d.message='Fresh gravity readings are required. Keep this page visible.';}return d;}
function frame(s,now,sign,info){const d=diagnostic(s,now,sign,info);if(!d.ok){const e=Error(d.message);e.code=d.code;throw e;}return basic().frame(s,now,sign,info);}
async function load(fetcher,cryptoAPI){
 const [source,response]=await Promise.all([live().load(fetcher,cryptoAPI),fetcher('/optional-gyro-bench/specialist.json')]);
 if(!response.ok)throw Error('No-gyro forward policy unavailable');const bytes=await response.arrayBuffer();
 const hash=Array.from(new Uint8Array(await cryptoAPI.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
 if(hash!==SHA)throw Error('No-gyro policy changed; reload');return {source,model:JSON.parse(new TextDecoder().decode(bytes))};
}
function Controller(p,c,s,now){
 frame(s,now,s&&s.sign);const controller=new (basic().Controller)(p.source,c,s,now),policy=new Policy(p.model,controller.cal);
 let measured=frame(s,now,controller.sign),tick=controller.tick;
 controller.policy={tickBody:()=>policy.tickBody([0,0,0],measured.acc,[0,0,0])};
 controller.tick=function(sample,time,cal){measured=frame(sample,time,this.sign);return tick.call(this,sample,time,cal);};return controller;
}
export const noGyro={ID:'growbot-forward-nogyro-specialist-1001',SHA,NO_GYRO:true,LABEL:'screen-forward without gyro',diagnostic,frame,load,Controller,
 calibration:c=>live().calibration(c),nextDeadline:(p,t)=>live().nextDeadline(p,t)};
export function pick(sample,info){
 // Missing axes choose C. Non-numeric supplied values are not a reason to downgrade A.
 const values=sample?[sample.a,sample.b,sample.g]:null;
 if(values&&values.some(v=>v!==null&&v!==undefined&&!Number.isFinite(v)))return live();
 const bits=values?values.map(Number.isFinite):info&&info.gyro;
 return bits&&bits.some(v=>v!==true)?noGyro:live();
}
export const choice={pick,load:async(f,c)=>{const p=await noGyro.load(f,c);return {forwardBundle:true,live:p.source,noGyro:p};}};
export function collector(){
 const standard=new root.GBTesterForward.Sensors(),gravity=new Sensors(basic());
 const port={standard,gravity,orientation(e,t){standard.orientation(e,t);gravity.orientation(e,t);},motion(e,t){standard.motion(e,t);gravity.motion(e,t);},
  source(engine){return (engine?engine.NO_GYRO:standard.event&&standard.event.gyro.some(v=>!v))?gravity.basic:standard;},
  sampleFor(engine){const s=this.source(engine).sample,r=gravity.raw&&gravity.raw.rotationRate;return s?Object.assign({},s,{a:r?r.alpha:null,b:r?r.beta:null,g:r?r.gamma:null}):null;},eventFor(engine){return this.source(engine).event;}};
 // Retain supplied malformed axes for pick(), just as the agent capture does.
 // The gravity collector's internal nulls describe availability, not the raw input.
 Object.defineProperty(port,'sample',{get(){return this.sampleFor();}});
 for(const k of ['event','sign','o','n'])Object.defineProperty(port,k,{get(){return this.source()[k];}});
 return port;
}
root.GBForwardNoGyro=noGyro;root.GBForwardChoice=choice;
