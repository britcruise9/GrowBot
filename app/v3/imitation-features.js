/* Local prototype. Derived features only; no I/O, storage, or model dependencies. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.GBRhythmFeatures=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var MAX_MS=6000,MAX_EVENTS=24;
  function median(a){var b=a.slice().sort(function(x,y){return x-y;});return b.length?b[Math.floor(b.length/2)]:0;}
  function percentile(a,p){var b=a.slice().sort(function(x,y){return x-y;});return b.length?b[Math.floor((b.length-1)*p)]:0;}
  // Prototype detector searches the whole band at once. The live voice-first detector
  // folds a 660Hz fundamental onto 330Hz before it ever tries the whistle band.
  function pitchAt(f32,off,n,rate){
    var minLag=Math.floor(rate/1700),maxLag=Math.min(n-1,Math.ceil(rate/75)),rs=[],best=0,lag,i,a,b,c,e1,e2;
    for(lag=minLag;lag<=maxLag;lag++){c=0;e1=0;e2=0;for(i=0;i+lag<n;i++){a=f32[off+i];b=f32[off+i+lag];c+=a*b;e1+=a*a;e2+=b*b;}rs[lag]=(e1>0&&e2>0)?c/Math.sqrt(e1*e2):0;best=Math.max(best,rs[lag]);}
    if(best<.80)return null;
    for(lag=minLag+1;lag<maxLag;lag++)if(rs[lag]>=best*.95&&rs[lag]>rs[lag-1]&&rs[lag]>=rs[lag+1]){
      var den=rs[lag-1]-2*rs[lag]+rs[lag+1],delta=den?.5*(rs[lag-1]-rs[lag+1])/den:0,hz=rate/(lag+Math.max(-.5,Math.min(.5,delta)));
      if(hz>=80&&hz<=1600)return {hz:hz,r:rs[lag]};
    }return null;
  }
  function fail(why){return {ok:false,why:why,events:[]};}
  function analyze(input,sr){
    if(!(input instanceof Float32Array)||!Number.isFinite(sr)||sr<16000||sr>192000)return fail('unsupported_input');
    if(input.length<sr*.12)return fail('too_short');
    var length=Math.min(input.length,Math.floor(sr*MAX_MS/1000)),limited=input.length>length,R=16000,step=sr/R,n=Math.floor(length/step),dec=new Float32Array(n),i,j,a,b,sum,max=0;
    for(i=0;i<n;i++){a=Math.floor(i*step);b=Math.min(length,Math.floor((i+1)*step));sum=0;for(j=a;j<b;j++){var v=input[j];if(!Number.isFinite(v))return fail('nonfinite_audio');sum+=Math.max(-1,Math.min(1,v));}dec[i]=sum/Math.max(1,b-a);max=Math.max(max,Math.abs(dec[i]));}
    if(max<.012)return fail('too_quiet');
    var W=320,H=160,frames=[],levels=[];
    for(i=0;i+W<=n;i+=H){sum=0;for(j=0;j<W;j++)sum+=dec[i+j]*dec[i+j];var rms=Math.sqrt(sum/W);frames.push({t:i/R*1000,rms:rms});levels.push(rms);}
    var floor=percentile(levels,.1),threshold=Math.max(.010,Math.min(.016,floor)*2.4),regions=[],start=-1,last=0;
    frames.forEach(function(f){if(start<0){if(f.rms>=threshold){start=f.t;last=f.t+20;}}else if(f.rms>=threshold*.60)last=f.t+20;else if(f.t+20-last>=30){if(last-start>=30)regions.push({start:start,end:last});start=-1;}});
    if(start>=0&&last-start>=30)regions.push({start:start,end:last});
    var merged=[];regions.forEach(function(r){var prev=merged[merged.length-1];if(prev&&r.start-prev.end<=40)prev.end=r.end;else merged.push(r);});regions=merged;
    if(!regions.length)return fail('too_quiet');
    var pitch=[],PW=1024,PH=512;
    for(i=0;i+PW<=n;i+=PH){var t=(i+PW/2)/R*1000,region=regions.some(function(r){return t>=r.start&&t<=r.end;});if(!region)continue;sum=0;for(j=0;j<PW;j++)sum+=dec[i+j]*dec[i+j];if(Math.sqrt(sum/PW)<threshold*.6)continue;var p=pitchAt(dec,i,PW,R);pitch.push({t:t,hz:p?p.hz:0,r:p?p.r:0});}
    var voiced=pitch.filter(function(p){return p.hz>0;}),ratio=pitch.length?voiced.length/pitch.length:0;
    var transient=regions.filter(function(r){return r.end-r.start<=300;}),rhythm=regions.length>=2&&transient.length===regions.length;
    if(ratio<.55&&!rhythm)return fail('no_clear_tune_or_rhythm');
    var events=[],origin=regions[0].start,peakRms=Math.max.apply(null,levels);
    regions.forEach(function(r){
      var ps=pitch.filter(function(p){return p.hz>0&&p.t>=r.start&&p.t<r.end;}),level=median(frames.filter(function(f){return f.t>=r.start&&f.t<r.end;}).map(function(f){return f.rms;}))/Math.max(.001,peakRms);
      if(ps.length<2){events.push({t:Math.round(r.start-origin),ms:Math.round(r.end-r.start),hz:null,level:Math.max(.15,Math.min(1,level)),kind:'pulse'});return;}
      var groups=[],g={start:r.start,pitches:[ps[0].hz]},k=1;
      for(;k<ps.length;k++){var med=median(g.pitches),different=Math.abs(ps[k].hz-med)/med>.08,next=ps[k+1],next2=ps[k+2],stable=next&&next2&&Math.abs(next.hz-ps[k].hz)/ps[k].hz<.06&&Math.abs(next2.hz-ps[k].hz)/ps[k].hz<.06;
        if(different&&stable&&ps[k].t-g.start>=120){var boundary=Math.max(g.start+50,ps[k].t-16);g.end=boundary;groups.push(g);g={start:boundary,pitches:[ps[k].hz]};}else g.pitches.push(ps[k].hz);}
      g.end=r.end;groups.push(g);groups.forEach(function(q){events.push({t:Math.round(q.start-origin),ms:Math.round(q.end-q.start),hz:Math.round(median(q.pitches)*10)/10,level:Math.max(.15,Math.min(1,level)),kind:'tone'});});
    });
    if(events.length>MAX_EVENTS)return fail('too_many_beats');
    var duration=events.length?events[events.length-1].t+events[events.length-1].ms:0;
    return {ok:true,events:events,ms:duration,capturedMs:Math.round(length/sr*1000),pitchFraction:Math.round(ratio*100)/100,limited:limited,unpitched:events.some(function(e){return e.hz===null;}),timingResolutionMs:20};
  }
  // Move an entire phrase by an octave, never individual notes: preserve intervals.
  // If its range cannot fit the speaker-friendly band, keep measured pitches.
  function playbackShift(events){
    var hz=events.filter(function(e){return Number.isFinite(e.hz)&&e.hz>0;}).map(function(e){return e.hz;});
    if(!hz.length)return {factor:1,outsideBand:false};
    var low=Math.min.apply(null,hz),high=Math.max.apply(null,hz),lo=Math.ceil(Math.log2(170/low)),hi=Math.floor(Math.log2(900/high));
    if(lo>hi)return {factor:1,outsideBand:low<170||high>900};
    return {factor:Math.pow(2,Math.max(lo,Math.min(hi,0))),outsideBand:false};
  }
  return {analyze:analyze,pitchAt:pitchAt,playbackShift:playbackShift,MAX_MS:MAX_MS,MAX_EVENTS:MAX_EVENTS};
});
