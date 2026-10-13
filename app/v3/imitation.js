/* Optional, transient imitation. Caller owns microphone, audio context and output arbitration. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.GBImitation = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  var MAX_MS = 6000, MAX_EVENTS = 24, FRESH_MS = 20000, WORK_MS = 3000;
  function finite(v) { return typeof v === 'number' && Number.isFinite(v); }
  function integer(v) { return finite(v) && Math.floor(v) === v; }
  function freeze(value) { return Object.freeze(value); }
  // Same whole-phrase octave mapping as the proven extraction prototype.
  function playbackShift(events) {
    var hz = events.filter(function (e) { return Number.isFinite(e.hz) && e.hz > 0; }).map(function (e) { return e.hz; });
    if (!hz.length) return {factor:1, outsideBand:false};
    var low = Math.min.apply(null, hz), high = Math.max.apply(null, hz);
    var lo = Math.ceil(Math.log2(170 / low)), hi = Math.floor(Math.log2(900 / high));
    if (lo > hi) return {factor:1, outsideBand:low < 170 || high > 900};
    return {factor:Math.pow(2, Math.max(lo, Math.min(hi, 0))), outsideBand:false};
  }
  function phrase(result) {
    if (!result || result.ok !== true || !Array.isArray(result.events) ||
        !result.events.length || result.events.length > MAX_EVENTS ||
        !integer(result.ms) || result.ms < 1 || result.ms > MAX_MS ||
        !integer(result.capturedMs) || result.capturedMs < 120 || result.capturedMs > MAX_MS ||
        result.ms > result.capturedMs || !finite(result.pitchFraction) ||
        result.pitchFraction < 0 || result.pitchFraction > 1 ||
        result.timingResolutionMs !== 20 || typeof result.limited !== 'boolean' ||
        typeof result.unpitched !== 'boolean') return null;
    var events = [], end = 0, unpitched = false;
    for (var i = 0; i < result.events.length; i++) {
      var e = result.events[i];
      if (!e || !integer(e.t) || e.t < end || !integer(e.ms) || e.ms < 1 ||
          e.t + e.ms > result.ms || !finite(e.level) || e.level < .15 || e.level > 1 ||
          (e.kind !== 'pulse' && e.kind !== 'tone') ||
          (e.kind === 'pulse' ? e.hz !== null : (!finite(e.hz) || e.hz < 80 || e.hz > 1600))) return null;
      if (i === 0 && e.t !== 0) return null;
      end = e.t + e.ms;
      unpitched = unpitched || e.hz === null;
      events.push(freeze({t:e.t, ms:e.ms, hz:e.hz, level:e.level, kind:e.kind}));
    }
    if (end !== result.ms || unpitched !== result.unpitched) return null;
    return {events:freeze(events), ms:result.ms, capturedMs:result.capturedMs,
      pitchFraction:result.pitchFraction, limited:result.limited, unpitched:unpitched,
      timingResolutionMs:20, shift:freeze(playbackShift(events))};
  }
  function create(options) {
    options = options || {};
    var now = options.now || function () { return Date.now(); };
    var factory = options.workerFactory || function () { return new root.Worker('/v3/imitation-worker.js'); };
    var worker = null, pending = null, offered = null, epoch = 0, count = 0, dead = false;
    function time() { try { var t = now(); return finite(t) ? t : NaN; } catch (error) { return NaN; } }
    function emit(type, data) {
      if (typeof options.onEvent === 'function') try { options.onEvent(type, data); } catch (error) { /* Observation cannot own the lifecycle. */ }
    }
    function killWorker() {
      if (worker) { worker.onmessage = worker.onerror = worker.onmessageerror = null; try { worker.terminate(); } catch (error) {} }
      worker = null;
    }
    function finish(why) {
      var p = pending; pending = null;
      if (!p) return;
      clearTimeout(p.timer);
      emit('imitation_analysis', {id:p.id, kind:p.kind, at:p.at, ok:false, why:why});
      p.resolve({ok:false, id:p.id, ms:0, eventCount:0, why:why});
    }
    function cancel(reason) {
      epoch++; offered = null;
      if (pending) { killWorker(); finish(reason || 'cancelled'); }
    }
    function fresh(at) { var t = time(); return finite(t) && t >= at && t < at + FRESH_MS; }
    function descriptor(plan) {
      var firstHz = 0;
      plan.events.some(function (e) { if (e.hz !== null) { firstHz = e.hz; return true; } return false; });
      var fingerprint = plan.events.map(function (e) {
        return Math.round(e.t / 40) + ':' + Math.round(e.ms / 40) + ':' +
          (e.hz === null ? 'p' : Math.round(12 * Math.log2(e.hz / firstHz)));
      }).join(',');
      return freeze({id:plan.id, kind:plan.kind, at:plan.at, expiresAt:plan.expiresAt,
        ms:plan.ms, eventCount:plan.events.length, fingerprint:fingerprint,
        summary:(plan.unpitched ? 'rhythm' : 'melody') + ', ' + plan.events.length + ' events, ' + plan.ms + ' ms'});
    }
    function analyze(pcm, rate, meta) {
      cancel('superseded');
      var id = 'imitation-' + (++count), at = meta && meta.at, kind = meta && meta.kind;
      function refused(why) { return Promise.resolve({ok:false, id:id, ms:0, eventCount:0, why:why}); }
      if (dead) return refused('destroyed');
      if (!finite(at) || !fresh(at)) return refused('stale');
      if (kind !== 'requested' && kind !== 'spontaneous') return refused('invalid_kind');
      if (!(pcm instanceof Float32Array) || !(pcm.buffer instanceof ArrayBuffer) ||
          !finite(rate) || rate < 16000 || rate > 192000 ||
          pcm.length > Math.floor(rate * MAX_MS / 1000)) return refused('unsupported_input');
      if (pcm.length < Math.ceil(rate * .12)) return refused('too_short');
      if (!worker) try { worker = factory(); } catch (error) { worker = null; }
      if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function') {
        killWorker(); return refused('unavailable');
      }
      var activeWorker = worker, activeEpoch = epoch;
      return new Promise(function (resolve) {
        pending = {id:id, epoch:activeEpoch, at:at, kind:kind, resolve:resolve, timer:null};
        activeWorker.onmessage = function (event) {
          var p = pending, msg = event && event.data;
          if (worker !== activeWorker || !p || p.epoch !== activeEpoch ||
              !msg || msg.type !== 'result' || msg.id !== p.id || msg.epoch !== p.epoch) return;
          if (!fresh(p.at)) { finish('stale'); return; }
          if (msg.result && msg.result.ok === false) {
            var allowed = ['too_short','too_quiet','unsupported_input','nonfinite_audio','no_clear_tune_or_rhythm','too_many_beats','invalid_input'];
            finish(allowed.indexOf(msg.result.why) >= 0 ? msg.result.why : 'invalid_result'); return;
          }
          var plan = phrase(msg.result);
          if (!plan) { finish('invalid_result'); return; }
          clearTimeout(p.timer); pending = null;
          plan.id = p.id; plan.kind = p.kind; plan.at = p.at; plan.expiresAt = p.at + FRESH_MS;
          offered = freeze(plan);
          emit('imitation_analysis', {id:p.id, kind:p.kind, at:p.at, ok:true, ms:plan.ms, eventCount:plan.events.length});
          resolve({ok:true, id:p.id, ms:plan.ms, eventCount:plan.events.length, why:''});
        };
        function failed() {
          if (worker !== activeWorker || !pending || pending.epoch !== activeEpoch) return;
          killWorker(); finish('worker_error');
        }
        activeWorker.onerror = failed; activeWorker.onmessageerror = failed;
        pending.timer = setTimeout(function () {
          if (!pending || pending.epoch !== activeEpoch || pending.id !== id) return;
          killWorker(); finish('timeout');
        }, Math.min(WORK_MS, Math.max(1, at + FRESH_MS - time())));
        try {
          // Transfer the bounded capture once. A partial view must not transfer unrelated samples.
          var samples = pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength ? pcm : pcm.slice();
          activeWorker.postMessage({type:'analyze', id:id, epoch:activeEpoch, rate:rate, buffer:samples.buffer}, [samples.buffer]);
        } catch (error) { killWorker(); finish('worker_error'); }
      });
    }
    return {
      analyze:analyze,
      peek:function () { if (offered && !fresh(offered.at)) offered = null; return offered ? descriptor(offered) : null; },
      take:function (id) { if (!offered || offered.id !== id) return null; var plan = offered; offered = null; return fresh(plan.at) ? plan : null; },
      cancel:cancel,
      destroy:function () { dead = true; cancel('destroyed'); killWorker(); }
    };
  }
  function playSound(context, output, plan) {
    // Validate again at the audio boundary. Never trust callers to supply a legal schedule or shift.
    var checked = plan && phrase({ok:true, events:plan.events, ms:plan.ms, capturedMs:plan.capturedMs,
      pitchFraction:plan.pitchFraction, limited:plan.limited, unpitched:plan.unpitched,
      timingResolutionMs:plan.timingResolutionMs});
    if (!checked || !context || !finite(context.currentTime) || !output) throw new Error('invalid_imitation_plan');
    var voices = [], stopped = false, startAt = context.currentTime + .08;
    function cleanup(v) { try { v.osc.disconnect(); } catch (error) {} try { v.gain.disconnect(); } catch (error) {} }
    function stop() {
      if (stopped) return; stopped = true;
      var t = context.currentTime;
      voices.forEach(function (v) {
        try {
          if (typeof v.gain.gain.cancelAndHoldAtTime === 'function') v.gain.gain.cancelAndHoldAtTime(t);
          else { var level = v.gain.gain.value; v.gain.gain.cancelScheduledValues(t); v.gain.gain.setValueAtTime(level, t); }
          v.gain.gain.linearRampToValueAtTime(0, t + .012);
          v.osc.stop(t + .012);
        } catch (error) { cleanup(v); }
      });
      // A suspended/closed context may never deliver onended.
      setTimeout(function () { voices.forEach(cleanup); voices = []; }, 24);
    }
    try {
      checked.events.forEach(function (e) {
        var start = startAt + e.t / 1000, end = start + e.ms / 1000;
        var osc = context.createOscillator(), gain = context.createGain(), v = {osc:osc, gain:gain};
        voices.push(v);
        try { osc.setPeriodicWave(context.createPeriodicWave(new Float32Array([0,1,.45,.18,.08]), new Float32Array(5))); }
        catch (error) { osc.type = 'triangle'; }
        osc.frequency.setValueAtTime(e.hz === null ? 240 : e.hz * checked.shift.factor, start);
        var attack = Math.min(.015, e.ms / 6000), release = Math.min(.025, e.ms / 5000), level = .12 * Math.max(.15, e.level);
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(level, start + attack);
        gain.gain.setValueAtTime(level, Math.max(start + attack, end - release));
        gain.gain.linearRampToValueAtTime(0, end);
        osc.connect(gain); gain.connect(output);
        osc.onended = function () { cleanup(v); voices = voices.filter(function (x) { return x !== v; }); };
        osc.start(start); osc.stop(end + .01);
      });
    } catch (error) { stop(); throw error; }
    return {ms:checked.ms + 90, stop:stop};
  }
  return {create:create, playSound:playSound, MAX_MS:MAX_MS, MAX_EVENTS:MAX_EVENTS, FRESH_MS:FRESH_MS};
});
