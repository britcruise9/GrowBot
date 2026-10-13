// brain-dial.js — the ONE shared cost/intelligence dial.
// Used by the LLM Lab (tester/llm.html) now and the creature's smart/dumb brain-power
// dial later — same scheme, one source. Reads the server-sorted /api/models catalog.
//
// Principles (from the spec):
//   • PRICE is the spine — always present, the simple slider walks price low→high.
//   • INTELLIGENCE is a BADGE, shown ONLY where OpenRouter actually reports a benchmark.
//     We never claim a universal score.
//   • COST is the SCOREBOARD, not a control — the live readout shows real usage.cost.
//   • The effort/thinking dial only does anything where the model supports `reasoning`.
//
// Usage:
//   import { BrainDial } from '/brain-dial.js';
//   await BrainDial.load();
//   const m = BrainDial.pickSimple(0.7);              // slider 0..1 → a cheap→smart rung
//   const body = { model:m.id, messages, max_tokens:300, usage:{include:true},
//                  ...BrainDial.reasoningBody(m,'high') };   // expert effort, only if supported
//   // …POST to /api/llm?target=openrouter… then:
//   const cost = BrainDial.costOf(responseJson);      // real $ this call (or null)

export const BrainDial = {
  data: null,

  async load(force) {
    if (this.data && !force) return this.data;
    const r = await fetch('/api/models');
    if (!r.ok) throw new Error('models ' + r.status);
    this.data = await r.json();
    return this.data;
  },

  simple() { return (this.data && this.data.simple) || []; },
  all()    { return (this.data && this.data.all) || []; },
  ready()  { return !!(this.data && this.data.simple && this.data.simple.length); },

  // SIMPLE mode: slider position 0..1 → a rung on the cheap→smart ladder.
  pickSimple(pos) {
    const L = this.simple(); if (!L.length) return null;
    const i = Math.max(0, Math.min(L.length - 1, Math.round((+pos || 0) * (L.length - 1))));
    return L[i];
  },
  // where on the simple ladder a model sits (0..1) — for syncing the slider to a pick.
  posOf(id) { const L = this.simple(); const i = L.findIndex(m => m.id === id); return (i < 0 || L.length < 2) ? 0 : i / (L.length - 1); },

  byId(id) { return this.all().find(m => m.id === id) || this.simple().find(m => m.id === id) || null; },

  // The cheapest thinking a model will accept — 'off' where that's allowed, else its LOWEST
  // supported effort. 0814 measured on google/gemini-3.7-flash at the creature's 256-token cap:
  // sending nothing (its own default_effort:'medium') burned 157-240 tokens on hidden reasoning and
  // 1 turn in 4 came back with no spoken line at all; effort:'low' spent 0-79 and 4/4 were clean.
  // So "off" for a mandatory model must mean "as low as it goes", never "omit the field".
  lowEffort(model) {
    const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const have = (model && model.efforts) || null;
    if (!have || !have.length) return 'low';                       // catalog didn't say → 'low' is accepted by every mandatory model seen so far
    for (const e of order) if (have.indexOf(e) >= 0) return e;
    return have[have.length - 1];
  },

  // The HARDEST thinking a model will accept, for the one call that has no latency budget (the dream).
  // 0814b: not a hardcoded 'high' — some mandatory models do not offer it (sakana/fugu-ultra lists
  // max/xhigh/high; inclusionai/ring-2.6-1t only xhigh/high), and asking for an effort a model does
  // not support is the same 400 in a different costume.
  highEffort(model) {
    const order = ['high', 'xhigh', 'max', 'medium', 'low', 'minimal'];
    const have = (model && model.efforts) || null;
    if (!have || !have.length) return 'high';
    for (const e of order) if (have.indexOf(e) >= 0) return e;
    return have[0];
  },

  // EXPERT effort/thinking dial → OpenRouter request extras. effort: 'off'|'low'|'medium'|'high'.
  // Applied ONLY where the model supports reasoning; a reasoning-mandatory model can't be turned
  // off, so 'off' turns it all the way DOWN instead (see lowEffort).
  reasoningBody(model, effort) {
    if (!model || !model.reasoning) return {};
    if (effort === 'off' || !effort) {
      return model.mandatory ? { reasoning: { effort: this.lowEffort(model) } } : { reasoning: { enabled: false } };
    }
    return { reasoning: { effort: effort } };   // 'low' | 'medium' | 'high' (OpenRouter unified param)
  },

  // the REAL per-call cost from an OpenRouter response (needs usage:{include:true} on the request).
  costOf(resp) { const u = resp && resp.usage; return (u && typeof u.cost === 'number') ? u.cost : null; },

  // labels (price-led; benchmark badge only where present)
  badge(model) { return (model && model.intel != null) ? ('IQ ' + Math.round(model.intel)) : ''; },
  estLabel(model) { if (!model) return ''; return model.callEst <= 0 ? 'free' : ('~' + money(model.callEst) + '/call'); },
  money: money
};

// adaptive $ formatter: fractions of a cent up to dollars, always readable.
function money(c) {
  c = +c || 0;
  if (c <= 0) return '$0';
  if (c < 0.01) return '$' + c.toFixed(c < 0.001 ? 5 : 4);
  if (c < 1) return '$' + c.toFixed(3);
  return '$' + c.toFixed(2);
}
