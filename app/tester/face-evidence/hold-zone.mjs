// Coverage is intersection area / fixed center-target area, not face area.
export function targetCoverage(box){
 if(!box||!['x','y','width','height'].every(k=>Number.isFinite(box[k]))||box.width<=0||box.height<=0)return 0;
 const width=Math.max(0,Math.min(.58,box.x+box.width)-Math.max(.42,box.x));
 const height=Math.max(0,Math.min(.58,box.y+box.height)-Math.max(.42,box.y));
 return Math.min(1,width*height/(.16*.16));
}
export class HoldZone {
 constructor(){this.reset();}
 reset(){this.holding=false;this.coverage=0;}
 step(box,{supported=true}={}){
  this.coverage=targetCoverage(box);
  if(!supported){this.reset();return false;}
  if(this.holding?this.coverage<.50:this.coverage>=.75)this.holding=!this.holding;
  return this.holding;
 }
}
