/* R3 normal spin, 1005. Frozen Motion Lab inference, each policy's own seed.
   Bench evidence: one stock kit, multiple surfaces. No angle or all-kit guarantee.
   An opt-in bench stall observer may request stock escape; default inference is unchanged. */
(function(root){
  var models={
    cw:{id:"growbot-adaptive-spin-r3-1004-sweep-controlled-cw-0",sha:"ca510c4eeba5cee6fc6213a0537931e5e087901e9fc06a37c791321cf64fa337",path:"/policies/normal-spin-1005/cw.json"},
    ccw:{id:"growbot-adaptive-spin-r3-1004-sweep-controlled-ccw-0",sha:"ac6a19eb1b7be0b77aa97225029d8697519f5eb46c3be9b6a5f57492ada60441",path:"/policies/normal-spin-1005/ccw.json"}
  };
  function select(b,c,q,info){
    if(/[?&]normalspin=0(&|$)/.test(String(q||"")))return {on:false,why:"rollback"};
    if(/[?&]spinwire=0(&|$)/.test(String(q||"")))return {on:false,why:"legacy_wiring_test"};
    if(/[?&]diygait=(fwd|back)(&|$)/.test(String(q||"")))return {on:false,why:"diy_experiment"};
    var s=root.GBForwardWalk.select(b,c,"");if(!s.on)return s;
    if(info&&info.gyro&&info.gyro.some(function(v){return v!==true;}))return {on:false,why:"gyro_unavailable"};
    return {on:true,why:"r3"};
  }
  function infer(policy,obs){
    var x=obs.slice();
    policy.layers.forEach(function(layer,index){
      x=layer.W.map(function(row,j){var v=layer.b[j];for(var i=0;i<row.length;i++)v+=row[i]*x[i];return index<policy.layers.length-1?Math.tanh(v):Math.max(-1,Math.min(1,v));});
    });return x;
  }
  function Runner(policy){this.policy=policy;this.cycle=0;this.time=0;this.amp=1;this.duty=.5;this.frames=[];this.prev=[0,0];}
  Runner.prototype.observation=function(gyro,acc){
    var f=gyro.map(function(v){return Math.max(-3,Math.min(3,v/5));}).concat(acc.map(function(v){return v/9.81;}),this.prev,[Math.sin(2*Math.PI*(this.cycle%1)),Math.cos(2*Math.PI*(this.cycle%1)),(this.amp-1)/1.5,(this.duty-.5)/.2]);
    f=f.map(Math.fround);
    if(!this.frames.length)while(this.frames.length<13)this.frames.push(f.slice());
    else{this.frames.push(f);this.frames=this.frames.slice(-13);}
    return [].concat.apply([],this.frames.slice().reverse());
  };
  Runner.prototype.tick=function(action){
    var a=action.map(function(v){return Math.max(-1,Math.min(1,v));});
    var p=this.policy.contract.seed,c=this.policy.contract;
    var target=1+(a[2]>=0?1.5:.35)*a[2];
    this.amp+=Math.max(-.1,Math.min(.1,target-this.amp));
    this.duty+=Math.max(-.016,Math.min(.016,.5+.2*a[3]-this.duty));
    this.cycle+=p.hz*p.dir/25;
    var duty=this.duty,phase=this.cycle;
    function wave(q){q=((q%1)+1)%1;var x=q<duty ? .5*q/duty:.5+.5*(q-duty)/(1-duty);return Math.sin(2*Math.PI*x);}
    var ramp=Math.max(0,Math.min(1,this.time/.7));ramp=ramp*ramp*(3-2*ramp);
    var j=[p.height+p.amplitude*this.amp*wave(phase),-p.height+p.amplitude*this.amp*wave(phase+p.phase/360)];
    j=j.map(function(v,i){return v*ramp+12*a[i];});
    var cal=c.cal;
    function evenRound(v){var lo=Math.floor(v);return v-lo===.5?(lo%2===0?lo:lo+1):Math.round(v);}
    var cmd=[90+cal.L_OFF+cal.L_SIGN*j[0]*cal.gain,90+cal.R_OFF+cal.R_SIGN*j[1]*cal.gain].map(function(v){return Math.max(0,Math.min(180,evenRound(v)));});
    this.time+=1/25;this.prev=a.slice(0,2);return cmd;
  };
  function Policy(p,c,dir){
    var m=models[dir],k=p&&p.contract;
    if(!m||p.id!==m.id||!k||k.control_hz!==25||k.hist!==13||k.frame_size!==12||k.action_size!==4||k.res_deg!==12||p.layers[0].W[0].length!==156||p.layers[p.layers.length-1].W.length!==4)throw Error("unexpected normal spin policy");
    this.cal=root.GBForwardWalk.calibration(c);
    this.p=Object.assign({},p,{contract:Object.assign({},k,{cal:this.cal})});this.runner=new Runner(this.p);
  }
  Policy.prototype.tickBody=function(g,a){
    var obs=this.runner.observation(g,a),act=infer(this.p,obs),servo=this.runner.tick(act);
    if(!servo.every(function(v){return typeof v==="number"&&isFinite(v)&&v>=0&&v<=180;}))throw Error("invalid spin target");
    return {servo:servo,action:act,obs:obs,gain:this.runner.amp,duty:this.runner.duty};
  };
  function Controller(p,c,s,now,dir){
    var F=root.GBForwardWalk;this.cal=F.calibration(c);this.sign=s&&s.sign;F.frame(s,now,this.sign);
    this.policy=new Policy(p,this.cal,dir);this.start=now;this.last=now;this.first=null;this.tipN=0;this.jerkN=0;this.n=0;this.lastTick=null;
    this.neutral=[Math.round(90+c.L_OFF),Math.round(90+c.R_OFF)];
  }
  Controller.prototype.guard=function(s,now,c){
    var F=root.GBForwardWalk;
    if(!isFinite(now)||now<this.last||now-this.last>250)throw Error("spin control paused");this.last=now;
    var cal=F.calibration(c);if(cal.L_OFF!==this.cal.L_OFF||cal.R_OFF!==this.cal.R_OFF)throw Error("spin calibration changed");
    var f=F.frame(s,now,this.sign);
    if(now-this.start<1200)return {servo:this.neutral.slice(),prep:true};
    var a=f.acc,mag=Math.sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]);if(mag<.01)throw Error("gravity signal unavailable");
    var tilt=Math.acos(Math.max(-1,Math.min(1,a[2]/mag)))*180/Math.PI;
    if(this.first===null)this.first=now;
    if(now-this.first>1000){this.tipN=tilt>115?this.tipN+1:0;this.jerkN=f.linear!==null&&f.linear>11?this.jerkN+1:0;if(this.tipN>=5||this.jerkN>=6)return {abort:this.tipN>=5?"tipped":"grabbed",tilt:tilt};}
    return {frame:f,tilt:tilt,prep:false};
  };
  Controller.prototype.tick=function(s,now,c){
    var g=this.guard(s,now,c);if(g.prep||g.abort)return g;
    var out=this.policy.tickBody(g.frame.gyro,g.frame.acc);out.tilt=g.tilt;out.prep=false;this.n++;this.lastTick=now;return out;
  };
  /* Bench-only net turn observer: project angular velocity onto gravity so pitch/roll rocking
     is not mistaken for room yaw. Evaluate real sensor timestamps, never repeated controller
     ticks. Run averages in the 1008 journal are not validation of this 1.5 s threshold. */
  function StallWatch(){this.rows=[];this.triggered=false;}
  StallWatch.prototype.reset=function(){this.rows=[];};
  StallWatch.prototype.tick=function(s,now,elapsed){
    if(this.triggered)return null;
    var fields=s&&[s.t,s.a,s.b,s.g,s.x,s.y,s.z,s.linear],valid=fields&&fields.every(function(v){return typeof v==="number"&&isFinite(v);});
    if(!valid||elapsed<1000||now<s.t||now-s.t>100||s.linear>=11){this.reset();return null;}
    var m=Math.sqrt(s.x*s.x+s.y*s.y+s.z*s.z);
    /* Only a supported stock upright frame may request bigger steps, never a side/back fall.
       This is not a held detector and is not promoted to unattended use by the bench flag. */
    if(m<.01||s.y<=0||s.z<0){this.reset();return null;}
    var rate=(s.b*s.y+s.a*s.x+s.g*s.z)/m,last=this.rows[this.rows.length-1];
    if(last&&s.t===last.t)return null;
    if(last&&(s.t<last.t||s.t-last.t>100))this.reset();
    this.rows.push({t:s.t,r:rate,x:s.x,y:s.y,z:s.z});
    while(this.rows.length>1&&this.rows[1].t<=s.t-1500)this.rows.shift();
    var first=this.rows[0],span=s.t-first.t;if(span<1500)return null;
    var angle=0,g=[0,0,0];for(var i=1;i<this.rows.length;i++){
      var a=this.rows[i-1],b=this.rows[i],from=Math.max(a.t,s.t-1500),frac=(from-a.t)/(b.t-a.t),r0=a.r+(b.r-a.r)*frac;
      angle+=(r0+b.r)*.5*(b.t-from)/1000;
      ["x","y","z"].forEach(function(k,j){var v=a[k]+(b[k]-a[k])*frac;g[j]+=(v+b[k])*.5*(b.t-from)/1500;});
    }
    var gm=Math.sqrt(g[0]*g[0]+g[1]*g[1]+g[2]*g[2]);
    if(gm<8.3||gm>11.3||g[1]<5.5||Math.abs(g[0])/gm>Math.sin(35*Math.PI/180)||g[2]<0)return null;
    var net=Math.abs(angle)/1.5;
    if(net>=10)return null;
    this.triggered=true;return {windowMs:1500,netDegPerSec:net,samples:this.rows.length,threshold:10,gravityMean:g};
  };
  function load(dir,fetcher,cryptoApi){
    var m=models[dir];if(!m)return Promise.reject(Error("unknown spin direction"));
    return fetcher(m.path).then(function(r){if(!r.ok)throw Error("normal spin unavailable");return r.arrayBuffer();}).then(function(bytes){
      if(!cryptoApi||!cryptoApi.subtle)throw Error("policy verification unavailable");
      return cryptoApi.subtle.digest("SHA-256",bytes).then(function(d){var sha=Array.prototype.slice.call(new Uint8Array(d)).map(function(v){return ("0"+v.toString(16)).slice(-2);}).join("");if(sha!==m.sha)throw Error("spin policy changed; reload");return JSON.parse(new TextDecoder().decode(bytes));});
    });
  }
  root.GBNormalSpin={models:models,select:select,Policy:Policy,Controller:Controller,StallWatch:StallWatch,load:load};
})(typeof window!=="undefined"?window:this);
