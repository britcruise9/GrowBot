/* Optional hum imitation policy. No microphone, network, storage or motor ownership.
 * The host supplies a kept, pitched ear clip; extraction is not a speech detector. */
(function(root){
  'use strict';
  function asks(text){
    var t=String(text||'').toLowerCase().replace(/[’]/g,"'").replace(/\s+/g,' ').trim();
    if(/\b(?:no|not|never|don't|do not|stop|cancel|quit|without|avoid)\b/.test(t))return false;
    return /^(?:(?:hey[, ]+)?(?:growbot[, ]+)?)?(?:(?:(?:can|could|would|will) you|i(?:'d| would) like you to|i want you to) (?:please )?|please )?(?:copy|imitate|echo|repeat|hum back)(?: (?:me|back))? (?:this|that|my|the|a) (?:hum|humming|tune|melody|song|sound|rhythm)(?:[.!?])?$/.test(t);
  }
  function create(o){
    var core=o.core,now=o.now||Date.now,gen=0,arm=null,offer=null,lastAt=-Infinity,lastSig='',sigAt=-Infinity;
    function emit(why,more){if(o.onEvent)o.onEvent('imitation_agent',Object.assign({why:why},more||{}));}
    function state(){return o.state()||{};}
    function unavailable(s,reply){return s.off||s.muted||s.paused||s.hidden||s.asleep||s.motion||s.ownAudio||s.speechInput||!s.listening||(!reply&&s.thinking);}
    function cancel(why,keepArm){gen++;offer=null;if(!keepArm)arm=null;core.cancel();if(o.stop)o.stop();emit(why||'cancel');}
    function ready(){var s=state();cancel('arm');if(unavailable(s,false)){emit('not_ready');return false;}arm={from:now()+350,until:now()+15000};if(o.ready)o.ready();return true;}
    function holding(){return !!(arm&&now()<arm.until);}
    function clipStart(){cancel('new_clip',true);}
    function valid(id){var s=state(),p=core.peek();return !!(offer&&offer.id===id&&offer.gen===gen&&p&&p.id===id&&now()<p.expiresAt&&s.input===offer.input&&s.motionGen===offer.motionGen&&!unavailable(s,true));}
    function hum(pcm,rate,at){
      var s=state(),requested=!!(arm&&at>=arm.from&&at<=arm.until&&now()<=arm.until),kind=requested?'requested':'spontaneous';
      if(arm&&!requested){emit('waiting_or_expired');if(now()>arm.until)arm=null;return;}
      if(unavailable(s,false)){cancel('busy');return;}
      if(at<Math.max(s.selfUntil||0,s.voiceUntil||0)){cancel('own_audio_overlap');return;}
      if(!requested&&now()-lastAt<45000){emit('cooldown');return;}
      arm=null;var g=++gen,input=s.input,motionGen=s.motionGen;offer=null;
      core.analyze(pcm,rate,{at:at,kind:kind}).then(function(r){
        var cur=state();if(g!==gen||input!==cur.input||motionGen!==cur.motionGen||unavailable(cur,false))return;
        if(!r||!r.ok){emit('no_phrase');return;}
        var p=core.peek();if(!p||p.id!==r.id||now()>=p.expiresAt)return;
        var sig=p.fingerprint||"";
        if(!requested&&sig&&sig===lastSig&&now()-sigAt<120000){core.cancel();emit('same_phrase');return;}
        lastAt=now();lastSig=sig;sigAt=now();offer={id:p.id,gen:g,input:input,motionGen:motionGen};
        emit('offered',{kind:kind,id:p.id,ms:p.ms});
        o.think('A fresh pitched humming phrase was heard. '+(requested?'The person asked to hear an imitation. ':'You may echo it, invent a response, or stay quiet. ')+
          'This is a rough local melody/rhythm measurement, not proof of who made it or whether there were sung words. Do not invent lyrics.',p.id);
      }).catch(function(){if(g===gen)emit('analysis_failed');});
    }
    function guide(id){if(!valid(id))return '';var p=core.peek();return '\nFRESH HUM FOR THIS TURN ONLY: '+JSON.stringify({id:p.id,kind:p.kind,ms:p.ms,eventCount:p.eventCount,summary:p.summary})+
      '\nOptional JSON field imitate:{"id":"'+id+'"} echoes this measured phrase once in your own synth voice, preserving its notes and rests. An imitate reply must use say:"": the echo is the entire response. Omit imitate to stay quiet or invent a separate spoken or sung answer. The summary does not contain a note transcription: never claim an invented answer reproduces the measured notes. Do not combine imitation with sing/sound or body movement. Never echo speech, claim an exact recording, or claim this clip was learned/saved. Older ids and memories are not playable.';}
    function take(id){if(!valid(id)){emit('stale_or_busy');return null;}var p=core.take(id);offer=null;return p;}
    return {arm:ready,holding:holding,clipStart:clipStart,hum:hum,guide:guide,valid:valid,take:take,cancel:cancel,peek:function(){return offer&&valid(offer.id)?core.peek():null;},destroy:function(){cancel('destroy');core.destroy();}};
  }
  root.GBImitationAgent={asks:asks,create:create};
})(typeof window!=='undefined'?window:globalThis);
