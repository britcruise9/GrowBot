/* Bench-only measured-pose acquisition. Orientation timestamps are never refreshed.
   A fresh orientation anchors a fixed gravity pose; continuous quiet motion readings
   may confirm that same pose. Run readiness is separate from the retained sensor sign. */
import {rawFrame} from './runner.mjs';
const finite=Number.isFinite,D=Math.PI/180,norm=a=>Math.hypot(...a),dot=(a,b)=>a.reduce((n,x,i)=>n+x*b[i],0);
const vector=o=>[-Math.sin(o.g*D)*Math.cos(o.b*D),Math.sin(o.b*D),Math.cos(o.g*D)*Math.cos(o.b*D)];
export class Sensors {
 constructor(B){this.B=B;this.basic=new B.Sensors();this.raw=null;this.anchor=null;this.lastT=null;this.lastOriT=null;this.mappingOK=false;this.blockingReason=null;this.reason='orientation_missing';this.latestLinear=null;this.lastReset=null;}
 reset(reason,block=false){if(this.anchor||block){const a=this.raw&&this.raw.accelerationIncludingGravity;this.lastReset={reason,motionT:this.raw?this.raw.t:null,anchor:this.anchor?{mode:this.anchor.mode,t:this.anchor.t,sign:this.anchor.sign,gravity:this.anchor.a.slice()}:null,gravityDelta:this.anchor&&a?norm([a.x-this.anchor.a[0],a.y-this.anchor.a[1],a.z-this.anchor.a[2]]):null};}this.anchor=null;this.basic.vote=0;this.basic.n=0;this.basic.stillMs=0;this.reason=reason;if(block){this.mappingOK=false;this.blockingReason=reason;this.basic.sample=null;}}
 orientation(e,t){
  const b=this.basic;
  if(!e||!finite(t)||!finite(e.beta)||!finite(e.gamma)||(this.lastOriT!==null&&t<this.lastOriT)){b.o=null;this.reset('orientation_invalid',true);return;}
  this.lastOriT=t;b.o={b:e.beta,g:e.gamma,t};
  const u=vector(b.o);
  if(this.anchor&&this.anchor.mode==='orientation'&&dot(u,this.anchor.u)<Math.cos(3*D))this.reset('orientation_changed');
  // A fresh quiet contradiction preempts a retained-sign start, but never revokes the runtime mapping.
  if(this.anchor&&this.anchor.mode==='retained'&&this.mappingOK&&this.raw&&t>=this.raw.t&&t-this.raw.t<=250){const a=this.raw.accelerationIncludingGravity,xyz=[a.x,a.y,a.z],m=norm(xyz),r=this.raw.rotationRate,rate=r?[r.alpha,r.beta,r.gamma].reduce((n,x)=>n+(finite(x)?Math.abs(x):0),0):0,c=dot(xyz,u)/m,v=c>=.8?1:c<=-.8?-1:0;if(m>=8.3&&m<=11.3&&rate<=30&&(this.latestLinear===null||this.latestLinear<=2.5)&&(!v||v!==b.sign))this.reset(v?'gravity_direction_conflict':'gravity_orientation_mismatch');}
  // Only a qualified orientation anchor below can change the measured platform sign.
 }
 motion(e,t){
  const b=this.basic,r=e&&e.rotationRate,a=e&&e.accelerationIncludingGravity;
  b.event=this.B.eventInfo(e,t);b.sample=null;this.latestLinear=null;
  this.raw=a?{t,gyroT:t,accelerationIncludingGravity:{x:a.x,y:a.y,z:a.z},rotationRate:r?{alpha:r.alpha,beta:r.beta,gamma:r.gamma}:null}:null;
  if(!finite(t)){b.event.issue='motion_invalid_time';this.reset('motion_invalid_time',true);return;}
  if(this.lastT!==null&&t<=this.lastT){b.event.issue='motion_nonmonotonic';this.reset('motion_nonmonotonic',true);return;}
  const gap=this.lastT===null?0:t-this.lastT;this.lastT=t;
  if(!a||![a.x,a.y,a.z].every(finite)){this.reset('gravity_missing',true);return;}
  const xyz=[a.x,a.y,a.z],m=norm(xyz);
  if(!finite(m)||m<.01){b.event.issue='motion_gravity_invalid';this.reset('gravity_invalid',true);return;}
  if(gap>250){b.event.issue='motion_sparse';this.reset('motion_sparse',true);return;}
  const lin=e&&e.acceleration,linear=lin&&[lin.x,lin.y,lin.z].every(finite)?norm([lin.x,lin.y,lin.z]):null;
  this.latestLinear=linear;
  const rates=r?[r.alpha,r.beta,r.gamma]:[],knownRate=rates.reduce((n,x)=>n+(finite(x)?Math.abs(x):0),0),o=b.o,u=o?vector(o):null;
  const fresh=!!o&&t>=o.t&&t-o.t<=250,cosine=u?dot(xyz,u)/m:0,v=cosine>=.8?1:cosine<=-.8?-1:0;
  let cause=!o?'orientation_missing':t<o.t?'orientation_future':m<8.3||m>11.3?'gravity_magnitude':knownRate>30?'rotation_detected':linear!==null&&linear>2.5?'linear_motion':null;
  if(!cause&&this.anchor){
   if(norm(xyz.map((x,i)=>x-this.anchor.a[i]))>.35)cause='gravity_pose_changed';
   else if(this.anchor.mode==='orientation'&&dot(u,this.anchor.u)<Math.cos(3*D))cause='orientation_changed';
   else if(this.anchor.mode==='orientation'&&v!==this.anchor.sign||this.anchor.mode==='retained'&&fresh&&v&&v!==b.sign)cause='gravity_direction_conflict';
   else if(this.anchor.mode==='retained'&&fresh&&!v)cause='gravity_orientation_mismatch';
  }
  if(cause)this.reset(cause);
  if(!cause&&!this.anchor){
   if(fresh){if(!v)this.reason='gravity_orientation_mismatch';else{this.anchor={mode:'orientation',t,a:xyz,u,sign:v,requiredMs:b.sign?1200:500,requiredSamples:b.sign?12:6};this.reason='measuring_stillness';}}
   else if(this.mappingOK&&[1,-1].includes(b.sign)){this.anchor={mode:'retained',t,a:xyz,u:null,sign:b.sign,requiredMs:1200,requiredSamples:12};this.reason='measuring_stillness';}
   else this.reason='orientation_stale_for_anchor';
  }
  if(!cause&&this.anchor){
   b.vote=this.anchor.sign;b.n++;b.stillMs=t-this.anchor.t;b.requiredMs=this.anchor.requiredMs;
   if(b.stillMs>=b.requiredMs&&b.n>=this.anchor.requiredSamples){b.sign=this.anchor.sign;this.mappingOK=true;this.blockingReason=null;this.reason='ready';}
  }
  if(this.mappingOK&&b.sign)b.sample={t,a:r&&finite(r.alpha)?r.alpha:null,b:r&&finite(r.beta)?r.beta:null,g:r&&finite(r.gamma)?r.gamma:null,x:a.x*b.sign,y:a.y*b.sign,z:a.z*b.sign,sign:b.sign,linear:finite(linear)?linear:null};
 }
 frame(now,sign,B){
  const s=this.basic.sample;if(this.basic.o&&now<this.basic.o.t)throw Error('Orientation timing is ahead of the page');if(!this.mappingOK)throw Error(this.readinessMessage(this.blockingReason||this.reason));B.frame(s,now,sign,this.basic.event);
  if(!s||now<s.t||now-s.t>250)throw Error('Fresh gravity readings required');
  const f=rawFrame(this.raw,now,sign,250);if(!f.acc.every(finite)||norm(f.acc)<.01)throw Error('Gravity missing');return {sample:s,frame:f};
 }
 readinessMessage(reason=this.reason){return {orientation_missing:'No orientation reading yet. Gently reposition the phone, then hold still.',orientation_invalid:'The latest orientation reading is invalid. Wait for a new reading.',orientation_future:'Orientation timing is ahead of motion. Wait for fresh readings.',orientation_stale_for_anchor:'A fresh orientation is needed to measure this pose. Gently reposition, then hold still.',orientation_changed:'Phone orientation changed. Hold still in the new pose.',gravity_pose_changed:'Gravity direction moved. Hold still in the new pose.',gravity_sign_conflict:'Motion and orientation disagree on gravity sign. Stop and measure again.',gravity_direction_conflict:'Gravity no longer matches the measured pose. Measure again.',gravity_orientation_mismatch:'Gravity and orientation do not agree. Reposition the phone, then hold still.',gravity_magnitude:'Gravity is outside the stillness range. Put the robot down and hold still.',rotation_detected:'Rotation is still being measured. Hold still.',linear_motion:'Movement is still being measured. Hold still.',gravity_missing:'The latest gravity reading is missing.',gravity_invalid:'The latest gravity vector is invalid.',motion_sparse:'Motion readings are more than 250 ms apart. Keep this page visible.',motion_nonmonotonic:'Motion timestamps repeated or went backwards.',motion_invalid_time:'Motion timing is invalid.',measuring_stillness:'Measuring a steady pose. Hold still.',ready:'Ready for a manual five-second run.'}[reason]||'Wait for measured sensor readiness.';}
 readiness(now){
  const b=this.basic,age=this.raw&&finite(now)&&finite(this.raw.t)?now-this.raw.t:null,oa=b.o&&finite(now)?now-b.o.t:null;
  let ok=false,message=this.readinessMessage(),code=this.reason;
  if(!finite(now)||age!==null&&age<0||oa!==null&&oa<0){code='motion_invalid_time';message='Motion timing is invalid.';}
  else if(age===null||age>250){code='motion_stale';message='Waiting for fresh gravity readings (at most 250 ms old).';}
  else if(this.mappingOK&&this.anchor&&b.vote===b.sign&&b.stillMs>=b.requiredMs&&b.n>=this.anchor.requiredSamples){ok=true;code='ready';message='Ready for a manual five-second run.';}
  return {ok,code,message,anchorMode:this.anchor?this.anchor.mode:null,blockingReason:this.blockingReason,orientationAge:oa,motionAge:age,sign:b.sign,stableMs:b.stillMs,requiredMs:b.requiredMs,samples:b.n};
 }
 snapshot(now){const a=this.raw&&this.raw.accelerationIncludingGravity;return {...this.readiness(now),anchor:this.anchor?{mode:this.anchor.mode,age:now-this.anchor.t,t:this.anchor.t,sign:this.anchor.sign,gravity:this.anchor.a.slice(),gravityDelta:a?norm([a.x-this.anchor.a[0],a.y-this.anchor.a[1],a.z-this.anchor.a[2]]):null}:null,lastReset:this.lastReset,orientation:this.basic.o?{...this.basic.o}:null,motion:this.raw?{t:this.raw.t,gravity:{...this.raw.accelerationIncludingGravity},gyro:this.raw.rotationRate?{...this.raw.rotationRate}:null}:null,linear:this.latestLinear};}
 startReady(now,B){const d=this.readiness(now);if(!d.ok)throw Error(d.message);return this.frame(now,this.basic.sign,B);}
}
