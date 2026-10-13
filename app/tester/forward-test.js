/* Tester bridge for the same verified controller as the v3 agent. No calibration writes. */
(function(root){
  function finite(x){return typeof x==='number'&&isFinite(x);}
  function Sensors(){this.o=null;this.sign=0;this.vote=0;this.n=0;this.sample=null;this.event=null;}
  Sensors.prototype.orientation=function(e,t){this.o=finite(e.beta)&&finite(e.gamma)?{b:e.beta,g:e.gamma,t:t}:null;};
  Sensors.prototype.motion=function(e,t){
    var r=e.rotationRate,a=e.accelerationIncludingGravity,o=this.o;
    this.event={t:t,gyro:[!!r&&finite(r.alpha),!!r&&finite(r.beta),!!r&&finite(r.gamma)],
      gravity:[!!a&&finite(a.x),!!a&&finite(a.y),!!a&&finite(a.z)]};
    if(!r||!a||![r.alpha,r.beta,r.gamma,a.x,a.y,a.z].every(finite)){this.sample=null;this.vote=0;this.n=0;return;}
    var m=Math.sqrt(a.x*a.x+a.y*a.y+a.z*a.z),v=0,D=Math.PI/180;
    if(o&&t>=o.t&&t-o.t<=250&&m>=8.3&&m<=11.3&&Math.abs(r.alpha)+Math.abs(r.beta)+Math.abs(r.gamma)<=30){
      var b=o.b*D,g=o.g*D,c=(-a.x*Math.sin(g)*Math.cos(b)+a.y*Math.sin(b)+a.z*Math.cos(g)*Math.cos(b))/m;
      v=c>=.8?1:c<=-.8?-1:0;
    }
    if(v&&v===this.vote)this.n++;else{this.vote=v;this.n=v?1:0;}
    if(v&&this.n>=(this.sign?60:5))this.sign=v;
    var lin=e.acceleration,mag=lin&&[lin.x,lin.y,lin.z].every(finite)?Math.sqrt(lin.x*lin.x+lin.y*lin.y+lin.z*lin.z):null;
    this.sample={t:t,a:r.alpha,b:r.beta,g:r.gamma,x:a.x*this.sign,y:a.y*this.sign,z:a.z*this.sign,sign:this.sign,linear:mag};
  };
  function Runner(h,engine){this.h=h;this.engine=engine||null;this.timer=null;this.active=false;this.serial=0;}
  Runner.prototype.stop=function(why){
    var was=this.active;this.active=false;this.activeEngine=null;this.serial++;if(this.timer!==null)this.h.clear(this.timer);this.timer=null;
    if(was){this.h.release();this.h.status(why||'stopped');}
  };
  Runner.prototype.start=function(p,secs){
    this.stop('replaced');var self=this,h=this.h,F=this.engine||root.GBForwardWalk,label=F.LABEL||'screen-forward',now=h.now(),C;
    if(!h.ready())throw Error('Connect the robot and keep this tab visible.');
    var sample=h.sample();if(F.pick){F=F.pick(sample,h.event?h.event():null);p=F.NO_GYRO?p.noGyro:p.live;}this.activeEngine=F;label=F.LABEL||'screen-forward';sample=h.sample();F.frame(sample,now,sample&&sample.sign,h.event?h.event():null);
    C=new F.Controller(p,h.cal(),sample,now);
    this.active=true;var serial=++this.serial,end=null,due=now;
    h.status('stance: 1.2 seconds, then '+label);
    function tick(){
      if(!self.active||serial!==self.serial)return;
      try{
        var t=h.now();if(!h.ready())throw Error('robot disconnected or tab hidden');
        /* Check current sensors, calibration and scheduling before completing as well. */
        if(t-C.last>250)throw Error('walk control paused');
        F.frame(h.sample(),t,C.sign,h.event?h.event():null);
        var cal=F.calibration(h.cal());if(cal.L_OFF!==C.cal.L_OFF||cal.R_OFF!==C.cal.R_OFF)throw Error('walk calibration changed');
        if(end!==null&&t>=end){self.stop('done: '+label+' walk, legs released');return;}
        var out=C.tick(h.sample(),t,h.cal());if(out.abort)throw Error(out.abort);
        if(!out.prep&&end===null){end=t+secs*1000;h.status('walking '+label+' '+secs+' seconds');}
        h.pose(out.servo[0],out.servo[1]);
        due=F.nextDeadline(due,h.now());self.timer=h.later(tick,Math.max(0,due-h.now()));
      }catch(e){self.stop('stopped: '+e.message);}
    }
    tick();
  };
  root.GBTesterForward={Sensors:Sensors,Runner:Runner};
})(window);
