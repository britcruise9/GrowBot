/* Stage 1: private, log-only eye. ES5. No fetch, model, motor, soul or prompt access.
   Thresholds are experimental, not qualified place recognition or navigation. */
(function(root){
  'use strict';
  var KEY='gb_world_eye_v1', LIMIT=262144, HOUR=3600000, KINDS=['walk','spin','gesture','recover','drive','other'];
  function num(v){return typeof v==='number'&&isFinite(v);}
  function copy(v){return v==null?null:JSON.parse(JSON.stringify(v));}
  function round(v){return Math.round(v*1000)/1000;}
  function mod(v,n){return ((v%n)+n)%n;}
  function sector(y){return num(y)?mod(Math.floor((y+22.5)/45),8):null;}
  function angle(a,b){var d=0,aa=0,bb=0,i;for(i=0;i<3;i++){d+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}return aa&&bb?Math.acos(Math.max(-1,Math.min(1,d/Math.sqrt(aa*bb))))*180/Math.PI:180;}
  function validView(v){return v&&Array.isArray(v.b)&&v.b.length===108&&v.b.every(function(x){return num(x)&&Math.abs(x)<=4;})&&/^[0-9a-f]{16}$/.test(v.h)&&Array.isArray(v.mask)&&v.mask.length===108&&v.mask.every(function(x){return x===0||x===1;})&&num(v.t)&&num(v.days)&&v.days>=1&&v.days<=36600&&typeof v.day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v.day)&&(v.yaw===null||num(v.yaw));}
  function fingerprint(luma){
    if(!luma||luma.length!==1728)return null;
    var b=[],x,y,xx,yy,i,s,mean,sd,vals=[],lo=255,hi=0;
    for(y=0;y<9;y++)for(x=0;x<12;x++){
      s=0;for(yy=0;yy<4;yy++)for(xx=0;xx<4;xx++){var v=luma[(y*4+yy)*48+x*4+xx];if(!num(v)||v<0||v>255)return null;s+=v;}
      b.push(s/16);lo=Math.min(lo,s/16);hi=Math.max(hi,s/16);
    }
    if(hi-lo<12)return null; // an empty wall does not identify a place
    // Twelve 3x3 patches: cancel local additive light and multiplicative exposure.
    for(y=0;y<9;y+=3)for(x=0;x<12;x+=3){
      mean=0;sd=0;for(yy=0;yy<3;yy++)for(xx=0;xx<3;xx++)mean+=b[(y+yy)*12+x+xx]/9;
      for(yy=0;yy<3;yy++)for(xx=0;xx<3;xx++)sd+=Math.pow(b[(y+yy)*12+x+xx]-mean,2)/9;
      sd=Math.max(8,Math.sqrt(sd));for(yy=0;yy<3;yy++)for(xx=0;xx<3;xx++){i=(y+yy)*12+x+xx;vals[i]=round(Math.max(-4,Math.min(4,(b[i]-mean)/sd)));}
    }
    // 64 neighbour comparisons encoded as 16 hex digits (no BigInt).
    var hash='',nibble=0;
    for(i=0;i<64;i++){y=Math.floor(i/8);x=i%8+1;nibble=(nibble<<1)|(vals[y*12+x]>vals[y*12+x+1]?1:0);if(i%4===3){hash+=nibble.toString(16);nibble=0;}}
    return {b:vals,h:hash,mask:vals.map(function(){return 0;})};
  }
  function distance(a,b){var s=0,n=0,close=0,i;for(i=0;i<108;i++)if(!a.mask[i]&&!b.mask[i]){var d=Math.abs(a.b[i]-b.b[i]);s+=Math.min(d,3);if(d<.3)close++;n++;}return n<72?null:{mean:s/n,close:close/n,n:n};}
  function make(opt){
    opt=opt||{};var now=opt.now||function(){return root.performance&&root.performance.now?root.performance.now():Date.now();}, wall=opt.wall||Date.now, store=opt.storage, emit=opt.emit||function(){}, clock=opt.clock||now;
    var db={v:1,next:1,spots:[],moves:[]}, cur=null, ctx='', pendingSpot=true, active={}, pending=[], yaw=null, rot=null, oriT=0, imuT=0, gravity=null, steadySince=0, handled=false, riding=false, tipHold=false, lastObs=null, lastFrame=0, dirty=false, history=[], flips=[], priorDelta=[], anchor=0, hourAt=now(), lastAccepted=0, counts, disabledStore=false, paused=false, lastEnded=null,tipAt=0,postTip=false,headingGap=false,matchCache=null;
    function blank(){var c={v:1,window_ms:0,frames:0,accepted:0,new_views:0,seen_views:0,changed_views:0,post_tip_views:0,masked_blocks:0,spots_new:0,spots_seen:0,heading_gaps:0,reanchors:0,reanchor_deg_sum:0,rejected:0,unsettled:0,unusable:0,storage_errors:0,move_unobserved:0,frame_us_sum:0,frame_us_max:0,still_ms:0};KINDS.forEach(function(k){c[k+'_n']=0;c[k+'_tip']=0;c[k+'_settled']=0;c[k+'_settle_ms']=0;c[k+'_asked']=0;c[k+'_self']=0;c[k+'_unknown']=0;c[k+'_change_sum']=0;});return c;}
    counts=blank();
    try{var raw=store&&store.getItem(KEY);if(raw&&raw.length*2<=LIMIT){var d=JSON.parse(raw);if(d.v===2&&Array.isArray(d.spots)&&d.spots.length<=24&&d.spots.every(function(p){return p&&num(p.id)&&typeof p.ctx==='string'&&p.ctx.length<200&&num(p.t)&&p.views&&Object.keys(p.views).length<=9&&Object.keys(p.views).every(function(k){return /^(?:[0-7]|u)$/.test(k)&&validView(p.views[k]);});})){db.spots=d.spots;db.next=db.spots.reduce(function(m,p){return Math.max(m,p.id+1);},1);}}}catch(e){counts.storage_errors++;}
    // Persist only validated views across loads. Move history is bounded and starts anew per visit.
    function evict(){if(!db.spots.length)return false;var pool=db.spots.filter(function(p){return p!==cur;}),p=(pool.length?pool:db.spots).sort(function(a,b){return (a.hits||0)-(b.hits||0)||a.t-b.t;})[0];db.spots.splice(db.spots.indexOf(p),1);matchCache=null;return true;}
    function save(){if(disabledStore||!dirty||!store)return;try{if(opt.enabled&&opt.enabled()!==true){disabledStore=true;dirty=false;store.removeItem(KEY);return;}var out=JSON.stringify({v:2,spots:db.spots});while(out.length*2>LIMIT&&evict())out=JSON.stringify({v:2,spots:db.spots});store.setItem(KEY,out);dirty=false;}catch(e){counts.storage_errors++;disabledStore=true;dirty=false;try{store.removeItem(KEY);}catch(ignore){}}}
    // window_ms is elapsed time including unwatched intervals, not watched exposure.
    // *_asked means a reply to a human turn, not necessarily an explicit motion request.
    function hour(partial){var t=now();if(t-hourAt<(partial?300000:HOUR))return;counts.window_ms=t-hourAt;var row=copy(counts);counts=blank();hourAt=t;try{emit('world_hour',row);}catch(ignore){}}
    function resetStill(){steadySince=0;lastAccepted=0;history=[];flips=[];priorDelta=[];}
    function newSpot(){pendingSpot=true;cur=null;lastObs=null;matchCache=null;resetStill();}
    function quarantine(){tipHold=true;postTip=true;tipAt=now();handled=false;lastObs=null;matchCache=null;Object.keys(active).forEach(function(k){active[k].postTip=true;active[k].before=null;});resetStill();}
    function orientation(r,t){
      if(paused)return;if(!r||r.length!==6||!r.every(num)||!num(t)){rot=null;yaw=null;oriT=0;return;}
      if(rot&&t>oriT&&t-oriT<=1000){var p=rot, d00=r[0]*p[0]+r[1]*p[1]+r[2]*p[2],d01=r[0]*p[3]+r[1]*p[4]+r[2]*p[5],d10=r[3]*p[0]+r[4]*p[1]+r[5]*p[2],d11=r[3]*p[3]+r[4]*p[4]+r[5]*p[5],dy=Math.atan2((d10-d01)/2,(d00+d11)/2)*180/Math.PI;
        if(Math.abs(dy)>1.5)resetStill();
        if(Math.abs(dy)<=45.000001&&yaw!==null)yaw+=dy;else {yaw=0;headingGap=true;counts.heading_gaps++;}
      }else {yaw=0;headingGap=true;counts.heading_gaps++;}
      rot=r.slice();oriT=t;
    }
    function sensor(s){
      paused=false;var t=now(),g=s&&s.g, own=!!(s&&s.own),ride=!!(s&&s.ride);
      hour();
      if(riding&&!ride&&!tipHold)newSpot();riding=ride;
      if(!g||g.length!==3||!g.every(num)||!num(s.t)||t-s.t>500||s.t>t){resetStill();return;}
      var moved=gravity&&angle(gravity,g)>3, fresh=imuT>0&&s.t-imuT<=500, mag=Math.sqrt(g[0]*g[0]+g[1]*g[1]+g[2]*g[2]);
      imuT=s.t;gravity=g.slice();
      var still=fresh&&mag>8.3&&mag<11.3&&!moved&&num(s.lin)&&s.lin<.8&&(!num(s.spin)||s.spin<8)&&!own&&!ride;
      if(!still){if(!tipHold&&!own&&(ride||moved||s.lin>1.5))handled=true;resetStill();}
      else {if(!steadySince)steadySince=t;if(!tipHold&&handled&&t-steadySince>=1500){handled=false;newSpot();steadySince=t;}}
    }
    function context(value){if(ctx===value)return;ctx=String(value||'').slice(0,199);newSpot();yaw=null;rot=null;oriT=0;}
    function snapshot(v){return v?{b:v.b.slice(),h:v.h,mask:v.mask.slice(),sector:sector(yaw),yaw:yaw,t:now()}:null;}
    function expire(){var t=now();pending=pending.filter(function(p){if(t-p.endT<=60000)return true;counts.move_unobserved++;return false;});}
    function moveRequest(id,origin){
      expire();var ids=Object.keys(active);if(ids.length>=32){var drop=ids.filter(function(k){return !active[k].started;})[0];if(drop){delete active[drop];counts.move_unobserved++;}else{counts.move_unobserved++;return;}}
      active[id]={id:id,origin:/^(asked|self|reflex)$/.test(origin)?origin:'unknown',postTip:tipHold||postTip,before:lastObs&&now()-lastObs.t<=2500?copy(lastObs):null,startYaw:oriT&&now()-oriT<=1000?yaw:null,started:false};
    }
    function moveStart(id){pending.forEach(function(){counts.move_unobserved++;});pending=[];lastEnded=null;if(active[id]){active[id].started=true;active[id].startT=now();}resetStill();}
    function moveOrigin(id,origin){if(active[id]&&/^(asked|self|reflex)$/.test(origin))active[id].origin=origin;}
    function moveEnd(id,meta){
      var m=active[id];delete active[id];if(!m)return;
      meta=meta||{};var k=KINDS.indexOf(meta.kind)>=0?meta.kind:'other',end=/^(done|tipped|grabbed|failed|refused|stopped)$/.test(meta.end)?meta.end:'failed';
      m.kind=k;m.end=end;m.endT=now();m.endYaw=oriT&&now()-oriT<=1000?yaw:null;m.turn=num(m.startYaw)&&num(m.endYaw)?round(m.endYaw-m.startYaw):null;
      if(meta.reflex)m.origin='reflex';m.mount=/^(screen-out|screen-in|unknown)$/.test(meta.mount)?meta.mount:'unknown';m.after=null;m.change=null;m.state='unobserved';
      counts[k+'_n']++;counts[k+'_'+(m.origin==='asked'?'asked':m.origin==='self'?'self':'unknown')]++;
      if(m.started)lastEnded=m;db.moves.push(m);if(db.moves.length>48)db.moves.shift();resetStill();
      if(end==='tipped'){counts[k+'_tip']++;quarantine();pending.forEach(function(){counts.move_unobserved++;});pending=[];}
      else if(m.started&&!m.postTip&&!tipHold&&!postTip){if(k==='walk'||k==='drive')newSpot();pending.push(m);if(pending.length>16){pending.shift();counts.move_unobserved++;}}
      else counts.move_unobserved++;
    }
    function tip(hold){
      quarantine();
      // A hold can fail after its runner reported completion. It cannot supply an after-view.
      var tipped=pending.slice();if(hold!==false&&lastEnded&&lastEnded.started&&tipped.indexOf(lastEnded)<0)tipped.push(lastEnded);
      tipped.forEach(function(m){if(m.end!=='tipped'){m.end='tipped';counts[m.kind+'_tip']++;if(m.state==='settled'&&m.statsHour===hourAt){counts[m.kind+'_change_sum']=Math.max(0,counts[m.kind+'_change_sum']-Math.round((m.change||0)*1000));counts[m.kind+'_settled']=Math.max(0,counts[m.kind+'_settled']-1);counts[m.kind+'_settle_ms']=Math.max(0,counts[m.kind+'_settle_ms']-(m.settle_ms||0));}counts.move_unobserved++;}m.after=null;m.change=null;m.state='unobserved';});pending=[];
    }
    function nearest(v){if(matchCache&&matchCache.ctx===ctx&&matchCache.sec===sector(yaw)){var same=distance(v,matchCache.view);if(same&&same.mean<.05)return matchCache.match;}var best=null,score=.22;db.spots.forEach(function(p){if(p.ctx!==ctx)return;Object.keys(p.views).forEach(function(k){var d=distance(v,p.views[k]);if(d&&d.mean<score){score=d.mean;best={spot:p,key:k,view:p.views[k]};}});});matchCache={ctx:ctx,sec:sector(yaw),view:copy(v),match:best};return best;}
    function chooseSpot(v,sec){
      if(pendingSpot){cur={id:db.next++,ctx:ctx,t:wall(),hits:0,views:{},provisional:true};pendingSpot=false;}
      if(postTip||sec===null||cur.views[String(sec)])return;
      var observed={};Object.keys(cur.views).forEach(function(k){if(k!=='u')observed[k]=cur.views[k];});observed[String(sec)]=v;
      var best=null,bestN=1,bestOffset=0;
      db.spots.forEach(function(p){if(p===cur||p.ctx!==ctx)return;for(var offset=0;offset<8;offset++){var n=0;Object.keys(observed).forEach(function(k){var prior=p.views[String(mod(+k+offset,8))],d=prior&&distance(observed[k],prior);if(d&&d.mean<.22)n++;});if(n>bestN){best=p;bestN=n;bestOffset=offset;}}});
      if(best){var old=cur;cur=best;db.spots=db.spots.filter(function(p){return p!==old;});cur.provisional=false;yaw+=bestOffset*45;anchor++;counts.reanchors++;counts.reanchor_deg_sum+=Math.abs(bestOffset>4?bestOffset-8:bestOffset)*45;counts.spots_seen++;}
    }
    function frame(luma,env){
      var t=now(),perf=clock();hour();expire();env=env||{};context(env.context);paused=false;
      if(!env.awake||!env.visible||!env.eye||env.own||env.ride||env.handled||env.upright===false||env.upright===null||!steadySince||t-steadySince<1500||t-imuT>500){counts.unsettled++;lastAccepted=0;return null;}
      // A fall and its recovery provide no exploration credit. The first upright, still
      // qualified frame establishes a separately counted baseline, independent of get-up flags.
      if(tipHold){if(t-tipAt<2000||env.upright!==true){counts.unsettled++;lastAccepted=0;return null;}tipHold=false;newSpot();steadySince=t;return null;}
      if(env.face!==false){counts.rejected++;lastAccepted=0;return null;}
      if(!num(env.light)||env.light<25||env.light>235){counts.unusable++;lastAccepted=0;return null;}
      if(t-lastFrame<200)return null;lastFrame=t;counts.frames++;
      var v=fingerprint(luma);if(!v){counts.unusable++;lastAccepted=0;return null;}
      var prev=history.length?history[history.length-1]:null, i, maskN=0;
      for(i=0;i<108;i++){var delta=prev?v.b[i]-prev.b[i]:0;flips[i]=flips[i]||0;if(Math.abs(delta)>.3&&num(priorDelta[i])&&delta*priorDelta[i]<0)flips[i]=Math.min(8,flips[i]+1);else if(Math.abs(delta)<.1)flips[i]=Math.max(0,flips[i]-.1);priorDelta[i]=delta;if(flips[i]>=3){v.mask[i]=1;maskN++;}}
      history.push(v);if(history.length>5)history.shift();counts.masked_blocks+=maskN;
      if(maskN>36||history.length<5){counts.unusable++;return null;}
      // A transient occlusion or newly moved object must persist, not just flash for one frame.
      if(history.slice(0,-1).some(function(a){var d=distance(a,v);return !d||d.mean>.3;})){counts.unsettled++;return null;}
      if(!oriT||t-oriT>1000){yaw=null;rot=null;}var sec=sector(yaw);
      chooseSpot(v,sec);sec=sector(yaw);var key=sec===null?'u':String(sec),prior=cur.views[key],d=prior&&distance(v,prior),match=postTip||d&&d.mean<.22?null:nearest(v),label;if(match&&(!d||d.mean>=.22)){prior=match.view;d=distance(v,prior);}
      if(d&&d.mean<.22)label='seen';else if(d&&d.close>=.65)label='changed';else label='new';
      // A match to a sector re-anchors only to a previously measured heading, never invents one.
      if(label==='seen'&&num(yaw)&&num(prior.yaw)){var correction=prior.yaw-yaw;correction=mod(correction+180,360)-180;if(headingGap||Math.abs(correction)<=25){yaw+=correction;headingGap=false;sec=sector(yaw);key=sec===null?'u':String(sec);if(Math.abs(correction)>.5){counts.reanchors++;counts.reanchor_deg_sum+=Math.round(Math.abs(correction));}}}
      var date=new Date(wall()),day=date.getFullYear()+'-'+('0'+(date.getMonth()+1)).slice(-2)+'-'+('0'+date.getDate()).slice(-2),days=prior&&label!=='new'?prior.days:0;
      if(label==='new'||!prior||prior.day!==day)days=Math.min(36600,days+1);
      v.days=days;v.day=day;v.t=wall();v.yaw=yaw;var baseline=postTip;
      // Single-view matches reuse day history, but do not assert a recognized place.
      // Keep known references when a transient different scene covers their sector.
      if(label==='seen'){if(prior.day!==day)dirty=true;prior.days=days;prior.day=day;prior.t=wall();if(!cur.views[key]){cur.views[key]=v;dirty=true;}}
      else if(!cur.views[key]||label==='changed'){cur.views[key]=v;dirty=true;}
      if(db.spots.indexOf(cur)<0&&!match&&label!=='seen'){db.spots.push(cur);dirty=true;matchCache=null;if(!baseline)counts.spots_new++;while(db.spots.length>24)evict();}
      cur.t=wall();cur.hits=(cur.hits||0)+1;
      if(match){match.spot.t=wall();match.spot.hits=(match.spot.hits||0)+1;}
      var previous=lastObs&&distance(lastObs,v);
      if(baseline){counts.post_tip_views++;postTip=false;}else if(!lastObs||lastObs.sector!==sec||label!==lastObs.label&&label==='seen'||label!=='seen'&&(!previous||previous.mean>=.22))counts[label==='new'?'new_views':label==='changed'?'changed_views':'seen_views']++;
      counts.accepted++;if(lastAccepted&&t-lastAccepted<=600)counts.still_ms+=t-lastAccepted;lastAccepted=t;
      lastObs=snapshot(v);lastObs.spot=cur.id;lastObs.label=baseline?'seen':label;lastObs.days=days;
      pending=pending.filter(function(m){if(t<m.endT+1500)return true;m.after=copy(lastObs);var dd=m.before&&distance(m.before,v);m.change=dd?round(dd.mean):null;m.state='settled';m.statsHour=hourAt;m.settle_ms=t-m.endT;counts[m.kind+'_settled']++;counts[m.kind+'_settle_ms']+=m.settle_ms;if(m.change!==null)counts[m.kind+'_change_sum']+=Math.round(m.change*1000);return false;});
      var us=Math.max(0,Math.round((clock()-perf)*1000));counts.frame_us_sum+=us;counts.frame_us_max=Math.max(counts.frame_us_max,us);return {state:baseline?'post_tip':label,days:days,sector:sec};
    }
    function suspend(){if(paused)return;paused=true;resetStill();hour(true);lastObs=null;pending.forEach(function(){counts.move_unobserved++;});pending=[];}
    return {sensor:sensor,orientation:orientation,frame:frame,request:moveRequest,cancel:function(id){delete active[id];},start:moveStart,origin:moveOrigin,end:moveEnd,tip:tip,suspend:suspend,save:function(){save();},flush:function(){hour(true);},erase:function(){db={v:1,next:1,spots:[],moves:[]};newSpot();active={};pending=[];dirty=false;try{store.removeItem(KEY);}catch(e){}},inspect:function(){return copy({data:db,counts:counts,yaw:yaw,anchors:anchor,tipHold:tipHold,active:Object.keys(active).length,currentSpot:cur&&cur.id,postTip:postTip,paused:paused,steadySince:steadySince});}};
  }
  root.GBWorldEye={create:make,fingerprint:fingerprint,distance:distance,key:KEY};
})(typeof window!=='undefined'?window:this);
