/* Per-robot trims, 1016. One localStorage write commits the active correction and its history.
   TRIMS/TRIM_ACTIVE are private metadata inside gb_walk_cal; motion reads only the public calibration.
   Untimed links retain the old empty-only rule. Timed links compare this robot's saves (seconds).
   Future timestamps are rejected. Different devices depend on reasonably synchronized clocks. */
(function(root){
  'use strict';
  var KEY='gb_walk_cal';
  function id(v){ v=String(v||'').trim().toLowerCase(); return /^gb-[a-z0-9]{4,}$/.test(v)?v:''; }
  function pair(L,R,limit){ return Number.isInteger(L)&&Number.isInteger(R)&&Math.abs(L)<=limit&&Math.abs(R)<=limit; }
  function read(s){ var raw=s.getItem(KEY),c={}; try{ c=JSON.parse(raw||'{}'); }catch(e){} return c&&typeof c==='object'&&!Array.isArray(c)?c:{}; }
  function publicCal(c){ var out=Object.assign({},c); delete out.TRIMS; delete out.TRIM_ACTIVE; return out; }
  function mapOf(c){ var out={},m=c.TRIMS; if(m&&typeof m==='object'&&!Array.isArray(m)) Object.keys(m).forEach(function(k){ var e=m[k];
    if(id(k)===k&&e&&pair(e.L,e.R,180)&&Number.isInteger(e.at)&&e.at>=0)out[k]={L:e.L,R:e.R,at:e.at}; }); return out; }
  function seconds(now){ return Math.floor((now===undefined?Date.now():now)/1000); }
  function remembered(s){ return id(s.getItem('gb_walk_id')); }
  // Reconcile old writers BEFORE comparing an incoming QR, and preserve the displaced robot.
  function prepare(c,previous,now){ var m=mapOf(c),owner=id(c.TRIM_ACTIVE)||id(previous),L=c.L_OFF,R=c.R_OFF;
    if(L===undefined)L=0; if(R===undefined)R=0;
    if(owner&&pair(L,R,180)){
      var e=m[owner];
      if(e&&(e.L!==L||e.R!==R)) m[owner]=Object.assign({},e,{L:L,R:R,at:now});
      else if(!e&&(L!==0||R!==0)) m[owner]={L:L,R:R,at:0};
    }
    return {map:m,owner:owner,L:L,R:R};
  }
  function selected(st,robot){ if(st.map[robot])return st.map[robot]; if(!st.owner||st.owner===robot)return {L:st.L||0,R:st.R||0,at:0}; return {L:0,R:0,at:0}; }
  function commit(s,c,st,robot){ var e=selected(st,robot); c.L_OFF=e.L;c.R_OFF=e.R;c.TRIMS=st.map;c.TRIM_ACTIVE=robot;s.setItem(KEY,JSON.stringify(c)); }
  function readTrims(s,robot){ try{ var c=read(s),st=prepare(c,remembered(s),seconds()),e=selected(st,id(robot)); return {L:e.L,R:e.R}; }catch(e){return {L:0,R:0};} }
  // A second tab may activate another robot. Every motion read resolves its own connected identity.
  function runtime(s,robot){var c=JSON.parse(s.getItem(KEY)||'{}');if(!c||typeof c!=='object'||Array.isArray(c))c={};var out=publicCal(c),st=prepare(c,remembered(s),seconds());robot=id(robot);
    if(robot&&(st.owner||Object.keys(st.map).length)){var e=selected(st,robot);out.L_OFF=e.L;out.R_OFF=e.R;}return out;}
  function save(s,robot,L,R,now){ robot=id(robot); if(!robot||!pair(L,R,20))return false;
    try{var c=read(s),t=seconds(now),st=prepare(c,remembered(s),t),e=st.map[robot];if(!Number.isInteger(t)||t<1e9)return false;
      st.map[robot]=Object.assign({},e||{},{L:L,R:R,at:t});commit(s,c,st,robot);return true;
    }catch(e){return false;}
  }
  function link(s,robot){ try{robot=id(robot);if(!robot)return '';var c=read(s),st=prepare(c,remembered(s),seconds()),e=st.map[robot];
    // Existing builders can carry an unstamped correction to an empty phone. Never label it a new checked save.
    if(!e&&(!st.owner||st.owner===robot)&&(Object.prototype.hasOwnProperty.call(c,'L_OFF')||Object.prototype.hasOwnProperty.call(c,'R_OFF'))&&pair(st.L,st.R,20))e={L:st.L,R:st.R,at:0};
    if(c.TRIMS&&JSON.stringify(c.TRIMS)!==JSON.stringify(st.map)){c.TRIMS=st.map;s.setItem(KEY,JSON.stringify(c));}return e&&pair(e.L,e.R,20)?'&trim='+e.L+','+e.R+(e.at>0?'&trimat='+e.at:''):'';}catch(e){return '';} }
  // Old whole-object editors must not replace the map or apply their old robot's offsets to a new one.
  function update(s,patch,owner,now,changed){try{var c=read(s),st=prepare(c,remembered(s),seconds(now)),robot=id(owner),active=id(c.TRIM_ACTIVE);
    var offsets=pair(patch.L_OFF,patch.R_OFF,180),old=st.map[robot];
    if(changed!==false&&robot&&offsets&&(!old||old.L!==patch.L_OFF||old.R!==patch.R_OFF)){st.map[robot]=Object.assign({},old||{},{L:patch.L_OFF,R:patch.R_OFF,at:seconds(now)});c.TRIMS=st.map;}
    Object.keys(patch).forEach(function(k){if(k==='TRIMS'||k==='TRIM_ACTIVE')return;if((k==='L_OFF'||k==='R_OFF')&&(changed===false||active&&active!==robot))return;c[k]=patch[k];});
    s.setItem(KEY,JSON.stringify(c));return true;
  }catch(e){return false;}}
  function boot(s,robot,previous,trim,stamp,now){ robot=id(robot); var note=null,original=null,fallback={L:0,R:0};
    try{original=s.getItem(KEY);var c=read(s),before=JSON.stringify(c),t=seconds(now),st=prepare(c,id(previous)||robot,t);fallback=selected(st,robot);
      if(trim!==null&&trim!==undefined){
        var match=/^(-?[0-9]{1,2}),(-?[0-9]{1,2})$/.exec(String(trim).trim());
        if(!match)note={took:0,why:'malformed'};
        else if(!pair(+match[1],+match[2],20))note={took:0,why:'out_of_range'};
        else if(!robot)note={took:0,why:'no_robot'};
        else{
          var L=+match[1],R=+match[2],e=st.map[robot],active=selected(st,robot),raw=String(stamp||'').trim(),at=0;
          if(stamp!==null&&stamp!==undefined&&(!/^[0-9]{10,11}$/.test(raw)||+raw<1e9))note={took:0,why:'malformed_time'};
          else if(raw&&+raw>t)note={took:0,why:'future_time'};
          else{
            if(raw)at=+raw;
            if(at&&e&&at<=e.at)note={took:0,why:'phone_newer',L:L,R:R};
            else if(!at&&(e||active.L!==0||active.R!==0))note={took:0,why:'phone_has_trim',L:L,R:R};
            else{st.map[robot]={L:L,R:R,at:at};note={took:1,L:L,R:R};}
          }
        }
      }
      // Custom channels may be noncanonical. Preserve the known owner before their caller remembers that channel.
      // This reconciles only ownership/history; it does not activate an invalid ID or change public offsets.
      if(!robot&&st.owner){c.TRIMS=st.map;c.TRIM_ACTIVE=st.owner;if(JSON.stringify(c)!==before)s.setItem(KEY,JSON.stringify(c));}
      if(robot&&(Object.keys(st.map).length||id(c.TRIM_ACTIVE)||note&&note.took)){
        var target=selected(st,robot),changed=c.L_OFF!==target.L||c.R_OFF!==target.R||c.TRIM_ACTIVE!==robot;
        c.L_OFF=target.L;c.R_OFF=target.R;c.TRIMS=st.map;c.TRIM_ACTIVE=robot;
        if(JSON.stringify(c)!==before)s.setItem(KEY,JSON.stringify(c));
        return {link:note,boot:changed?{L:target.L,R:target.R}:null};
      }
      return {link:note,boot:null};
    }catch(e){return {link:trim!==null&&trim!==undefined?{took:0,why:'error'}:null,boot:{err:1},fallback:{L:fallback.L,R:fallback.R,raw:original}};}
  }
  var api={id:id,read:read,publicCal:publicCal,runtime:runtime,readTrims:readTrims,save:save,link:link,boot:boot,update:update};
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.GBTrimStore=api;
})(typeof window!=='undefined'?window:(typeof global!=='undefined'?global:this));
