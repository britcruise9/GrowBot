# body_truth.json spec — the single source of body capability

The agent never sees hardware. It sees a **menu of verbs**. The whole runtime contract is three pieces, readable by anyone:

```
the agent emits verbs  →  body_truth defines the verbs  →  the actuator executes them
```

Change the body file and the same agent drives a different body. A bodiless phone gets a short menu (`say`, `sound`, `sing`, `burst`); a legged rig adds motion verbs. **The agent logic does not change — only the body description does.** That is the design bet this whole kit exists to make portable.

## 1. Two faces, one file

body_truth has two audiences and both live in the same file so they can never drift apart:

- **Machine face** — arg schemas and hard limits. Code validates and clamps against these. For motor bodies, also the channel table (§6).
- **LLM face** — `movement_guide` plus each verb's `guide` line and `examples`, rendered verbatim into the prompt.

Rules learned the hard way:
- **Route the REAL ranges into the prompt.** Never hardcode a narrower band in prompt text than the machine face allows (a live bug once told the model 50–130° while the body did 5–175° — the creature moved timidly forever).
- **Ship example poses, not just numbers.** Told a full range with no examples, models stay timid. Demonstrations spanning gentle→bold are what routes "use your whole body." Frame them as *"these show the format and what's possible — invent your own, don't replay these."*
- **The generative path is primary.** Named gesture packs (wiggle/bow/sway) are few-shot examples and optional canned routines — never cage the model to a fixed menu of prebaked moves when it can author free ones.

## 2. Schema

```jsonc
{
  "format": "growbot-body-truth",      // required, literal
  "version": 1,
  "id": "phone-bare",                  // stable body id
  "name": "human-readable name",
  "movement_guide": "LLM-readable paragraph, rendered into the prompt verbatim (face 2)",
  "verbs": [
    {
      "v": "say",                      // the verb name — the agent's ONLY handle on this capability
      "kind": "atomic",                // "atomic" (deterministic primitive) | "policy" (learned skill with knobs)
      "motion": false,                 // motion verbs count against the per-tick motion budget + duty limits. default false
      "args": { /* per-arg spec, see §3 */ },
      "guide": "one line the LLM reads — what this verb is FOR, plus any voice rules",
      "examples": [ /* optional few-shot arg objects, gentle → bold */ ]
    }
  ],
  "limits": {
    "max_motion_verbs_per_tick": 1     // body-level budgets; motor bodies add duty windows here (§6)
  },
  "channels": [ /* motor bodies only — the machine face of the actuators, §6 */ ]
}
```

## 3. Arg-spec mini-language

What the reference validator (`validateVerb` in `reference-loop.mjs`) implements:

| type | fields | validation |
|---|---|---|
| `string` | `max_words` | reject empty; truncate to max_words |
| `enum` | `values[]` | reject anything not in the list |
| `number` | `min`, `max` | reject non-numbers; **clamp** into range |
| `array` | `max_items`, `items:{field:[min,max]}` | reject empty/malformed; truncate count; clamp each numeric field |

Rejection vs clamping: an **off-menu verb or malformed call is rejected whole and loudly logged** — that's the contract being enforced, and it's the cheapest early health signal of the whole system ("off-menu output is caught" matters more than "a string came back"). A merely **out-of-range number is clamped** — a hallucinated 999° means "far", not "crash".

## 4. Verb kinds — atomic vs policy

- **atomic** — deterministic primitives: `say(text)`, `sing(notes)`, `gesture(steps)`, `lift_leg(which, amount)`. The actuator executes them directly.
- **policy** — learned skills exposed as verbs with knobs: `walk(secs)`, `turn(gain)`. A trained controller (e.g. an evolved/RL walk policy running at 30 Hz against the IMU) owns the *how*; the agent only decides *that* and *how much*.

**They are the same shape to the agent** — it cannot tell them apart, and must not need to. Sequential composition is free (`walk` then `gesture`). Concurrent blending — two verbs writing one actuator at once — is explicitly out of scope; don't design for it until you need it.

## 5. The actuator contract

The actuator is the **only** runtime consumer of body_truth. Pipeline, in order:

