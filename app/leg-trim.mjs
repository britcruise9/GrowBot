/* leg-trim.mjs: the by-eye leg trim engine (CALIBRATION seat, 0928). ES2018: no ?. / ??.
   Used IN PAGE by build step 07 (Brit 0928: "the straighten the legs part should happen IN PAGE,
   we want easiest possible, didn't they connect already"), and meant for the simple /tester later.

   What it does: holds both legs at 90 + trim (robot face down, legs up in the air, so each servo sits
   exactly where it is told), moves one leg one degree per tap, and saves L_OFF / R_OFF. The person
   judges by eye: seen from the side at leg height, parallel legs line up and the near one hides the
   far one. Bench 0928 on the bench robot: left -8, right +3, identical on two separate pages.

   Safety: the chip goes limp 500 ms after the last pose frame, so the hold is a 50 ms pose stream
   that simply stops on Let go, a hidden page, or after a minute without a tap. Legs in the air just
   flop. Trims are clamped to +-20 degrees.

   The page supplies everything outside the engine (body, online, read, write, say, paint), and may
   pass a fake clock for tests. The default clock calls the browser timers directly: handing
   {setTimeout:setTimeout} over as an object throws "Illegal invocation" in Chrome (build-presence.js
   0925). */
import './trim-store.js';
export var TrimStore=(typeof window!=='undefined'?window:global).GBTrimStore;
var BROWSER_CLOCK = {
  setTimeout: function (f, ms) { return setTimeout(f, ms); },
  clearTimeout: function (i) { clearTimeout(i); },
  setInterval: function (f, ms) { return setInterval(f, ms); },
  clearInterval: function (i) { clearInterval(i); }
};
export var TRIM_MAX = 20;
export function clampTrim(v) { v = Math.round(+v || 0); return Math.max(-TRIM_MAX, Math.min(TRIM_MAX, v)); }

export function createTrimmer(o) {
  var clock = o.clock || BROWSER_CLOCK, rate = o.rate || 60, idleMs = o.idleMs || 60000, glideMs = o.glideMs || 1500;
  var st = { L: 0, R: 0, holding: false, engaging: false, seen: false }, pump = null, cur = null, idle = null, engageT = null;
  function snapshot() { return { L: st.L, R: st.R, holding: st.holding, engaging: st.engaging, seen: st.seen }; }
  function paint() { if (o.paint) o.paint(snapshot()); }
  function say(t, cls) { if (o.say) o.say(t, cls || ''); }
  function target() { return { l: 90 + st.L, r: 90 + st.R }; }
  function tick() {   // one pose frame toward the target, gliding at `rate` degrees a second
    var b = o.body(); if (!st.holding || !b || !b.ready) return;
    var t = target(), m = rate * 0.05;
    if (!cur) cur = { l: t.l, r: t.r };
    ['l', 'r'].forEach(function (k) { var d = t[k] - cur[k]; cur[k] += Math.abs(d) <= m ? d : (d > 0 ? m : -m); });
    b.pose(cur.l, cur.r);
    st.seen = cur.l === t.l && cur.r === t.r;
  }
  function armIdle() {
    if (idle !== null) clock.clearTimeout(idle);
    idle = clock.setTimeout(function () { idle = null; if (st.holding || st.engaging) { letGo(); say('I let go after a minute. Tap Hold legs up to carry on.'); } }, idleMs);
  }
  function hold() {
    if (!o.online()) { say(o.offlineText ? o.offlineText() : 'I can’t reach your robot. Is it switched on?', 'bad'); return false; }
    armIdle();
    if (st.holding || st.engaging) return true;
    st.engaging = true;
    var t = target();
    o.body().act([{ l: t.l, r: t.r, ms: glideMs }], 'replace');   // a gentle glide in, then the stream holds
    engageT = clock.setTimeout(function () {
      engageT = null; if (!o.online()) { letGo(); return; } st.engaging = false; st.holding = true; st.seen = st.L === t.l-90 && st.R === t.r-90; cur = { l: t.l, r: t.r };
      if (pump === null) pump = clock.setInterval(tick, 50);
      paint();
    }, glideMs + 50);
    say('Holding. Tap − or + until the legs line up, then Save.');
    paint();
    return true;
  }
  function letGo() {
    var was = st.holding || st.engaging;
    if (engageT !== null) { clock.clearTimeout(engageT); engageT = null; }
    if (pump !== null) { clock.clearInterval(pump); pump = null; }
    if (idle !== null) { clock.clearTimeout(idle); idle = null; }
    st.holding = false; st.engaging = false; cur = null;
    var b = o.body(); if (was && b && b.ready) b.stop();
    paint();
    return was;
  }
  function nudge(k, d) {
    if (k !== 'L' && k !== 'R') return false;
    if (!o.online()) { say(o.offlineText ? o.offlineText() : 'I can’t reach your robot. Is it switched on?', 'bad'); return false; }
    st[k] = clampTrim(st[k] + d); st.seen = false;
    paint();
    return hold();
  }
  function save() {
    if (!st.seen || !o.online() || (o.canSave && !o.canSave())) { say('Tap Connect, then Hold legs up, and check the legs first.', 'bad'); return false; }
    var ok = o.write(st.L, st.R);
    say(ok ? 'Trim saved: left ' + fmt(st.L) + ', right ' + fmt(st.R) + '.' : 'Couldn’t save in this browser. Is it in private browsing?', ok ? 'good' : 'bad');
    return ok;
  }
  function load() { letGo(); st.seen = false; var t = o.read() || {}; st.L = clampTrim(t.L); st.R = clampTrim(t.R); paint(); }
  load();
  return { hold: hold, letGo: letGo, nudge: nudge, save: save, load: load, state: snapshot };
}
export function fmt(v) { return (v > 0 ? '+' : '') + v + '°'; }

// An explicit robot id binds every checked save to its own history. No-id helpers remain for older callers.
export function readTrims(storage, id) {
  if (id !== undefined) return TrimStore.readTrims(storage, id);
  try { var c=TrimStore.read(storage); return { L:c.L_OFF, R:c.R_OFF }; } catch(e) { return { L:0,R:0 }; }
}
export function writeTrims(storage,L,R,id,now) {
  if(id!==undefined)return TrimStore.save(storage,id,clampTrim(L),clampTrim(R),now);
  try{var c=TrimStore.read(storage);c.L_OFF=clampTrim(L);c.R_OFF=clampTrim(R);storage.setItem('gb_walk_cal',JSON.stringify(c));return true;}catch(e){return false;}
}
