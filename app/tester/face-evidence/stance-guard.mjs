// Local gaze envelope, not hardware endpoints or measured physical support.
// Bench H1 reverse12 and H6 logical60 at gain.99: wire L30.6..101.88.
export const BENCH_GAZE={min:30.6,max:101.88,soft:12,acceleration:180};
export class StanceGuard {
 constructor(profile=BENCH_GAZE){this.profile={...profile};this.reset();}
 reset(){this.velocity=0;this.edgeScale=1;}
 step(position,desiredVelocity,dt){
  const {min,max,soft,acceleration}=this.profile;
  dt=Math.max(0,Math.min(.1,dt));
  if(!Number.isFinite(position)||!Number.isFinite(desiredVelocity)||!Number.isFinite(dt))throw Error('Invalid gaze request');
  if(!desiredVelocity||!dt){this.reset();return position;}
  const direction=Math.sign(desiredVelocity);
  // A reversal cancels the previous direction immediately, then builds speed
  // into the new direction. There is no queued distant target to finish first.
  if(Math.sign(this.velocity)!==direction)this.velocity=0;
  const distance=direction<0?position-min:max-position;
  const x=Math.max(0,Math.min(1,distance/soft));
  this.edgeScale=x*x*(3-2*x);
  const desired=Math.abs(desiredVelocity)*this.edgeScale;
  // Brake immediately as the edge/error shrinks; limit increases in speed.
  this.velocity=direction*Math.min(desired,Math.abs(this.velocity)+acceleration*dt);
  const next=Math.max(min,Math.min(max,position+this.velocity*dt));
  if(next===position)this.velocity=0;
  return next;
 }
}