1. **Validate** the verb call against the menu (§3). Off-menu → reject + log.
2. **Clamp** every arg. The prompt is advisory; **the clamp is authoritative and lives in code**. For LLM-authored motion (gestures), clamp in this order: per-channel trim, then the soft `band`, then hard `min`/`max` — trim applied after a clamp can escape it, so trim goes first. Policy verbs clamp only to hard travel; the trained controller owns smoothness inside it.
3. **Budget** — enforce `max_motion_verbs_per_tick` and (motor bodies) duty windows.
4. **Execute** on the current body.

Same verbs in, different actuator listening: on the bare phone, the actuator is the speaker/screen (in the reference loop, the terminal stands in — `actuate()` is deliberately the only function you replace to drive real hardware). On a rig, it's the transport to your servo controller.

**Narration ≠ action.** The prompt tells the model: to act, emit the verb in *this* reply. The harness treats prose intent ("I'll turn and look around!") as nothing. Without this line, models reliably narrate instead of acting.

**One honest caveat for roboticists:** on the phone, "turn left" spoken through a speaker produces no guaranteed change in the next camera frame — the agent is *open-loop*, dependent on a cooperative human. Motors close the loop: the same verb now changes what the sensors see next tick. The **interface** survives the swap unchanged; the **control problem** does not. Behavior tuned open-loop (goal-holding given cooperative feedback) will need re-validation when your actuator closes the loop.

## 6. Extending to a motor body

For anything with actuators, add the machine face as a channel table, and read this section twice — everything in it was paid for.

```jsonc
"channels": [
  { "id": "leg_l",            // stable key — gestures and action maps address channels by id
    "idx": 0,                 // integer position in the wire vector (the chip maps idx → pin; pins are firmware truth, never in this file)
    "min": 0, "max": 180,     // HARD mechanical travel — phone-side clamp
    "neutral": 90,            // safe rest pose; dead-man and rest() target this
    "band": [50, 130],        // SOFT expressive range: the LLM is told it AND LLM-authored gestures are clamped to it (§5). Its VALUES are per-file truth — never hardcode them in engine code
    "sign": 1, "trim": 0 }    // file-level defaults ONLY — per-device calibration is a separate runtime layer on top, never baked in
],
"limits": { "max_motion_verbs_per_tick": 1, "duty_ms": 20000, "duty_window_ms": 60000, "max_gesture_ms": 3000 }
```

Safety machinery that is **engine-owned and never appears as verbs** (the agent can't invoke, skip, or override it): the dead-man stop (firmware neutrals the rig when the brain link goes silent), the duty budget, reflexes, and **boot-limp** — an uncalibrated rig must *never* auto-move on boot or connect; all channels stay released until a human explicitly energizes one during calibration.

**Trust model — the part that is different from every other loadable artifact.** A downloaded personality is text; a downloaded policy is pure inference; a downloaded body_truth **commands real motors**, and your safety clamps clamp *to its declared limits*. A wrong or malicious file declaring `min:0, max:180` on a joint that mechanically stops at 40–120 makes a faithful harness drive the joint into its stop. **Clamping to attacker-supplied bounds is not a safety control.** Any body_truth you did not measure yourself goes through a calibrate-and-confirm-limits pass on the local rig — limits re-derived locally, never trusted from the file — before it may command motion.

**Power is the thing that actually changes with scale.** Two micro-servos run happily off a small 1S pack; the same wiring at N servos is a brownout machine (N stalling MG90S-class servos ≈ tens of amps). Above ~4 servos: separate servo supply/BEC sized from per-channel stall current, stagger multi-channel move starts (inrush), and bill duty in *servo-seconds* (channels × time), not wall-clock. A brownout also kills the rail your dead-man runs on — supply sizing is the mitigation, not the watchdog.

## 7. The worked example

[`body_truth.phone.json`](body_truth.phone.json) is the bare-phone body: four atomic, motionless verbs (`say`, `sound`, `sing`, `burst`), a movement guide that frames sound and light *as* the creature's gesture space, few-shot `sing` examples, and no channel table. It is deliberately the smallest real body file — and it is the body the shipped product runs for most users. A verb menu for the 2-leg walker body appears in [VERBS.md](VERBS.md) §2 as a reference extension.
