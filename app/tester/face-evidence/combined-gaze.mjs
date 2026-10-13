import {StanceGuard} from './stance-guard.mjs';
// Seed for THIS bench body. Height/lean are motor coordinates, not pitch/yaw.
// Lean±6 tested at h0 (G1), h24/45/54; interpolation is a test hypothesis.
// Vertical compensation is provisional from the observed lean-induced tilt.
export const COMBINED_PROFILE={gain:.99,hMin:-12,hMax:60,bMax:6,bSpeed:18,bAccel:60,leanScale:.25,leanHeightCompensation:.12,sidewaysHeightAssist:1};
export function decodePose([l,r],p=COMBINED_PROFILE){return {h:(r-l)/(2*p.gain),b:(180-l-r)/(2*p.gain)};}
export function encodePose(h,b,p=COMBINED_PROFILE){return [90-p.gain*(h+b),90-p.gain*(-h+b)];}
export function leanLimit(h,p=COMBINED_PROFILE){return Math.max(0,Math.min(p.bMax,(h+12)/2,60-h));}
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const strength=e=>Math.sign(e)*Math.min(1,Math.max(0,(Math.abs(e)-.055)/.185));
export class CombinedGaze{
 constructor(profile=COMBINED_PROFILE){this.profile={...profile};this.height=new StanceGuard({min:profile.hMin,max:profile.hMax,soft:12,acceleration:180});this.reset();}
 reset(){this.height.reset();this.bVelocity=0;this.state={limited:false,h:null,b:null,leanLimit:null};}
 step(pair,x,y,dt,{rate=60,gain=.6,verticalOnly=false,dir=1}={}){
  if(![...pair,x,y,dt,rate,gain,dir].every(Number.isFinite)||dt<0||rate<0||gain<0)throw Error('Invalid combined gaze input');
  dt=Math.min(.1,dt);const p=this.profile,{h,b}=decodePose(pair,p),limit=leanLimit(h,p);
  if(!strength(y)&&(verticalOnly||!strength(x*dir))&&Math.abs(b)<=limit+1e-8){this.reset();this.state={h,b,leanLimit:limit,limited:false,heightLimited:false,verticalOnly};return pair.slice();}
  let vb=verticalOnly?0:-strength(x*dir)*rate*gain*p.leanScale;
  vb=clamp(vb,-p.bSpeed,p.bSpeed);
  // Brake outwards before the local lean edge; returning stays responsive.
  if(vb*b>=0){const margin=clamp((limit-Math.abs(b))/2,0,1);vb*=margin*margin*(3-2*margin);}
  if(!vb||Math.sign(vb)!==Math.sign(this.bVelocity))this.bVelocity=0;
  this.bVelocity=Math.sign(vb)*Math.min(Math.abs(vb),Math.abs(this.bVelocity)+p.bAccel*dt);
  // Both image axes contribute to ONE pose. A lean-induced height correction
  // is bounded and is feedback-corrected; it is not an exact geometric model.
  const sx=verticalOnly?0:strength(x*dir),sy=strength(y);
  // Original's height movement also changes horizontal framing on this body.
  // Use it when horizontal error dominates, but blend continuously with the
  // vertical correction. Equal/opposing errors never select alternating axes.
  // Pure vertical and equal-magnitude diagonal corrections retain V1 behavior.
  const sidewaysAssist=p.sidewaysHeightAssist*Math.sign(sx)*Math.max(0,Math.abs(sx)-Math.abs(sy));
  const heightDrive=clamp(sy+sidewaysAssist,-1,1);
  const vh=rate*gain*heightDrive/p.gain+p.leanHeightCompensation*clamp(h/24,0,1)*b*this.bVelocity;
  let nh=this.height.step(h,vh,dt),nb=b+this.bVelocity*dt;
  const newLimit=leanLimit(nh,p);
  if(Math.abs(nb)>newLimit){nb=b+clamp(clamp(nb,-newLimit,newLimit)-b,-p.bSpeed*dt,p.bSpeed*dt);}
  // Retract lean before leaving its support corridor; never snap it to zero.
  if(Math.abs(nb)>1e-8)nh=clamp(nh,-12+2*Math.abs(nb),60-Math.abs(nb));
  nh=clamp(nh,p.hMin,p.hMax);nb=clamp(nb,-p.bMax,p.bMax);
  let requested=encodePose(nh,nb,p);
  // Joint rate limiting preserves the two-coordinate direction by scaling the
  // whole paired step, instead of clipping each motor independently.
  const largest=Math.max(...requested.map((v,i)=>Math.abs(v-pair[i]))),scale=largest?Math.min(1,rate*dt/largest):1;
  requested=requested.map((v,i)=>pair[i]+(v-pair[i])*scale);
  const next=decodePose(requested,p);
  const leanLimited=Math.abs(x)>.055&&!verticalOnly&&Math.abs(next.b)>=leanLimit(next.h,p)-.2;
  this.state={...next,leanLimit:leanLimit(next.h,p),sidewaysAssist,heightDrive,leanLimited,limited:leanLimited&&(Math.abs(heightDrive)<.01||this.height.edgeScale<.08),heightLimited:Math.abs(y)>.055&&this.height.edgeScale<.08,verticalOnly};
  return requested;
 }
}
