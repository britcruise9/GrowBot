/* Shared named/automatic recovery adapter. The immutable Motion Lab engine owns all pose math.
   Automatic admission is a separate internal contract, never a forged human request. */
(function(root){
  'use strict';
  function finite(n){return typeof n==='number'&&isFinite(n);}
  function rawSafe(raw){var c=raw===null?{}:JSON.parse(raw);if(!c||typeof c!=='object'||Array.isArray(c))throw Error('invalid_saved_calibration');
    if(c.SWAP!==undefined&&c.SWAP!==null&&c.SWAP!==false&&c.SWAP!==0)throw Error('swap_not_supported');return raw;}
  function fresh(s,t,sign){if(!s||![s.t,s.x,s.y,s.z,s.a,s.b,s.g,s.linear].every(finite)||
    (s.sign!==1&&s.sign!==-1)||s.t>t||t-s.t>250)throw Error('sensor_missing_or_stale');if(sign&&s.sign!==sign)throw Error('gravity_sign_changed');return s;}
  /* 1006 SPEED COMPARISON (lab only): a start may ask for k in SPEEDS; anything else is refused before any frame.
     Only the movement stretches (the fold and push, 2000 ms at k=1, take 2000/k through a slowed engine clock); the
     neutral tail, the upright read, its deadline, the hold and the own-motion tail keep their real-time lengths from
     the stretched sweep end. k=1 is 5000/6000/9000/65000/8500 ms and the engine sees the real clock, as before. Gap,
     freshness, posture and the 40 ms tick stay in real time at every k. The page's model path never passes a speed. */
  var SPEEDS=[1,.75,.5];
  function profile(k){var mo=2000/k,se=mo+3000;return {k:k,motionMs:mo,sweepEndMs:se,settleFromMs:se+1000,settleByMs:se+4000,holdEndMs:se+60000,selfMoveMs:se+3500};}
  function Runner(h){this.h=h;this.active=false;this.phase='idle';this.timer=null;this.serial=0;this.spent=-1;this.lastResult='not_run';}
  Runner.prototype.inspect=function(){var h=this.h,G=root.GBGetupWire,t=h.now(),c=h.context(),s=fresh(h.sample(),t);
    if(!G)throw Error('adapter_not_loaded');
    if(!c.enabled||c.paused||c.hidden||c.dreaming||c.asleep)throw Error('not_available');
    if(c.busy)throw Error('body_busy');
    if(!c.transport||!c.ready||c.awake!==1||!c.ws||c.buffer!==0||!finite(c.generation))throw Error('body_unavailable');
    return {selection:G.select(h.body(),h.source(),h.mode()),raw:rawSafe(h.raw()),sample:s,context:c,posture:G.posture(h.samples(),t)};};
  Runner.prototype.cancel=function(why){if(!this.active)return;this.active=false;this.serial++;if(this.timer!==null)this.h.clear(this.timer);this.timer=null;
    this.phase='idle';this.lastResult=why||'stopped';this.h.ended(this.lastResult,{everUpright:!!this.confirmed,posture:root.GBGetupWire.posture(this.h.samples(),this.h.now()).kind});};
  Runner.prototype.start=function(request){
    if(this.active)throw Error('already_running');
    var h=this.h,G=root.GBGetupWire,t=h.now(),check=this.inspect(),c=check.context,p=check.posture,self=this;
    var automatic=!!(request&&request.trigger==='automatic');
    if(automatic){if(!finite(request.id)||request.id<=0||!h.automatic||h.automatic(request)!==true)throw Error('automatic_recovery_not_admitted');
      if(this.autoSpent===request.id)throw Error('one_try_per_episode');}
    else {if(!request||!request.explicit||!finite(request.id)||!finite(request.age)||request.age<0||request.age>60000)throw Error('current_get_up_request_required');
      if(this.spent===request.id)throw Error('one_try_per_ask');}
    var k=request.speed===undefined?1:request.speed,P;if(SPEEDS.indexOf(k)<0)throw Error('speed_not_offered');P=profile(k);
    if(h.samples().some(function(s){return s.t>=t-1000&&s.y<=-5.5;}))throw Error('inverted_phone_mount');
    if(p.kind!=='screen_up')throw Error('start_screen_up_'+p.kind);
    h.acquire();
    // Acquisition cancels prior holds and advances the shared motion generation.
    c=h.context();if(c.busy)throw Error('body_busy');
    this.selection=check.selection;this.raw=check.raw;this.context=c;this.sign=check.sample.sign;
    this.engine=new G.Engine(this.selection,t,this.selection.neutral);this.started=t;this.last=t;this.profile=P;
    if(automatic)this.autoSpent=request.id;else this.spent=request.id;this.trigger=automatic?'automatic':'named';this.requestId=request.id;this.active=true;this.phase='sweep';this.lastResult='running';this.confirmed=false;
    var serial=++this.serial;
    h.owned(this);
    function tick(){if(!self.active||serial!==self.serial)return;
      try{var now=h.now(),n=h.context(),s=fresh(h.sample(),now,self.sign),hold=now-t>=P.sweepEndMs,out,post;
        if(!finite(now)||now<self.last||now-self.last>250)throw Error('timer_gap');
        if(!n.enabled||n.paused||n.hidden||n.dreaming||n.asleep||!n.ready||n.awake!==1||n.buffer!==0)throw Error('body_or_page_unavailable');
        if(n.transport!==c.transport||n.ws!==c.ws||n.generation!==c.generation||n.robotId!==c.robotId||n.epoch!==c.epoch||n.owner!==c.owner)throw Error('owner_or_connection_changed');
        if(rawSafe(h.raw())!==self.raw||!G.unchanged(self.selection,h.body(),h.source(),h.mode()))throw Error('calibration_or_body_changed');
        self.last=now;
        if(hold&&self.phase==='sweep'){self.phase='settling';h.event('recover_sweep_finished',{elapsedMs:now-t});}
        if(hold&&now-t>=P.settleFromMs){
          post=G.posture(h.samples(),now,t+P.sweepEndMs);
          if(self.phase==='settling'){
            if(post.kind==='up'){self.phase='holding';self.confirmed=true;self.lastResult='upright_observed';h.event('recover_upright_observed',{post:post.kind,n:post.n});}
            else if(now-t>=P.settleByMs)throw Error('upright_not_confirmed_'+post.kind);
          }else if(post.kind!=='up')throw Error('hold_posture_'+post.kind);
        }
        if(now-t>=P.holdEndMs){h.stop('hold_finished');return;}
        out=self.engine.tick(k===1?now:t+k*(now-t),hold);h.pose(out.sent[0],out.sent[1],c);
        if(!self.sent){self.sent=true;h.event('recover_started',{version:G.VERSION,source:self.selection.source,effective:self.selection.cal,neutral:self.selection.neutral,fold:self.selection.fold});}
        var due=t+(Math.floor((h.now()-t)/G.TICK_MS)+1)*G.TICK_MS;
        self.timer=h.later(tick,Math.max(0,due-h.now()));
      }catch(e){h.stop(e.message);}
    }
    this.sent=false;tick();return this.active;
  };
  root.GBGetupAgent={Runner:Runner,SPEEDS:SPEEDS.slice(),profile:profile};
})(typeof window!=='undefined'?window:this);
