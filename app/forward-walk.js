/* Stock screen-forward adapter, 0930. Execution-local calibration; never writes gb_walk_cal.
   Bench: growbot-seed-first4-0930-walk_fwd, seven 5 s runs on one kit. No distance guarantee.
   The inference arithmetic follows the archived Motion Lab policy-residual.mjs exactly. */
(function(root){
  var ID="growbot-seed-first4-0930-walk_fwd", SHA="1ad9c42e06a064f1169b4a779c7d94e24ace4adbc64d73da68740dc1e27d5685";
  var PATH="/policies/forward-0930/walk_fwd.json", D=Math.PI/180;
  function finite(x){ return typeof x==="number"&&isFinite(x); }
  function flag(q){ var m=/[?&]forwardwalk=([01])(&|$)/.exec(String(q||"")); return m?m[1]:""; }
  function select(b,c,q){
    if(flag(q)==="0")return {on:false,why:"rollback"};
    if(!b||b.id!=="growbot-85mm-2leg"||b.walk&&b.walk.present===false)return {on:false,why:"unsupported_body"};
    if(!c||c.SWAP)return {on:false,why:"swap"};
    if(!finite(c.L_OFF)||!finite(c.R_OFF)||Math.abs(c.L_OFF)>45||Math.abs(c.R_OFF)>45)return {on:false,why:"invalid_trims"};
    return {on:true,why:"stock"};
  }
  function calibration(c){
    if(!c||c.SWAP||!finite(c.L_OFF)||!finite(c.R_OFF)||Math.abs(c.L_OFF)>45||Math.abs(c.R_OFF)>45)throw Error("unsupported walk calibration");
    return Object.assign({},c,{L_SIGN:-1,R_SIGN:-1,gain:.99,turn:0,SWAP:false});
  }
  function smooth(t){ t=Math.max(0,Math.min(1,t));return t*t*(3-2*t); }
  function seed(p,cycle){ var q=((cycle%1)+1)%1,d=p.duty,w=q<d?-1+2*smooth(q/d):1-2*smooth((q-d)/(1-d));return [p.height+p.amplitude*w,-p.height-p.amplitude*w]; }
  function forward(p,obs){ var x=obs,L=p.layers; for(var k=0;k<L.length;k++){var W=L[k].W,b=L[k].b,y=new Array(W.length);for(var i=0;i<W.length;i++){var s=b[i],row=W[i];for(var j=0;j<row.length;j++)s+=row[j]*x[j];y[i]=k<L.length-1?Math.tanh(s):Math.max(-1,Math.min(1,s));}x=y;}return x; }
  function Policy(p,c){
    if(!p||p.id!==ID||p.contract.control_hz!==25||p.contract.hist!==3||p.contract.res_deg!==4)throw Error("unexpected forward policy");
    this.p=p;this.cal=calibration(c);this.t=0;this.cycle=0;this.prev=[0,0];this.frames=null;
  }
  Policy.prototype.tickBody=function(g,a){
    var ph=2*Math.PI*(((this.cycle%1)+1)%1),clip=function(v){return Math.max(-3,Math.min(3,v));};
    var f=[clip(g[0]/5),clip(g[1]/5),clip(g[2]/5),a[0]/9.81,a[1]/9.81,a[2]/9.81,this.prev[0],this.prev[1],Math.sin(ph),Math.cos(ph)];
    if(!this.frames)this.frames=[f,f,f];else{this.frames.push(f);this.frames.shift();}
    var obs=[];for(var i=this.frames.length-1;i>=0;i--)for(var j=0;j<f.length;j++)obs.push(this.frames[i][j]);
    var act=forward(this.p,obs),s=this.p.contract.seed;this.cycle+=(1/25)*s.hz*s.dir;
    var joints=seed(s,this.cycle),ramp=smooth(this.t/.7),c=this.cal;
    var servo=[90+c.L_OFF+c.L_SIGN*(joints[0]*ramp+4*act[0])*c.gain,90+c.R_OFF+c.R_SIGN*(joints[1]*ramp+4*act[1])*c.gain].map(function(v){return Math.max(0,Math.min(180,Math.round(v)));});
    this.prev=act;this.t+=1/25;return {servo:servo,action:act,obs:obs};
  };
  /* Local validity metadata only: no raw readings, persistence, or uploads. */
  function eventInfo(e,t){
    var r=e&&e.rotationRate,a=e&&e.accelerationIncludingGravity;
    return {t:t,gyro:[!!r&&finite(r.alpha),!!r&&finite(r.beta),!!r&&finite(r.gamma)],
      gravity:[!!a&&finite(a.x),!!a&&finite(a.y),!!a&&finite(a.z)]};
  }
  function diagnostic(s,now,sign,info){
    var code="",message="",gyro=s?[finite(s.a),finite(s.b),finite(s.g)]:info&&info.gyro,
      gravity=s?[finite(s.x),finite(s.y),finite(s.z)]:info&&info.gravity,t=s?s.t:info&&info.t;
    function missing(bits,names){return names.filter(function(n,i){return !bits||bits[i]!==true;}).join(", ");}
    if(!finite(now)||(s||info)&&!finite(t)){code="motion_invalid_time";message="Motion sensor timing is invalid. Reload this page.";}
    else if(!s&&!info){code="motion_no_event";message="No motion readings yet. Allow motion access and keep this page open.";}
    else if(gyro&&missing(gyro,["alpha","beta","gamma"])){code="motion_gyro_missing";message="This browser is not supplying usable rotation readings ("+missing(gyro,["alpha","beta","gamma"])+" missing). Check motion permission in this browser.";}
    else if(gravity&&missing(gravity,["x","y","z"])){code="motion_gravity_missing";message="This browser is not supplying usable gravity readings ("+missing(gravity,["x","y","z"])+" missing). Check motion permission in this browser.";}
    else if(!s){code="motion_sample_missing";message="No usable motion reading yet. Hold still briefly and try again.";}
    else if(now<s.t){code="motion_future_time";message="Motion sensor timing is ahead of the page. Reload this page.";}
    else if(now-s.t>1000){code="motion_stale";message="Motion readings stopped. Keep this page visible and enable motion access.";}
    else if([1,-1].indexOf(sign)<0||[1,-1].indexOf(s.sign)<0){code="gravity_sign_unmeasured";message="Gravity direction is not measured yet. Hold the phone still briefly, then try again.";}
    else if(s.sign!==sign){code="motion_sign_mismatch";message="The measured gravity direction changed. Hold still and try again.";}
    return {ok:!code,code:code,message:message,gyro:gyro||[false,false,false],gravity:gravity||[false,false,false],
      sign:s&&[1,-1].indexOf(s.sign)>=0?s.sign:0,age:finite(now)&&finite(t)?now-t:null};
  }
  /* sample.acc is already sign-corrected by the page's measured gravity sign. */
  function frame(s,now,sign,info){
    var d=diagnostic(s,now,sign,info);
    if(!d.ok){var e=Error(d.message);e.code=d.code;throw e;}
    return {gyro:[s.b*D,-s.a*D,s.g*D],acc:[s.y,-s.x,s.z],linear:finite(s.linear)?s.linear:null};
  }
  function Controller(p,c,s,now){
    this.cal=calibration(c);this.sign=s&&s.sign;frame(s,now,this.sign);this.policy=new Policy(p,this.cal);
    this.start=now;this.last=now;this.first=null;this.initialTilt=null;this.tipN=0;this.jerkN=0;this.n=0;this.lastTick=null;
    this.neutral=[Math.round(90+c.L_OFF),Math.round(90+c.R_OFF)];
  }
  Controller.prototype.tick=function(s,now,c){
    if(!finite(now)||now<this.last||now-this.last>250)throw Error("walk control paused");this.last=now;
    var cal=calibration(c);if(cal.L_OFF!==this.cal.L_OFF||cal.R_OFF!==this.cal.R_OFF)throw Error("walk calibration changed");
    var f=frame(s,now,this.sign);
    if(now-this.start<1200)return {servo:this.neutral.slice(),prep:true};
    var a=f.acc,mag=Math.sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]);if(mag<.01)throw Error("gravity signal unavailable");
    var tilt=Math.acos(Math.max(-1,Math.min(1,a[2]/mag)))/D;
    if(this.first===null){this.first=now;this.initialTilt=tilt;}
    if(now-this.first>1000){this.tipN=(tilt>115||(this.initialTilt>=20&&tilt<15)||Math.abs(a[1])/mag>Math.sin(55*D))?this.tipN+1:0;this.jerkN=f.linear!==null&&f.linear>11?this.jerkN+1:0;if(this.tipN>=5||this.jerkN>=6)return {abort:this.tipN>=5?"tipped":"grabbed",tilt:tilt};}
    var out=this.policy.tickBody(f.gyro,f.acc);out.tilt=tilt;out.prep=false;this.n++;this.lastTick=now;return out;
  };
  function nextDeadline(prev,now){return prev+40>now?prev+40:now+40;}
  function load(fetcher,cryptoApi){
    return fetcher(PATH).then(function(r){if(!r.ok)throw Error("forward policy unavailable");return r.arrayBuffer();}).then(function(bytes){
      if(!cryptoApi||!cryptoApi.subtle)throw Error("policy verification unavailable");
      return cryptoApi.subtle.digest("SHA-256",bytes).then(function(d){var a=Array.prototype.slice.call(new Uint8Array(d)),sha=a.map(function(v){return ("0"+v.toString(16)).slice(-2);}).join("");if(sha!==SHA)throw Error("forward policy changed; reload");return JSON.parse(new TextDecoder().decode(bytes));});
    });
  }
  root.GBForwardWalk={ID:ID,SHA:SHA,PATH:PATH,flag:flag,select:select,calibration:calibration,Policy:Policy,Controller:Controller,eventInfo:eventInfo,diagnostic:diagnostic,frame:frame,nextDeadline:nextDeadline,load:load};
})(typeof window!=="undefined"?window:this);
