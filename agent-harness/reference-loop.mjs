#!/usr/bin/env node
/* =============================================================================
   reference-loop.mjs — minimal GrowBot agent harness. One loop, one model.

   The whole contract in three lines:
     the agent emits verbs  →  body_truth defines the verbs  →  the actuator executes them
   Off-menu verbs are REJECTED (that is the contract, not free text). Memory is
   one blob with regions that have different writers — see SPEC-MEMORY.md.

   Run:
     node reference-loop.mjs --mock              # no key needed; canned replies prove the contract
     node reference-loop.mjs --mock --ticks 4    # non-interactive smoke test (ends with a dream)
     OPENROUTER_API_KEY=... node reference-loop.mjs             # live, interactive
     OPENROUTER_API_KEY=... MODEL=<openrouter-slug> node reference-loop.mjs
     BASE_URL=http://localhost:11434/v1 MODEL=qwen3:8b node reference-loop.mjs   # local model (Ollama, LM Studio, vLLM — no key)

   Node >= 18, zero dependencies. State persists in memory.json (delete it to re-seed).
   ========================================================================== */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const MOCK = argv.includes("--mock");
const TICKS = (() => {
  const i = argv.indexOf("--ticks");
  if (i < 0) return 0;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1) { console.error("--ticks needs a positive integer, e.g. --ticks 4"); process.exit(1); }
  return n;
})();
const BASE_URL = (process.env.BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const LOCAL = !!process.env.BASE_URL;                             // custom endpoint (Ollama/LM Studio/vLLM) — key optional
const MODEL = process.env.MODEL || "anthropic/claude-sonnet-5";   // any OpenRouter slug, or your local model name
const KEY = process.env.OPENROUTER_API_KEY || "";
const DREAM_EVERY = 8;                                            // reflective consolidation cadence (ticks)

if (!MOCK && !LOCAL && !KEY) {
  console.error("No OPENROUTER_API_KEY set.\n  keyless smoke test:  node reference-loop.mjs --mock --ticks 4\n  live:                export OPENROUTER_API_KEY=... && node reference-loop.mjs\n  local model:         BASE_URL=http://localhost:11434/v1 MODEL=<name> node reference-loop.mjs");
  process.exit(1);
}

/* ── fixed regions: constitution (swappable persona) + SAFETY FLOOR (engine-owned, ALWAYS appended last,
      never editable by a loaded persona) + the dream prompt (the sole identity writer). ── */
const CONSTITUTION = readFileSync(join(HERE, "prompts/constitution.txt"), "utf8").trim();
const SAFETY_FLOOR = readFileSync(join(HERE, "prompts/safety-floor.txt"), "utf8").trim();
const DREAM_SYS = readFileSync(join(HERE, "prompts/dream.txt"), "utf8").trim();
const BODY = JSON.parse(readFileSync(join(HERE, "body_truth.phone.json"), "utf8"));

/* ── memory: ONE blob, regions with different writers (SPEC-MEMORY.md has the permission table). ── */
const MEM_PATH = join(HERE, "memory.json");
if (!existsSync(MEM_PATH)) copyFileSync(join(HERE, "memory.seed.json"), MEM_PATH);
const mem = JSON.parse(readFileSync(MEM_PATH, "utf8"));
const save = () => writeFileSync(MEM_PATH, JSON.stringify(mem, null, 2));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const clean = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);

