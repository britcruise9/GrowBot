/* Opt-in Tester experiment: authored forward stroke only, with real gravity feedback.
   No learned network, synthetic gyro, calibration writes, or automatic mode selection.
   The source policy must first pass GBForwardWalk.load's immutable-byte verification. */
(function(root){
  var F=root.GBForwardWalk,D=Math.PI/180,STILL_MS=500,OPPOSITE_MS=1200,MAX_GAP=250;
  var SOURCE_ID="growbot-seed-first4-0930-walk_fwd";
  var SEED={mode:"stroke",hz:1.80969723562966,amplitude:14,height:55,duty:.5,dir:1};
  function finite(x){return typeof x==="number"&&isFinite(x);}
  function fail(code,message){var e=Error(message);e.code=code;throw e;}
  function smooth(t){t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);}
  function length(x,y,z){return Math.sqrt(x*x+y*y+z*z);}
  function source(p){
    if(!p||p.id!==SOURCE_ID||!p.contract||p.contract.control_hz!==25||p.contract.hist!==3||p.contract.res_deg!==4)throw Error("unexpected basic-walk source policy");
    var s=p.contract.seed,keys=Object.keys(SEED);
    if(!s||Object.keys(s).length!==keys.length||!keys.every(function(k){return Object.prototype.hasOwnProperty.call(s,k)&&s[k]===SEED[k];}))throw Error("unexpected basic-walk source stroke");
  }
  function Policy(p,c){
    source(p);this.cal=F.calibration(c);this.t=0;this.cycle=0;
  }
  Policy.prototype.tickBody=function(){
    this.cycle+=(1/25)*SEED.hz*SEED.dir;
    var q=((this.cycle%1)+1)%1,d=SEED.duty,w=q<d?-1+2*smooth(q/d):1-2*smooth((q-d)/(1-d));
    var joint=SEED.height+SEED.amplitude*w,ramp=smooth(this.t/.7),c=this.cal;
    var servo=[90+c.L_OFF+c.L_SIGN*joint*ramp*c.gain,90+c.R_OFF-c.R_SIGN*joint*ramp*c.gain].map(function(v){return Math.max(0,Math.min(180,Math.round(v)));});
    this.t+=1/25;return {servo:servo,action:null,obs:null,seedOnly:true};
  };
  function eventInfo(e,t){
    var r=e&&e.rotationRate,a=e&&e.accelerationIncludingGravity;
    return {t:t,gyro:[!!r&&finite(r.alpha),!!r&&finite(r.beta),!!r&&finite(r.gamma)],gravity:[!!a&&finite(a.x),!!a&&finite(a.y),!!a&&finite(a.z)],issue:""};
  }
  function Sensors(){
    this.o=null;this.sign=0;this.vote=0;this.n=0;this.sample=null;this.event=null;
    this.stillMs=0;this.requiredMs=STILL_MS;this._evidence=null;this._lastT=null;this._oriT=null;
  }
  Sensors.prototype._reset=function(){this.vote=0;this.n=0;this.stillMs=0;this._evidence=null;};
  Sensors.prototype.orientation=function(e,t){
    if(!e||!finite(t)||!finite(e.beta)||!finite(e.gamma)||(this._oriT!==null&&t<this._oriT)){this.o=null;this._reset();return;}
    this._oriT=t;this.o={b:e.beta,g:e.gamma,t:t};
  };
  Sensors.prototype.motion=function(e,t){
    var r=e&&e.rotationRate,a=e&&e.accelerationIncludingGravity,o=this.o,info=eventInfo(e,t);
    this.event=info;this.sample=null;
    if(!finite(t)){info.issue="motion_invalid_time";this._reset();return;}
    if(this._lastT!==null&&t<=this._lastT){info.issue="motion_nonmonotonic";this._reset();return;}
    var gap=this._lastT===null?0:t-this._lastT;this._lastT=t;
    if(!a||!info.gravity.every(function(x){return x;})){this._reset();return;}
    var m=length(a.x,a.y,a.z);
    if(!finite(m)||m<.01){info.issue="motion_gravity_invalid";this._reset();return;}
    if(gap>MAX_GAP){info.issue="motion_sparse";this._reset();return;}
    var lin=e&&e.acceleration,linear=lin&&[lin.x,lin.y,lin.z].every(finite)?length(lin.x,lin.y,lin.z):null;
    var linearQuiet=linear===null||finite(linear)&&linear<=2.5;
    var v=0,u=null,knownRate=0,gyro=r?[r.alpha,r.beta,r.gamma]:[];
    /* Available rates may veto stillness; absent axes are never replaced with zero. */
    for(var i=0;i<gyro.length;i++)if(finite(gyro[i]))knownRate+=Math.abs(gyro[i]);
    if(o&&t>=o.t&&t-o.t<=250&&m>=8.3&&m<=11.3&&knownRate<=30&&linearQuiet){
      var b=o.b*D,g=o.g*D;u=[-Math.sin(g)*Math.cos(b),Math.sin(b),Math.cos(g)*Math.cos(b)];
      var cosine=(a.x*u[0]+a.y*u[1]+a.z*u[2])/m;v=cosine>=.8?1:cosine<=-.8?-1:0;
    }
    this.requiredMs=this.sign?OPPOSITE_MS:STILL_MS;
    if(v){
      var st=this._evidence,stable=st&&st.sign===v&&length(a.x-st.a[0],a.y-st.a[1],a.z-st.a[2])<=.35&&u[0]*st.u[0]+u[1]*st.u[1]+u[2]*st.u[2]>=Math.cos(3*D);
      if(!stable){this._evidence={sign:v,t:t,a:[a.x,a.y,a.z],u:u};this.n=1;this.stillMs=0;}
      else{this.n++;this.stillMs=t-st.t;}
      this.vote=v;
      if(this.stillMs>=this.requiredMs&&this.n>=(this.sign?12:6))this.sign=v;
    }else this._reset();
    if(!this.sign)return;
    this.sample={t:t,a:r&&finite(r.alpha)?r.alpha:null,b:r&&finite(r.beta)?r.beta:null,g:r&&finite(r.gamma)?r.gamma:null,
      x:a.x*this.sign,y:a.y*this.sign,z:a.z*this.sign,sign:this.sign,linear:finite(linear)?linear:null};
  };
  function diagnostic(s,now,sign,info){
    var code="",message="",gyro=info&&info.gyro||(s?[finite(s.a),finite(s.b),finite(s.g)]:[false,false,false]),gravity=s?[finite(s.x),finite(s.y),finite(s.z)]:info&&info.gravity,t=s?s.t:info&&info.t;
    if(!finite(now)||(s||info)&&!finite(t)){code="motion_invalid_time";message="Motion sensor timing is invalid. Reload this page.";}
    else if(!s&&!info){code="motion_no_event";message="No motion readings yet. Allow motion access and keep this page open.";}
    else if(!gravity||!gravity.every(function(x){return x===true;})){code="motion_gravity_missing";message="This browser is not supplying usable gravity readings. Check motion permission.";}
    else if(info&&info.issue){code=info.issue;message=code==="motion_sparse"?"Motion readings are too far apart. Keep this page visible and hold still.":code==="motion_nonmonotonic"?"Motion readings repeated or went backward in time. Wait for fresh readings.":"A usable gravity vector is required. Hold still and try again.";}
    else if(now<t){code="motion_future_time";message="Motion sensor timing is ahead of the page. Reload this page.";}
    else if(now-t>1000){code="motion_stale";message="Motion readings stopped. Keep this page visible and enable motion access.";}
    else if(!s||[1,-1].indexOf(sign)<0||[1,-1].indexOf(s.sign)<0){code="gravity_sign_unmeasured";message="Hold the phone still for at least half a second with fresh motion and orientation readings.";}
    else if(s.sign!==sign){code="motion_sign_mismatch";message="The measured gravity direction changed. Stop and measure again before running.";}
    else if(!finite(length(s.x,s.y,s.z))||length(s.x,s.y,s.z)<.01){code="motion_gravity_invalid";message="A usable gravity vector is required. Hold still and try again.";}
    return {ok:!code,code:code,message:message,gyro:gyro,gravity:gravity||[false,false,false],sign:s&&[1,-1].indexOf(s.sign)>=0?s.sign:0,age:finite(now)&&finite(t)?now-t:null};
  }
  function frame(s,now,sign,info){
    var d=diagnostic(s,now,sign,info);if(!d.ok)fail(d.code,d.message);
    /* No gyro field: the authored stroke consumes no rotation measurements. */
    return {acc:[s.y,-s.x,s.z],linear:finite(s.linear)?s.linear:null};
  }
  function Controller(p,c,s,now){
    this.cal=F.calibration(c);this.sign=s&&s.sign;frame(s,now,this.sign);this.policy=new Policy(p,this.cal);
    this.start=now;this.last=now;this._ticked=false;this.first=null;this.initialTilt=null;this.tipN=0;this.jerkN=0;this.n=0;this.lastTick=null;
    this.neutral=[Math.round(90+c.L_OFF),Math.round(90+c.R_OFF)];
  }
  Controller.prototype.tick=function(s,now,c){
    if(!finite(now)||now<this.last||this._ticked&&now===this.last||now-this.last>250)throw Error("walk control paused");this.last=now;this._ticked=true;
    var cal=F.calibration(c);if(cal.L_OFF!==this.cal.L_OFF||cal.R_OFF!==this.cal.R_OFF)throw Error("walk calibration changed");
    var f=frame(s,now,this.sign);
    if(now-this.start<1200)return {servo:this.neutral.slice(),prep:true};
    var a=f.acc,mag=length(a[0],a[1],a[2]);if(!finite(mag)||mag<.01)throw Error("gravity signal unavailable");
    var tilt=Math.acos(Math.max(-1,Math.min(1,a[2]/mag)))/D;
    if(this.first===null){this.first=now;this.initialTilt=tilt;}
    /* The grab check exists only when the browser supplies real linear acceleration. */
    if(now-this.first>1000){this.tipN=(tilt>115||(this.initialTilt>=20&&tilt<15)||Math.abs(a[1])/mag>Math.sin(55*D))?this.tipN+1:0;this.jerkN=f.linear!==null&&f.linear>11?this.jerkN+1:0;if(this.tipN>=5||this.jerkN>=6)return {abort:this.tipN>=5?"tipped":"grabbed",tilt:tilt};}
    var out=this.policy.tickBody();out.tilt=tilt;out.prep=false;this.n++;this.lastTick=now;return out;
  };
  root.GBForwardBasic={ID:"growbot-basic-forward-1001",SOURCE_ID:SOURCE_ID,LABEL:"basic screen-forward",Sensors:Sensors,Policy:Policy,Controller:Controller,eventInfo:eventInfo,frame:frame,diagnostic:diagnostic,calibration:F.calibration,nextDeadline:F.nextDeadline};
})(typeof window!=="undefined"?window:this);
