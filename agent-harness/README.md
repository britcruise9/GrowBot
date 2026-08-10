# GrowBot agent harness — builder kit

The mind-side of [GrowBot](https://growbot.dev) — a phone-as-brain digital creature with a hardware path — packaged so you can run it, read it, and port it to your own rig. This is the field-hardened harness design distilled to its smallest honest form: the specs are the product of a live system with real users, and every "do this, not that" in them was paid for.

**Who this is for:** builders who want an LLM-driven creature/agent with durable identity, real memory discipline, and a clean body abstraction — on a phone, a robot, or anything with actuators.

## The whole contract in one line

```
the agent emits verbs  →  body_truth defines the verbs  →  the actuator executes them
```

The agent never sees hardware; it sees a menu. Swap the body file and the same mind drives a different body — a bare phone today, servo legs tomorrow, your rig after that. Off-menu output is rejected by the harness, loudly: that rejection working is the health signal of the whole design.

## Quickstart (60 seconds, no API key)

Requires Node ≥ 18. Zero dependencies.

```sh
node reference-loop.mjs --mock --ticks 4
```

You'll watch the contract work end-to-end: a wake tick, verbs validated and executed, one deliberately off-menu verb (`wag_tail`) **rejected**, an out-of-range sing note **clamped**, and a closing dream pass — the only writer of identity — committing what the run meant into `memory.json`.

Then live, with any [OpenRouter](https://openrouter.ai) key:

```sh
export OPENROUTER_API_KEY=sk-or-...
node reference-loop.mjs                 # interactive: type to talk, /dream forces sleep, /quit
MODEL=<any-openrouter-slug> node reference-loop.mjs   # default: anthropic/claude-sonnet-5
```

Or fully local, no key, with any OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM):

```sh
ollama serve                            # in another terminal (no CORS flag needed — this is Node, not a browser)
BASE_URL=http://localhost:11434/v1 MODEL=qwen3:8b node reference-loop.mjs
```

State persists in `memory.json` between runs — the creature you talk to tomorrow remembers (and has dreamed about) today. Delete the file to re-seed.

## What's in the folder

| file | what it is |
|---|---|
| [SPEC-MEMORY.md](SPEC-MEMORY.md) | the memory-region spec: constitution / identity / goals / working memory / episodic log, who may write what, and the failure modes you will otherwise rediscover |
| [SPEC-BODY-TRUTH.md](SPEC-BODY-TRUTH.md) | the `body_truth.json` schema (machine face + LLM face), the actuator contract, and the motor-body safety/trust model |
| [VERBS.md](VERBS.md) | the actuator verb list: phone menu (shipped), 2-leg walker menu (reference), N-servo direction |
| [body_truth.phone.json](body_truth.phone.json) | the worked example — the bare-phone body the shipped product runs |
| [reference-loop.mjs](reference-loop.mjs) | ~300-line runnable harness: one loop, one model, the full write-permission discipline |
| `prompts/` | the fixed regions, verbatim from the shipped engine: `constitution.txt` (swappable persona) · `safety-floor.txt` (engine-owned, always appended, never editable) · `dream.txt` (the consolidation pass). Kept verbatim on purpose, so some clauses reference phone senses (camera, mic, touch) the terminal reference doesn't feed — the creature copes; trim the persona for your rig freely. |
| [memory.seed.json](memory.seed.json) | a fresh creature: seeded identity (with a movement temperament — never ship a blank), empty log |

## The five design laws (the short version)

1. **One memory blob, regions with different writers.** The fast loop can never write identity; only the slow dream can — and its commits are clamped in code (patch ±1 sentence, hard cap). Prompt convention is not a lock; a single writer function is.
2. **Only a real exchange earns a memory slot.** Idle ticks that push "(stayed quiet)" entries will evict the actual conversation within minutes. This bug was independently rediscovered twice; it is an attractor. See SPEC-MEMORY §4.
3. **Narration ≠ action.** To act, the model must emit the verb in the same reply. Prose intent is treated as nothing.
4. **The prompt is advisory; the clamp is code.** Validate against the menu, clamp to the machine face's limits, budget motion. A hallucinated 999° means "far", not a crash — and `wag_tail` on a body without a tail means nothing at all.
5. **Safety is engine-owned.** The safety floor is appended after any loaded persona and can't be stripped by one. Dead-man, duty budgets, and boot-limp are not verbs. And a downloaded body_truth commands real motors — **calibrate locally before motion; never trust a file's declared limits as a safety control.**

## Porting to your hardware

Replace one function — `actuate()` in the reference loop — with your transport, and write a `body_truth` for your rig (SPEC-BODY-TRUTH §6 first: channel table, boot-limp, per-device calibration layered on top, and the power-budget math if you're past ~4 servos). One honest caveat before you wire it up: the phone actuator is open-loop (spoken intent, cooperative human); motors close the loop. The interface survives the swap; the control problem doesn't — re-validate behavior once your verbs actually change what the sensors see.

Out of scope here, by design: the sensing side (the mirror spec: sensor channels → felt magnitudes, "senses are felt, not reported"), the reflex tier, the energy economy, onboarding, the loadable-personality ("soul") format and its gallery, and the relay/firmware protocol for the shipped 2-leg body. The kit is the mind and the body contract; ask if you need the rest.

## Contact & license

Questions, ports, or a body you want the creature to drive: **info@growbot.dev** · [growbot.dev](https://growbot.dev)

Code: PolyForm Noncommercial 1.0.0 · Docs: CC BY-NC 4.0 — see [LICENSE.md](LICENSE.md).