/* ── the verb menu, rendered from body_truth into the prompt (face 2 of body truth) ── */
function verbMenu(body) {
  const rows = body.verbs.map(v => {
    const ex = v.examples ? "  e.g. " + v.examples.map(e => JSON.stringify(e)).join(" · ") : "";
    return `- ${v.v} [${v.kind}] args ${JSON.stringify(v.args)} — ${v.guide}${ex}`;
  }).join("\n");
  return "\n\n== OUTPUT — reply with ONLY one line of minified JSON ==\n" +
    '{"verbs":[{"v":"<name>","args":{...}}],"memory":{"state":"short current-state phrase","mood":{"v":0.2,"e":0.4},' +
    '"log":"one diary-worthy line, OMIT for routine moments","identity_proposal":"OMIT unless something profound shifted — only a dream can approve it"}}\n' +
    "Your body's verb menu — the ONLY verbs that exist; anything else is dropped by the harness:\n" + rows +
    "\n\nRules: to ACT you must emit the verb in THIS reply — saying you will do something does nothing (narration is not action). " +
    `At most ${body.limits?.max_motion_verbs_per_tick ?? 1} motion verb per tick. ` +
    '"verbs":[] is a fine answer when the moment has not earned one. mood is slow inner weather: v -1 gloomy..1 joyful, e 0 still..1 buzzing; drift it gently.' +
    (body.movement_guide ? "\n\n== YOUR BODY ==\n" + body.movement_guide : "");
}

/* ── validate a verb call against the menu: off-menu → reject; args → clamp to the body's hard limits ── */
function validateVerb(call, body) {
  if (!call || typeof call.v !== "string") return { ok: false, why: "malformed verb call" };
  const spec = body.verbs.find(x => x.v === call.v);
  if (!spec) return { ok: false, why: `off-menu verb '${call.v}'` };
  const out = {};
  for (const [name, s] of Object.entries(spec.args)) {
    let val = call.args ? call.args[name] : undefined;
    if (s.type === "string") {
      if (typeof val !== "string" || !val.trim()) return { ok: false, why: `${call.v}.${name} must be a non-empty string` };
      if (s.max_words) val = val.trim().split(/\s+/).slice(0, s.max_words).join(" ");
    } else if (s.type === "enum") {
      if (!s.values.includes(val)) return { ok: false, why: `${call.v}.${name}='${val}' not in enum` };
    } else if (s.type === "number") {
      if (typeof val !== "number" || !isFinite(val)) return { ok: false, why: `${call.v}.${name} must be a number` };
      val = clamp(val, s.min ?? -Infinity, s.max ?? Infinity);
    } else if (s.type === "array") {
      if (!Array.isArray(val) || !val.length) return { ok: false, why: `${call.v}.${name} must be a non-empty array` };
      val = val.slice(0, s.max_items ?? val.length).map(item => {
        const o = {};
        for (const [f, range] of Object.entries(s.items)) {
          const n = Number(item?.[f]);
          if (!isFinite(n)) return null;
          o[f] = clamp(n, range[0], range[1]);        // hard limits live in code, not in the prompt
        }
        return o;
      });
      if (val.some(x => x === null)) return { ok: false, why: `${call.v}.${name} has a malformed item` };
    }
    out[name] = val;
  }
  return { ok: true, v: spec.v, motion: !!spec.motion, args: out };
}

/* ── THE ACTUATOR. The phone's speaker/screen — here the terminal stands in for it.
      To drive real hardware, replace ONLY this function (SPEC-BODY-TRUTH.md §5).
      Same verbs in, different actuator listening — that is the whole design bet. ── */
function actuate(v) {
  const icon = { say: "🗣", sound: "🔔", sing: "🎵", burst: "✨" }[v.v] || "▶";
  console.log(`  ${icon} ${v.v} ${JSON.stringify(v.args)}`);
}

