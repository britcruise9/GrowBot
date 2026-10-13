/* Short, detector-anchored sparse pyramidal Lucas–Kanade flow. No motor authority.
 * Translation only: detector refresh supplies scale/identity. Grayscale input <=160x120.
 * Forward/backward and photometric checks reject disappearing/ambiguous features.
 * Never re-seed from flow; never extend the detector anchor's lifetime.
 */
export const FLOW_ANCHOR_MS = 90;
const R=3, MIN_POINTS=6, MAX_POINTS=24;
const median=a=>a.slice().sort((a,b)=>a-b)[Math.floor(a.length/2)];
function pixel(im,x,y){
  const ix=Math.floor(x),iy=Math.floor(y),dx=x-ix,dy=y-iy,k=iy*im.w+ix,d=im.d;
  return (d[k]*(1-dx)+d[k+1]*dx)*(1-dy)+(d[k+im.w]*(1-dx)+d[k+im.w+1]*dx)*dy;
}
function inside(im,x,y,r=R+2){return x>=r&&y>=r&&x<im.w-r-1&&y<im.h-r-1;}
export function pyramid(gray,w,h){
  const p=[{d:gray,w,h}];
  while(p.length<3){const a=p[p.length-1],w=a.w>>1,h=a.h>>1,d=new Float32Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const k=2*y*a.w+2*x;d[y*w+x]=(a.d[k]+a.d[k+1]+a.d[k+a.w]+a.d[k+a.w+1])/4;}
    p.push({d,w,h});
  }return p;
}
function corners(im,b){
  const candidates=[],margin=3,x0=Math.max(R+2,Math.ceil((b.x+b.width*.12)*im.w)),x1=Math.min(im.w-R-3,Math.floor((b.x+b.width*.88)*im.w));
  const y0=Math.max(R+2,Math.ceil((b.y+b.height*.12)*im.h)),y1=Math.min(im.h-R-3,Math.floor((b.y+b.height*.88)*im.h));
  for(let y=y0;y<=y1;y+=2)for(let x=x0;x<=x1;x+=2){let xx=0,yy=0,xy=0;
    for(let j=-2;j<=2;j++)for(let i=-2;i<=2;i++){const k=(y+j)*im.w+x+i,gx=(im.d[k+1]-im.d[k-1])/2,gy=(im.d[k+im.w]-im.d[k-im.w])/2;xx+=gx*gx;yy+=gy*gy;xy+=gx*gy;}
    const score=(xx+yy-Math.hypot(xx-yy,2*xy))/2;
    if(score>100)candidates.push({x,y,score});
  }
  candidates.sort((a,b)=>b.score-a.score);const selected=[];
  for(const c of candidates){if(selected.every(p=>Math.hypot(c.x-p.x,c.y-p.y)>=margin+2))selected.push(c);if(selected.length===MAX_POINTS)break;}
  return selected;
}
function track(a,b,p){
  let dx=0,dy=0;
  for(let level=a.length-1;level>=0;level--){
    const scale=2**level,A=a[level],B=b[level],x=p.x/scale,y=p.y/scale;
    if(level!==a.length-1){dx*=2;dy*=2;}
    if(!inside(A,x,y))continue;
    const values=[],gx=[],gy=[];let xx=0,yy=0,xy=0;
    for(let j=-R;j<=R;j++)for(let i=-R;i<=R;i++){
      const u=pixel(A,x+i+1,y+j)-pixel(A,x+i-1,y+j),v=pixel(A,x+i,y+j+1)-pixel(A,x+i,y+j-1);
      values.push(pixel(A,x+i,y+j));gx.push(u/2);gy.push(v/2);xx+=u*u/4;yy+=v*v/4;xy+=u*v/4;
    }
    const det=xx*yy-xy*xy;if(det<1e-3)return null;
    for(let it=0;it<12;it++){
      if(!inside(B,x+dx,y+dy))return null;
      let bx=0,by=0,k=0;
      for(let j=-R;j<=R;j++)for(let i=-R;i<=R;i++,k++){const error=values[k]-pixel(B,x+dx+i,y+dy+j);bx+=gx[k]*error;by+=gy[k]*error;}
      const ux=(yy*bx-xy*by)/det,uy=(xx*by-xy*bx)/det;
      if(!Number.isFinite(ux+uy)||Math.hypot(ux,uy)>6)return null;
      dx+=ux;dy+=uy;if(ux*ux+uy*uy<.0009)break;
    }
  }
  if(!inside(b[0],p.x+dx,p.y+dy))return null;
  let error=0;
  for(let j=-R;j<=R;j++)for(let i=-R;i<=R;i++)error+=Math.abs(pixel(a[0],p.x+i,p.y+j)-pixel(b[0],p.x+dx+i,p.y+dy+j));
  return error/((2*R+1)**2)<=18?{x:p.x+dx,y:p.y+dy}:null;
}
export class FaceFlow {
  constructor(){this.reset();}
  reset(){this.prev=null;this.points=[];this.box=null;this.anchorAt=-Infinity;this.at=-Infinity;}
  seed(gray,w,h,boxes,at){
    this.reset();
    if(!Number.isFinite(at)||boxes.length!==1)return false;
    const b=boxes[0];if(!['x','y','width','height'].every(k=>Number.isFinite(b[k]))||b.width<=0||b.height<=0)return false;
    this.prev=pyramid(gray,w,h);this.points=corners(this.prev[0],b);
    if(this.points.length<MIN_POINTS){this.reset();return false;}
    this.box={...b};this.anchorAt=this.at=at;return true;
  }
  step(gray,w,h,at){
    if(!this.prev||w!==this.prev[0].w||h!==this.prev[0].h||!Number.isFinite(at)||at<=this.at||at-this.at>70||at-this.anchorAt>FLOW_ANCHOR_MS){this.reset();return null;}
    const next=pyramid(gray,w,h),good=[];
    for(const p of this.points){const q=track(this.prev,next,p);if(!q)continue;
      const back=track(next,this.prev,q);if(back&&Math.hypot(back.x-p.x,back.y-p.y)<=.8)good.push({p,q,dx:q.x-p.x,dy:q.y-p.y});
    }
    if(good.length<MIN_POINTS||good.length<this.points.length*.6){this.reset();return null;}
    const dx=median(good.map(p=>p.dx)),dy=median(good.map(p=>p.dy));
    const inliers=good.filter(p=>Math.hypot(p.dx-dx,p.dy-dy)<=1.5);
    if(inliers.length<MIN_POINTS||inliers.length<good.length*.7||Math.hypot(dx/w,dy/h)>.12){this.reset();return null;}
    const box={...this.box,x:this.box.x+dx/w,y:this.box.y+dy/h};
    if(box.x<0||box.y<0||box.x+box.width>1||box.y+box.height>1){this.reset();return null;}
    this.points=inliers.map(p=>p.q);this.prev=next;this.box=box;this.at=at;
    return {box,points:this.points.length,anchorAt:this.anchorAt};
  }
}
