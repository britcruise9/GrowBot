/* 1008 GrowBot expressions: deterministic pose recipes and the same warm synth family as singing.
   No transport, sensor claims, persistent settings or automatic motion live in this module. */
(function(root){
  "use strict";
  var recipes={
    purr:{sound:"purr",points:[[0,0,300],[7,3,1350],[0,0,1350],[7,-3,1350],[0,0,1650]]},
    breathe:{sound:"purr",points:[[0,0,300],[9,2,2200],[4,-2,1500],[0,0,2000]]},
    sigh:{sound:"sigh",points:[[0,0,300],[6,2,1500],[-5,-2,2300],[0,0,1900]]},
    perk:{sound:"giggle",points:[[0,0,300],[10,3,900],[7,-3,900],[0,0,900]]},
    shiver:{sound:"rumble",points:[[0,0,300],[2,7,700],[-2,-7,700],[2,7,700],[-2,-7,700],[2,7,700],[0,0,1000]]},
    droop:{sound:"yawn",points:[[0,0,300],[-9,3,2200],[-6,-3,1700],[0,0,2300]]}
  };
  var sounds={
    purr:{seconds:5.8,hz:[105,112,102],pulse:25,depth:0.65,level:0.12},
    rumble:{seconds:5.8,hz:[75,110,82],pulse:22,depth:0.5,level:0.12},
    sigh:{seconds:5.8,hz:[370,220,120],pulse:4.8,depth:0.08,level:0.11},
    yawn:{seconds:6.3,hz:[150,390,135],pulse:5.2,depth:0.15,level:0.11},
    giggle:{seconds:2.8,hz:[430,610,360],pulse:4.5,depth:0.96,level:0.10}
  };
  function soundName(x){ x=String(x||"").toLowerCase().trim(); if(x==="truck"||x==="engine")x="rumble"; return Object.prototype.hasOwnProperty.call(sounds,x)?x:""; }
  // Seeds are starting contours, not a vocabulary limit. The model may supply its own
  // time/pitch/pulse/energy points, with or without a seed. No code or audio URLs.
  function soundPlan(input){
    var object=input&&typeof input==="object"&&!Array.isArray(input),name=typeof input==="string"?soundName(input):object?soundName(input.seed):"";
    if(!object&&!name)return null;
    if(object&&Object.keys(input).some(function(k){return k!=="seed"&&k!=="points";}))return null;
    if(object&&Object.prototype.hasOwnProperty.call(input,"seed")&&(typeof input.seed!=="string"||!name))return null;
    var s=name?sounds[name]:null,source=object&&Object.prototype.hasOwnProperty.call(input,"points")?input.points:null;
    if(source===null){
      if(!s||object&&Object.prototype.hasOwnProperty.call(input,"points"))return null;
      return {name:name,seed:name,ms:s.seconds*1000,points:[0,0.42,1].map(function(t,i){return {ms:t*s.seconds*1000,hz:s.hz[i],pulse:s.pulse,depth:s.depth,gain:s.level/0.12};})};
    }
    if(!Array.isArray(source)||source.length<2||source.length>16)return null;
    var prev={ms:-1,hz:s?s.hz[0]:240,pulse:s?s.pulse:0,depth:s?s.depth:0,gain:s?s.level/0.12:0.8},points=[];
    for(var i=0;i<source.length;i++){
      var p=source[i];if(!p||typeof p!=="object"||Array.isArray(p)||Object.keys(p).some(function(k){return ["ms","hz","pulse","depth","gain"].indexOf(k)<0;}))return null;
      if(typeof p.ms!=="number"||!Number.isFinite(p.ms)||p.ms<0||p.ms>12000||p.ms<=prev.ms||(i===0&&p.ms!==0))return null;
      if(i===0&&!s&&!Object.prototype.hasOwnProperty.call(p,"hz"))return null;
      var q={ms:p.ms,hz:prev.hz,pulse:prev.pulse,depth:prev.depth,gain:prev.gain};
      for(var k of ["hz","pulse","depth","gain"]){if(Object.prototype.hasOwnProperty.call(p,k)){
        if(typeof p[k]!=="number"||!Number.isFinite(p[k]))return null;q[k]=p[k];}}
      if(q.hz<60||q.hz>1600||q.pulse<0||q.pulse>40||q.depth<0||q.depth>1||q.gain<0||q.gain>1)return null;
      points.push(q);prev=q;
    }
    if(prev.ms<120)return null;
    return {name:"composed",seed:name,ms:prev.ms,points:points};
  }
  function recipe(x){ return typeof x==="string"&&Object.prototype.hasOwnProperty.call(recipes,x)?recipes[x]:null; }
  function plan(name,stance,band){
    var r=recipe(name); if(!r||!stance||!Number.isFinite(stance.l)||!Number.isFinite(stance.r))return null;
    band=band||[0,180]; if(stance.l<band[0]||stance.l>band[1]||stance.r<band[0]||stance.r>band[1])return null;
    var peak=0,steps=r.points.map(function(p){ var l=Math.max(band[0],Math.min(band[1],Math.round(stance.l-p[0]+p[1]))), rr=Math.max(band[0],Math.min(band[1],Math.round(stance.r+p[0]+p[1]))); peak=Math.max(peak,Math.abs(l-stance.l),Math.abs(rr-stance.r)); return {l:l,r:rr,ms:p[2]}; });
    // A wire anchor can be fractional in commanded space when its trim is fractional.
    // Keep exact endpoints; only the transport rounds after adding the trim.
    steps[0].l=steps[steps.length-1].l=stance.l; steps[0].r=steps[steps.length-1].r=stance.r;
    if(peak<5||peak>15)return null;
    return {name:name,sound:r.sound,steps:steps,ms:steps.reduce(function(a,s){return a+s.ms;},0),peak:peak};
  }
  function gate(s){
    if(!s.bench)return "held_detection_unproven"; // stillness and orientation cannot prove not-held
    if(!s.explicit)return "explicit_expression_required";
    if(s.inhibited)return "person_asked_still";
    if(s.paused)return "paused";
    if(s.asleep)return "asleep";
    if(!s.online)return "no_body";
    if(s.busy)return "busy";
    if(!s.floorConfirmed)return "confirm_floor_for_bench";
    if(!s.sensorFresh)return "sensor_missing_or_stale";
    if(s.handling)return "handling";
    if(!s.upright)return "not_upright";
    if(!s.stanceKnown)return "stance_unknown";
    return "";
  }
  function playSound(ctx,out,input){
    var s=soundPlan(input);if(!s||!ctx||!out)return null;
    var t=ctx.currentTime+0.025,end=t+s.ms/1000,o=ctx.createOscillator(),g=ctx.createGain(),voice=ctx.createGain(),amp=ctx.createGain(),lfo=ctx.createOscillator(),depth=ctx.createGain();
    // Warm harmonics retain the instrument's voice and make a low carrier audible on phone speakers.
    try{o.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0,1,0.45,0.18,0.08]),new Float32Array([0,0,0,0,0])));}catch(e){o.type="triangle";}
    s.points.forEach(function(p,i){var at=t+p.ms/1000,method=i?"linearRampToValueAtTime":"setValueAtTime";
      o.frequency[i?"exponentialRampToValueAtTime":"setValueAtTime"](p.hz,at);
      amp.gain[method](1-p.depth/2,at);depth.gain[method](p.depth/2,at);lfo.frequency[method](p.pulse,at);voice.gain[method](p.gain,at);
    });
    lfo.connect(depth); depth.connect(amp.gain); o.connect(amp); amp.connect(voice);voice.connect(g); g.connect(out);
    g.gain.setValueAtTime(0.0001,t); g.gain.linearRampToValueAtTime(0.12,t+Math.min(0.18,s.ms/4000)); g.gain.setValueAtTime(0.12,end-Math.min(0.35,s.ms/4000)); g.gain.linearRampToValueAtTime(0.0001,end);
    o.start(t); lfo.start(t); o.stop(end+0.025); lfo.stop(end+0.025);
    var done=false; function disconnect(){[o,lfo,depth,amp,voice,g].forEach(function(n){try{n.disconnect();}catch(e){}});}
    o.onended=disconnect;
    return {name:s.name,seed:s.seed,ms:Math.ceil(s.ms+50),stop:function(){if(done)return;done=true;var n=ctx.currentTime,fade=0.012;
      // Keep the current envelope value and release over 12 ms instead of a discontinuous cut.
      // The fallback evaluates this simple envelope for browsers without cancelAndHoldAtTime.
      try{if(typeof g.gain.cancelAndHoldAtTime==="function")g.gain.cancelAndHoldAtTime(n);
        else{var attack=Math.min(0.18,s.ms/4000),release=Math.min(0.35,s.ms/4000),v=n<t?0.0001:n<t+attack?0.0001+(0.12-0.0001)*(n-t)/attack:n<end-release?0.12:n<end?0.0001+(0.12-0.0001)*(end-n)/release:0.0001;
          g.gain.cancelScheduledValues(n);g.gain.setValueAtTime(v,n);}
        g.gain.linearRampToValueAtTime(0,n+fade);o.stop(n+fade);lfo.stop(n+fade);
      }catch(e){disconnect();}}};
  }
  root.GBExpression={recipe:recipe,plan:plan,gate:gate,soundName:soundName,soundPlan:soundPlan,playSound:playSound};
})(typeof window!=="undefined"?window:globalThis);