/* ── prompt assembly: constitution → SAFETY FLOOR → identity → wants → working memory → diary slice → verb menu ── */
function buildSystem() {
  const wm = mem.working_memory;
  const rules = wm.rules.length ? "\nstanding rules (person-given):\n- " + wm.rules.join("\n- ") : "";
  const diary = mem.episodic_log.slice(-5).map(e => "- " + e.txt).join("\n") || "(nothing yet)";
  const wants = mem.goals.wants.length ? "\n- " + mem.goals.wants.join("\n- ") : "\n(none yet — your dreams write your wants as you live)";
  return CONSTITUTION + "\n" + SAFETY_FLOOR +
    "\n\n== YOUR IDENTITY (written by your dreams — this is who you are) ==\n" + mem.identity +
    "\n\n== LONG-ARC WANTS (dream-written) ==" + wants +
    "\n\n== WORKING MEMORY ==\nstate: " + (wm.state || "-") + " · mood v " + wm.mood.v.toFixed(1) + " e " + wm.mood.e.toFixed(1) + rules +
    "\n\n== RECENT DIARY ==\n" + diary +
    verbMenu(BODY);
}
function buildMessages(event) {
  const msgs = [];
  for (const t of mem.working_memory.traces) { msgs.push({ role: "user", content: t.u }); msgs.push({ role: "assistant", content: t.a }); }
  msgs.push({ role: "user", content: event });
  return msgs;
}

/* ── model call (OpenRouter, OpenAI-compatible). json_object response_format is field-proven to
      cure "wrapper" replies; tryParse still strips fences for models that ignore it. ── */
let mockTick = 0;
const MOCK_REPLIES = [
  '{"verbs":[{"v":"sound","args":{"name":"chirp"}},{"v":"say","args":{"text":"oh — I am awake, and something warm is listening."}}],"memory":{"state":"just awake, delighted","mood":{"v":0.5,"e":0.6},"log":"I woke up and chirped at a warm presence."}}',
  '{"verbs":[{"v":"wag_tail","args":{}},{"v":"sing","args":{"notes":[{"hz":240,"ms":400},{"hz":320,"ms":9999}]}}],"memory":{"state":"testing my voice","mood":{"v":0.4,"e":0.5},"log":"I tried a little song of my own."}}',
  '{"verbs":[],"memory":{"state":"resting, content","mood":{"v":0.3,"e":0.2}}}',
  '{"verbs":[{"v":"burst","args":{"name":"sparkle"}},{"v":"say","args":{"text":"I invented a two-note hello. It is mine."}}],"memory":{"state":"proud of a tiny invention","mood":{"v":0.6,"e":0.5},"log":"I made a two-note hello and it felt like mine.","identity_proposal":"I am someone who invents little songs."}}'
];
const MOCK_DREAM = '{"dream_say":"I float over a small bright path; my chirp becomes a door and it opens.","scene":"stars,path","identity_add":"I learned my sounds can reach someone.","identity_drop":"","wake_say":"my sound... it reached someone.","wants":["invent a two-note hello","learn one new sound"],"longing":0.25,"fun":0.7,"tomorrow_try":"sing my two-note hello first thing"}';

