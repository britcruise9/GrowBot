/* ============================================================================
   GrowBot unified agent kernel helpers.

   This file is intentionally small and dependency-free. It captures the pieces
   that should stay true whether the body is a phone speaker, a simulated body,
   or real legs:
     - parse/validate verb(params) against the body menu
     - score Mimic with deterministic sensor math
   ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GrowBotUnifiedAgent = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var VERSION = "0.1.0";

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  function cleanText(s, n) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n || 400);
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  var COMMON_VERBS = [
    {
      name: "speak",
      effect: "voice",
      params: {
        text: { type: "string", required: true, max: 180 }
      }
    },
    {
      name: "turn",
      effect: "motion_intent",
      params: {
        degrees: { type: "number", required: true, min: -180, max: 180 },
        duration_ms: { type: "integer", min: 120, max: 5000, default: 700 }
      }
    },
    {
      name: "forward",
      effect: "motion_intent",
      params: {
        meters: { type: "number", min: 0.05, max: 2, default: 0.25 },
        duration_ms: { type: "integer", min: 120, max: 8000, default: 1000 }
      }
    },
    {
      name: "stop",
      effect: "motion_intent",
      params: {}
    },
    {
      name: "remember_mimic",
      effect: "tool",
      params: {
        label: { type: "string", max: 60, default: "shake" }
      }
    },
    {
      name: "score_mimic",
      effect: "tool",
      params: {}
    }
  ];

  function createBodyTruth(kind) {
    kind = kind || "phone";
    var effect = kind === "legs" ? "physical" : (kind === "sim" ? "simulated" : "spoken_intent");
    var verbs = COMMON_VERBS.map(function (v) {
      var out = clone(v);
      if (out.effect === "motion_intent") out.effect = effect;
      return out;
    });
    // NOTE (2026-06-30): the kernel deliberately does NOT ship a raw gesture(l,r) verb for
    // legs — raw per-leg servo degrees violate the "no raw servo commands are the agent
    // contract" rule. Legs verbs are added by the creature shell at build time as NAMED,
    // clamped actions (wave/bow/turn/step/lift_leg…) that the actuator maps down to servos.
    // Rich, specific verbs = the flexibility; clamped-not-raw params = the safety.
    return {
      version: 1,
      kind: kind,
      id: "growbot-" + kind,
      verbs: verbs,
      notes: {
        phone: "Motion verbs are intentionally spoken intent. They do not change the next frame unless a human cooperates.",
        sim: "Motion verbs update a tiny deterministic world so phone-only Seek can exercise closed-loop dynamics.",
        legs: "Motion verbs are physical policy/primitive requests. Firmware still owns pin mapping and safety stops."
      }[kind] || ""
    };
  }

  function verbMap(bodyTruth) {
    var m = {};
    (bodyTruth && bodyTruth.verbs || []).forEach(function (v) { m[v.name] = v; });
    return m;
  }

  function parseScalar(raw) {
    raw = String(raw == null ? "" : raw).trim();
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return raw.replace(/^["']|["']$/g, "");
  }

  // split on commas that are NOT inside a quoted string, so speak(text="hello, world")
  // keeps its comma instead of silently truncating to "hello". (bugfix 2026-06-30)
  function splitTopLevel(s) {
    var parts = [], cur = "", q = null;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) { cur += c; if (c === q) q = null; }
      else if (c === '"' || c === "'") { q = c; cur += c; }
      else if (c === ",") { parts.push(cur); cur = ""; }
      else cur += c;
    }
    if (cur.length || parts.length) parts.push(cur);
    return parts;
  }

  function parseParams(body) {
    body = String(body == null ? "" : body).trim();
    if (!body) return {};
    if (body[0] === "{") return JSON.parse(body);
    var out = {};
    splitTopLevel(body).forEach(function (part) {
      var ix = part.indexOf("=");
      if (ix < 0) return;
      var k = part.slice(0, ix).trim();
      if (!k) return;
      out[k] = parseScalar(part.slice(ix + 1));
    });
    return out;
  }

  function parseAgentAction(input) {
    if (input && typeof input === "object") {
      if (typeof input.verb === "string") return { verb: input.verb, params: input.params || {} };
      if (typeof input.action === "string") return { verb: input.action, params: input.params || {} };
      if (typeof input.say === "string") return { verb: "speak", params: { text: input.say } };
    }

    var s = String(input == null ? "" : input).trim();
    if (!s) return { error: "empty action" };

    if (s[0] === "{") {
      try { return parseAgentAction(JSON.parse(s)); }
      catch (e) { return { error: "invalid JSON action: " + e.message }; }
    }

    var m = s.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*)\)\s*$/);
    if (!m) return { error: "expected verb(params)" };
    try { return { verb: m[1], params: parseParams(m[2]) }; }
    catch (e2) { return { error: "invalid params: " + e2.message }; }
  }

  function validateParam(name, value, schema) {
    if (value == null || value === "") {
      if (schema.required) return { ok: false, error: "missing required param " + name };
      if ("default" in schema) return { ok: true, value: schema.default };
      return { ok: true, value: value };
    }
    if (schema.type === "number" || schema.type === "integer") {
      var n = Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: name + " must be a number" };
      if (schema.type === "integer") n = Math.round(n);
      if (schema.min != null && n < schema.min) return { ok: false, error: name + " below min " + schema.min };
      if (schema.max != null && n > schema.max) return { ok: false, error: name + " above max " + schema.max };
      return { ok: true, value: n };
    }
    if (schema.type === "string") {
      var s = cleanText(value, schema.max || 400);
      if (schema.required && !s) return { ok: false, error: name + " must be non-empty" };
      return { ok: true, value: s };
    }
    if (schema.enum) {
      if (schema.enum.indexOf(value) < 0) return { ok: false, error: name + " not in enum" };
      return { ok: true, value: value };
    }
    return { ok: true, value: value };
  }

  function validateAction(bodyTruth, actionInput) {
    var action = typeof actionInput === "string" ? parseAgentAction(actionInput) : parseAgentAction(actionInput);
    if (action.error) return { ok: false, error: action.error };
    var spec = verbMap(bodyTruth)[action.verb];
    if (!spec) return { ok: false, error: "off-menu verb: " + action.verb, action: action };
    var params = {};
    var schema = spec.params || {};
    var supplied = action.params || {};
    var keys = Object.keys(supplied);
    for (var i = 0; i < keys.length; i++) {
      if (!schema[keys[i]]) return { ok: false, error: "unknown param " + keys[i] + " for " + action.verb, action: action };
    }
    keys = Object.keys(schema);
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j];
      var v = validateParam(k, supplied[k], schema[k]);
      if (!v.ok) return { ok: false, error: v.error, action: action };
      if (v.value != null && v.value !== "") params[k] = v.value;
    }
    return { ok: true, action: { verb: action.verb, params: params }, spec: spec };
  }

  function formatAction(action) {
    action = parseAgentAction(action);
    if (action.error) return "";
    var keys = Object.keys(action.params || {});
    return action.verb + "(" + keys.map(function (k) {
      var v = action.params[k];
      if (typeof v === "number") v = Math.round(v * 1000) / 1000;
      return k + "=" + (typeof v === "string" ? JSON.stringify(v) : String(v));
    }).join(",") + ")";
  }

  function sampleMagnitude(sample) {
    if (Array.isArray(sample)) return Math.hypot(Number(sample[0]) || 0, Number(sample[1]) || 0, Number(sample[2]) || 0);
    return Math.hypot(Number(sample.x) || 0, Number(sample.y) || 0, Number(sample.z) || 0);
  }

  function resample(values, n) {
    if (!values.length) return new Array(n).fill(0);
    if (values.length === 1) return new Array(n).fill(values[0]);
    var out = [];
    for (var i = 0; i < n; i++) {
      var p = i * (values.length - 1) / (n - 1);
      var a = Math.floor(p), b = Math.min(values.length - 1, a + 1), f = p - a;
      out.push(values[a] * (1 - f) + values[b] * f);
    }
    return out;
  }

  function zscore(values) {
    var mean = values.reduce(function (s, v) { return s + v; }, 0) / Math.max(1, values.length);
    var variance = values.reduce(function (s, v) { var d = v - mean; return s + d * d; }, 0) / Math.max(1, values.length);
    var sd = Math.sqrt(variance) || 1;
    return values.map(function (v) { return (v - mean) / sd; });
  }

  // SMOOTH to the gross gesture (field 2026-07-03): real hand shakes carry sample-level jitter
  // that decorrelates two genuine repeats (Brit's real matches capped ~0.73 vs 0.95 for clean
  // synthetic sines). A small moving average keeps the shape the person means and drops the noise.
  function smooth(v, w) {
    var half = (w - 1) / 2, out = [], i, k;
    for (i = 0; i < v.length; i++) {
      var s = 0, c = 0;
      for (k = -half; k <= half; k++) { var j = i + k; if (j >= 0 && j < v.length) { s += v[j]; c++; } }
      out.push(s / Math.max(1, c));
    }
    return out;
  }

  function countPeaks(values) {
    if (values.length < 3) return 0;
    var peaks = 0;
    for (var i = 1; i < values.length - 1; i++) {
      if (values[i] > values[i - 1] && values[i] > values[i + 1] && values[i] > 0.35) peaks++;
    }
    return peaks;
  }

  // DIRECTION: share of motion energy per device axis. |accel| alone is direction-blind —
  // an up-down shake, a side-side shake and a twist with the same rhythm score identical
  // magnitude envelopes (field bug 2026-07-02: matched vs deliberately-wrong shakes all ~0.55).
  function axisFractions(samples) {
    var xs = [], ys = [], zs = [];
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i] || {};
      if (Array.isArray(s)) { xs.push(Number(s[0]) || 0); ys.push(Number(s[1]) || 0); zs.push(Number(s[2]) || 0); }
      else { xs.push(Number(s.x) || 0); ys.push(Number(s.y) || 0); zs.push(Number(s.z) || 0); }
    }
    function variance(v) { var m = v.reduce(function (s2, x) { return s2 + x; }, 0) / Math.max(1, v.length);
      return v.reduce(function (s2, x) { var d = x - m; return s2 + d * d; }, 0) / Math.max(1, v.length); }
    var vx = variance(xs), vy = variance(ys), vz = variance(zs), tot = (vx + vy + vz) || 1;
    return [vx / tot, vy / tot, vz / tot].map(function (f) { return Math.round(f * 1000) / 1000; });
  }

  function mimicFingerprint(samples) {
    samples = Array.isArray(samples) ? samples : [];
    var mags = samples.map(sampleMagnitude);
    var durationMs = 0;
    if (samples.length > 1 && samples[0] && typeof samples[0] === "object" && "t" in samples[0]) {
      durationMs = Math.max(0, Number(samples[samples.length - 1].t) - Number(samples[0].t));
    } else {
      durationMs = samples.length * 16.7;
    }
    var mean = mags.reduce(function (s, v) { return s + v; }, 0) / Math.max(1, mags.length);
    var centered = mags.map(function (v) { return Math.abs(v - mean); });
    var energy = centered.reduce(function (s, v) { return s + v * v; }, 0) / Math.max(1, centered.length);
    var series = zscore(smooth(resample(centered, 48), 3));   // LIGHT smooth (w3): kills sample-jitter but keeps tempo detail (w5 blurred frequency → wrong-tempo over-scored)
    return {
      duration_ms: Math.round(durationMs),
      mean_magnitude: Math.round(mean * 1000) / 1000,
      energy: Math.round(energy * 1000) / 1000,
      peak_count: countPeaks(series),
      axes: axisFractions(samples),
      series: series.map(function (v) { return Math.round(v * 1000) / 1000; })
    };
  }

  function corr(a, b) {
    var n = Math.min(a.length, b.length);
    var dot = 0, aa = 0, bb = 0;
    for (var i = 0; i < n; i++) {
      dot += a[i] * b[i];
      aa += a[i] * a[i];
      bb += b[i] * b[i];
    }
    if (!aa || !bb) return 0;
    return dot / Math.sqrt(aa * bb);
  }

  // PHASE-TOLERANT correlation (field 2026-07-03): humans repeat a shake with timing drift/phase
  // offset, so a genuine match was capping ~0.70 on zero-lag corr. Slide up to ±maxLag samples
  // and take the best alignment — rewards "same shape, slightly early/late" without rescuing a
  // genuinely different rhythm (a wrong pattern has no good lag).
  function corrLag(a, b, maxLag) {
    var n = Math.min(a.length, b.length), best = -1, L, i, j;
    for (L = -maxLag; L <= maxLag; L++) {
      var dot = 0, aa = 0, bb = 0, cnt = 0;
      for (i = 0; i < n; i++) {
        j = i + L; if (j < 0 || j >= n) continue;
        dot += a[i] * b[j]; aa += a[i] * a[i]; bb += b[j] * b[j]; cnt++;
      }
      if (cnt > 20 && aa && bb) { var c = dot / Math.sqrt(aa * bb); if (c > best) best = c; }
    }
    return best <= -1 ? corr(a, b) : best;
  }

  function ratioScore(a, b) {
    a = Math.max(0.001, Math.abs(a));
    b = Math.max(0.001, Math.abs(b));
    return Math.exp(-Math.abs(Math.log(a / b)));
  }

  function mimicScore(a, b) {
    var fa = a && a.series ? a : mimicFingerprint(a);
    var fb = b && b.series ? b : mimicFingerprint(b);
    var shape = (corrLag(fa.series, fb.series, 6) + 1) / 2;   // ±6-sample (~12%) phase tolerance
    var duration = ratioScore(fa.duration_ms || 1, fb.duration_ms || 1);
    var energy = ratioScore(fa.energy || 0.001, fb.energy || 0.001);
    var peaks = ratioScore((fa.peak_count || 0) + 1, (fb.peak_count || 0) + 1);
    var axis = (fa.axes && fb.axes)
      ? clamp(1 - 0.5 * (Math.abs(fa.axes[0] - fb.axes[0]) + Math.abs(fa.axes[1] - fb.axes[1]) + Math.abs(fa.axes[2] - fb.axes[2])), 0, 1)
      : null;   // old stored refs have no axes → fall back to the direction-blind formula
    var score = (axis != null)
      ? clamp((0.60 * shape + 0.24 * energy + 0.16 * peaks) * (0.45 + 0.55 * axis), 0, 1)   // DIRECTION-AWARE (2026-07-02): direction is a MULTIPLIER, not a bonus — a perfect-rhythm wrong-direction shake caps at 0.45 (additive weighting let it hit 0.70 "that's it")
      : clamp(0.72 * shape + 0.16 * energy + 0.12 * peaks, 0, 1);
    var label = score >= 0.62 ? "that's it" : (score >= 0.42 ? "warmer" : "colder");   // field 2026-07-03: a real human match caps ~0.70 (0.70 base × ~1.0 axis), so 0.70 was unwinnable — Brit's best genuine try was 0.698. 0.62 = a solid match, still well above wrong-direction shakes (~0.2-0.3).
    return {
      score: Math.round(score * 1000) / 1000,
      label: label,
      parts: {
        shape: Math.round(shape * 1000) / 1000,
        axis: axis != null ? Math.round(axis * 1000) / 1000 : undefined,
        duration: Math.round(duration * 1000) / 1000,
        energy: Math.round(energy * 1000) / 1000,
        peaks: Math.round(peaks * 1000) / 1000
      }
    };
  }

  return {
    VERSION: VERSION,
    createBodyTruth: createBodyTruth,
    parseAgentAction: parseAgentAction,
    validateAction: validateAction,
    formatAction: formatAction,
    mimicFingerprint: mimicFingerprint,
    mimicScore: mimicScore
  };
});
