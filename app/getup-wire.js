/* Stock screen-up get-up preview, 0930. This file is NOT loaded by the live agent.
   The get-up has its own tested wire convention; saved walk calibration stays untouched.
   Math below is the existing agent port of Motion Lab's RECOVERY / Engine.tick.
   Fixture provenance and exact-tick parity are checked by getupwiretest.js. */
(function(root){
  var VERSION="stock-screen-up-0930-v1", BODY_ID="growbot-85mm-2leg";
  var REC_RECIPE={hz:1,amplitude:80,height:0,lean:0,ratio:1,direction:1,slew:400,direct:false,seconds:5};
  var REC_BLEND_MS=700, REC_GAP_S=.25;
  function finite(x){return typeof x==="number"&&isFinite(x);}
  function number(x,lo,hi){return finite(x)&&x>=lo&&x<=hi;}
  function sign(x){return x===1||x===-1;}
  function snapshot(c){
    if(!c||!sign(c.L_SIGN)||!sign(c.R_SIGN)||!number(c.L_OFF,-45,45)||!number(c.R_OFF,-45,45)||
      !number(c.gain,0,1.5)||!number(c.turn,-45,45)||!Array.isArray(c.IMU_SIGN)||
      c.IMU_SIGN.length!==3||!c.IMU_SIGN.every(sign))throw Error("invalid_calibration");
    if(c.SWAP!==undefined&&c.SWAP!==null&&c.SWAP!==false&&c.SWAP!==0)throw Error("swap_not_supported");
    if(c.L_SIGN!==c.R_SIGN&&!(c.L_SIGN===-1&&c.R_SIGN===1))throw Error("unequal_signs_not_tested");   // 1007, for Codex review: the stock body.json -1/+1 is admitted too (select() runs every record at -1/-1); +1/-1 still refuses
    return {L_SIGN:c.L_SIGN,R_SIGN:c.R_SIGN,L_OFF:c.L_OFF,R_OFF:c.R_OFF,gain:c.gain,turn:c.turn,
      SWAP:false,IMU_SIGN:c.IMU_SIGN.slice()};
  }
  function bodyBand(b,mode){
    if(mode!=="legs"||!b||b.id!==BODY_ID||b.present===false||!b.walk||b.walk.present===false||
      !Array.isArray(b.servos)||b.servos.length!==2)throw Error("stock_two_leg_body_only");
    var lo=0,hi=180,wires={};
    b.servos.forEach(function(s){
      if(!s||["l","r"].indexOf(s.wire)<0||wires[s.wire]||!number(s.min,0,180)||!number(s.max,0,180)||s.min>=s.max||
        !Array.isArray(s.band)||s.band.length!==2||!number(s.band[0],s.min,s.max)||
        !number(s.band[1],s.min,s.max)||s.band[0]>=s.band[1])throw Error("invalid_servo_band");
      wires[s.wire]=true;lo=Math.max(lo,s.band[0]);hi=Math.min(hi,s.band[1]);
    });
    if(lo>=hi)throw Error("invalid_servo_band");
    return [lo,hi];
  }
  function select(body,source,mode){
    var band=bodyBand(body,mode),src=snapshot(source),cal=snapshot(src);
    cal.L_SIGN=-1;cal.R_SIGN=-1;cal.gain=.99;cal.turn=0;
    var neutral=_recServo([0,0],cal),foldRaw=_recServo(_recJoints(0),cal);
    if(neutral.some(function(v){return v<band[0]||v>band[1];})||
      foldRaw.some(function(v){return v<band[0]-5||v>band[1]+5;}))throw Error("outside_band");
    var out={version:VERSION,bodyId:BODY_ID,mode:mode,source:src,cal:cal,band:band,neutral:neutral,
      foldRaw:foldRaw,fold:foldRaw.map(function(v){return Math.max(band[0],Math.min(band[1],v));})};
    /* Caller/UI cannot mutate the active mapping after admission. */
    Object.freeze(src.IMU_SIGN);Object.freeze(cal.IMU_SIGN);Object.freeze(src);Object.freeze(cal);
    Object.freeze(band);Object.freeze(neutral);Object.freeze(foldRaw);Object.freeze(out.fold);
    return Object.freeze(out);
  }
  function unchanged(selection,body,source,mode){
    try{return JSON.stringify(selection)===JSON.stringify(select(body,source,mode));}catch(e){return false;}
  }
  function _recSmooth(t){ t=Math.max(0,Math.min(1,t)); return t*t*(3-2*t); }
  function _recJoints(cycle){ var p=REC_RECIPE, t=Math.abs(cycle), h=t<1?-p.amplitude:t<2?-p.amplitude*(1-_recSmooth(t-1)):0; return [h,-h]; }
  function _recServo(j,c){ var out=[90+c.L_OFF+c.L_SIGN*j[0]*c.gain+c.turn,90+c.R_OFF+c.R_SIGN*j[1]*c.gain-c.turn];
    if(out.some(function(x){ return !isFinite(x)||x<0||x>180; })) throw new Error("outside_servo_bounds"); return out; }
  function _recEngine(c,now,initial,band){ return {cal:c,band:band,start:now,last:now,cycle:0,sent:initial.slice(),initial:initial.slice(),dtMax:0,stepMax:0,bufMax:0}; }
  function _recTick(e,now,hold){ var p=REC_RECIPE, dt=(now-e.last)/1000, raw, ramp, desired, prev=e.sent;
    if(!isFinite(dt)||dt<0||dt>REC_GAP_S) throw new Error("timer_gap");
    e.last=now; if(!hold) e.cycle+=dt*p.hz*p.direction;
    raw=_recServo(hold?[p.height+p.lean,-p.height+p.lean]:_recJoints(e.cycle),e.cal).map(function(v){ return e.band?Math.max(e.band[0],Math.min(e.band[1],v)):v; }); ramp=_recSmooth((now-e.start)/REC_BLEND_MS);
    desired=raw.map(function(v,i){ return e.initial[i]+(v-e.initial[i])*ramp; });
    e.sent=desired.map(function(v,i){ var step=v-e.sent[i]; return p.direct?v:e.sent[i]+Math.max(-p.slew*dt,Math.min(p.slew*dt,step)); });
    e.dtMax=Math.max(e.dtMax,dt); e.stepMax=Math.max(e.stepMax,Math.abs(e.sent[0]-prev[0]),Math.abs(e.sent[1]-prev[1]));
    return {sent:e.sent.slice(),desired:desired,raw:raw}; }
  function Engine(selection,now,initial){
    if(!selection||selection.version!==VERSION||!finite(now))throw Error("invalid_engine_setup");
    var p=initial||selection.neutral;
    if(!Array.isArray(p)||p.length!==2||!p.every(function(v){return number(v,selection.band[0],selection.band[1]);}))throw Error("invalid_initial_pose");
    Object.assign(this,_recEngine(selection.cal,now,p,selection.band));
  }
  Engine.prototype.tick=function(now,hold){return _recTick(this,now,hold);};
  /* Preview uses a measured gravity sign, in stock phone coordinates. It has no learned-up
     history from the agent origin. Unlike the agent, unknown sensors always refuse a start. */
  function posture(samples,now,since){
    var from=Math.max(now-1000,finite(since)?since:-Infinity),last=-Infinity,first=null,n=0,kind="",mixed=false,moving=false,sgn=0,invalid=false,reason="",magnitude=null;
    if(!Array.isArray(samples)||!finite(now))return {kind:"unknown",upright:-1,n:0};
    samples.forEach(function(s){
      if(!s||!finite(s.t)||s.t<from||s.t>now)return;
      if(s.t<=last){invalid=true;reason=reason||"non_monotonic_time";return;}last=s.t;if(first===null)first=s.t;n++;
      if(![s.x,s.y,s.z,s.a,s.b,s.g,s.linear].every(finite)||!sign(s.sign)){invalid=true;reason=reason||"invalid_sample";return;}
      if(sgn&&sgn!==s.sign){invalid=true;reason=reason||"sign_changed";}sgn=s.sign;
      var mag=Math.sqrt(s.x*s.x+s.y*s.y+s.z*s.z);
      if(mag<8.3||mag>11.3){invalid=true;reason=reason||"gravity_magnitude";magnitude=mag;}
      if(s.linear>=2.5||Math.abs(s.a)+Math.abs(s.b)+Math.abs(s.g)>30)moving=true;
      var k=s.y>=5.5?"up":s.z>=6?"screen_up":s.z<=-6?"screen_down":Math.abs(s.x)>=6?"side":"slant";
      if(kind&&kind!==k)mixed=true;kind=k;
    });
    if(invalid||n<5||now-last>250||last-first<200){kind="unknown";reason=reason||(n<5?"sample_count":now-last>250?"sample_stale":"sample_span");}
    else if(moving)kind="moving";
    else if(mixed)kind="mixed";
    return {kind:kind||"unknown",upright:kind==="up"?1:/^(screen_up|screen_down|side|slant)$/.test(kind)?0:-1,n:n,reason:reason||(moving?"moving":mixed?"mixed":""),age:finite(last)?now-last:null,span:first===null?0:last-first,magnitude:magnitude};
  }
  root.GBGetupWire={VERSION:VERSION,BODY_ID:BODY_ID,TICK_MS:40,SECONDS:5,select:select,unchanged:unchanged,Engine:Engine,posture:posture};
})(typeof window!=="undefined"?window:this);