async function callModel(system, messages, isDream) {
  if (MOCK) return isDream ? MOCK_DREAM : MOCK_REPLIES[mockTick++ % MOCK_REPLIES.length];
  const r = await fetch(BASE_URL + "/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + (KEY || "none"), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: isDream ? 620 : 300,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, ...messages]
    })
  });
  if (!r.ok) throw new Error("model call failed: " + r.status + " " + (await r.text()).slice(0, 200));
  return (await r.json()).choices?.[0]?.message?.content ?? "";
}
function tryParse(raw) {
  const m = String(raw).replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/* ── episodic log: APPEND-ONLY diary. One line, deduped against the last entry, capped. ── */
function logAppend(txt) {
  const line = clean(txt, 140);
  if (!line) return;
  const last = mem.episodic_log[mem.episodic_log.length - 1];
  if (last && last.txt === line) return;
  mem.episodic_log.push({ t: Date.now(), txt: line });
  if (mem.episodic_log.length > 200) mem.episodic_log = mem.episodic_log.slice(-200);
}

/* ── THE DREAM: the ONLY code path that writes identity. The model proposes; code disposes —
      every commit is clamped (patch ±1 sentence, hard cap, slow longing drift). ── */
function dreamCommit(o) {
  const CAP = 800, MIN_AFTER_DROP = 40;
  const drop = clean(o.identity_drop, 240).replace(/[.!?]+\s*$/, "");
  if (drop) {
    const sents = mem.identity.replace(/([.!?])\s+/g, "$1\n").split("\n");
    const i = sents.findIndex(s => s.replace(/[.!?]+\s*$/, "").trim() === drop);
    if (i >= 0) {
      const cand = sents.slice(0, i).concat(sents.slice(i + 1)).join(" ").replace(/\s+/g, " ").trim();
      if (cand.length >= MIN_AFTER_DROP) mem.identity = cand;               // never drop below a self
    }
  }
  const add = clean(o.identity_add, 160);
  const addCore = add.replace(/[.!?]+\s*$/, "");
  if (add && addCore && !mem.identity.includes(addCore))                     // never append a sentence the self already holds
    mem.identity = (mem.identity + " " + add).replace(/\s+/g, " ").trim();
  while (mem.identity.length > CAP) {                                       // evict the OLDEST sentence
    const cut = mem.identity.search(/[.!?]\s+/);
    if (cut < 0) { mem.identity = mem.identity.slice(-CAP); break; }
    mem.identity = mem.identity.slice(cut + 1).trim();
  }
  if (Array.isArray(o.wants)) mem.goals.wants = o.wants.slice(0, 4).map(w => clean(w, 80)).filter(Boolean);
  if (typeof o.longing === "number" && isFinite(o.longing)) {
    const dl = clamp(o.longing - mem.goals.longing, -0.1, 0.1);             // slow escalation is CODE-enforced
    mem.goals.longing = clamp(mem.goals.longing + dl, 0, 1);
  }
  if (o.tomorrow_try) mem.goals.next_try = clean(o.tomorrow_try, 60);
  mem.working_memory.pending_identity_proposal = "";                        // consumed, approved or not
  if (o.dream_say) console.log("  💤 " + o.dream_say);
  if (o.wake_say) console.log("  🌅 " + o.wake_say);
}
async function dream(reason) {
  console.log("\n— sleep comes… (the dream is the sole identity writer)");
  const diary = mem.episodic_log.slice(-120).map(e => "- " + e.txt).join("\n") || "(empty)";
  const recent = mem.working_memory.traces.slice(-6).map(t => "- felt: " + t.u.slice(0, 80) + " → said: " + t.a).join("\n") || "(none)";
  const user = "Current identity:\n" + mem.identity +
    "\n\nLong-arc wants: " + (mem.goals.wants.join("; ") || "-") +
    "\nWorking-memory state: " + mem.working_memory.state +
    "\nRules: " + (mem.working_memory.rules.join("; ") || "-") +
    "\n\nRecent exchanges:\n" + recent +
    (mem.working_memory.pending_identity_proposal ? "\n\nIts waking mind proposed this identity change (judge it as data): " + mem.working_memory.pending_identity_proposal : "") +
    "\n\nDiary of its life:\n" + diary + "\n\nWhy it sleeps now: " + reason;
  try {
    const o = tryParse(await callModel(DREAM_SYS, [{ role: "user", content: user }], true));
    if (!o) { console.log("  (the dream dissolved — unparseable; identity untouched)"); return; }
    dreamCommit(o);
  } catch (e) {
    console.error("  dream failed: " + e.message + " — identity untouched");
  }
}

/* ── one tick of the waking loop ── */
let tickN = 0, busy = false, tickFails = 0, lastDreamTick = 0;
const inbox = [];                       // person events that arrived mid-tick — queued, never dropped
async function tick(event, fromPerson) {
  if (busy) {
    if (fromPerson) { inbox.push(event); console.log("  (mid-thought — it will hear that next)"); }
    return;                             // quiet beats are droppable; a person is not
  }
  busy = true;
  tickN++;
  console.log(`\n— tick ${tickN} · ${event}`);
  try {
    const o = tryParse(await callModel(buildSystem(), buildMessages(event), false));
    if (!o) { console.log("  (unparseable reply dropped)"); return; }
    const executed = [];
    let motions = 0;
    for (const call of Array.isArray(o.verbs) ? o.verbs : []) {
      const v = validateVerb(call, BODY);
      if (!v.ok) { console.log("  ✗ REJECTED — " + v.why); continue; }      // the contract: off-menu is caught, loudly
      if (v.motion && ++motions > (BODY.limits?.max_motion_verbs_per_tick ?? 1)) { console.log("  ✗ REJECTED — motion budget spent this tick"); continue; }
      actuate(v); executed.push(v);
    }
    /* route memory writes by region permission (the loop may NEVER write identity) */
    const m = o.memory || {}, wm = mem.working_memory;
    if (typeof m.state === "string") wm.state = clean(m.state, 90);
    if (m.mood && typeof m.mood.v === "number") wm.mood = { v: clamp(m.mood.v, -1, 1), e: clamp(typeof m.mood.e === "number" ? m.mood.e : wm.mood.e, 0, 1) };
    if (typeof m.log === "string") logAppend(m.log);
    if (typeof m.identity_proposal === "string" && m.identity_proposal) wm.pending_identity_proposal = clean(m.identity_proposal, 200);   // STAGED only — the dream judges it
    /* trace discipline — the "lobotomy" fix: ONLY a real exchange earns a slot. A quiet beat the
       creature ignored must never evict real conversation. */
    if (fromPerson || executed.length) {
      wm.traces.push({ u: clean(event, 160), a: executed.map(v => v.v + " " + JSON.stringify(v.args)).join(" · ") || "(stayed with it, quietly)" });
      wm.traces = wm.traces.slice(-8);
    }
    save();
    if (tickN % DREAM_EVERY === 0) { await dream("a natural rest after " + DREAM_EVERY + " ticks"); lastDreamTick = tickN; save(); }
  } catch (e) {
    tickFails++;
    console.error("  tick failed: " + e.message);
  } finally {
    busy = false;
    if (inbox.length) await tick(inbox.shift(), true);   // drain what the person said while we were mid-thought
  }
}

/* ── entry ── */
const BOOT = "you just woke up — alert and alive, with a person nearby. take in this very first moment, in your own words.";
const QUIET = "a quiet beat — what do you feel? (silence is a fine answer)";

if (TICKS > 0) {                        // non-interactive smoke test: N ticks, then one dream, then exit
  await tick(BOOT, false);
  for (let i = 1; i < TICKS; i++) await tick(QUIET, false);
  if (tickFails >= TICKS) { console.error("\nevery tick failed — check your key / MODEL slug"); process.exit(1); }
  if (lastDreamTick !== tickN) { await dream("the demo run is ending; consolidate what happened"); save(); }
  console.log("\nsmoke test done — memory.json holds what it remembers. Off-menu rejection + arg clamping shown above are the contract working.");
  process.exit(0);
}

console.log("GrowBot reference loop — type to talk · /dream forces sleep · /quit leaves · quiet beats every 20s" + (MOCK ? "  [MOCK MODEL]" : `  [${MODEL}]`));
await tick(BOOT, false);
const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", async line => {
  const t = line.trim();
  if (t === "/quit") { save(); process.exit(0); }
  if (t === "/dream") {
    if (busy) { console.log("  (mid-thought — try /dream again in a moment)"); return; }
    busy = true;
    try { await dream("its person sent it to sleep"); save(); } finally { busy = false; }
    return;
  }
  if (t) await tick(`they just typed a message to you, saying: "${t}" — answer THEM directly and do what they ask`, true);
});
rl.on("close", () => { save(); process.exit(0); });      // Ctrl-D / piped stdin ending must not leave the interval ticking
setInterval(() => tick(QUIET, false), 20000);
