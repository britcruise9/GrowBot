# Actuator verb list

Every verb the agent can emit, per body. The agent composes freely from its body's menu; anything off-menu is rejected by the harness (see [SPEC-BODY-TRUTH.md](SPEC-BODY-TRUTH.md) §3–5). `motion: true` verbs count against the per-tick motion budget and duty limits.

## 1. Phone body (canonical — `body_truth.phone.json`, shipped)

| verb | kind | motion | args | hard limits (code-enforced) |
|---|---|---|---|---|
| `say` | atomic | no | `text: string` | ≤18 words; spoken verbatim — speakable words only, no symbols/emoji/stretched spellings |
| `sound` | atomic | no | `name: enum` | `chirp · trill · whistle · warble · blip · alarm · squeal · droop · fanfare · purr` |
| `sing` | atomic | no | `notes: [{hz, ms}]` | ≤6 notes; hz clamped to 80–900; ms clamped to 120–1200; played before any words |
| `burst` | atomic | no | `name: enum` | `sparkle · joy · pulse · ripple · shiver · rain` — a bloom of light on the screen |

Composition: any of these may co-occur in one reply (a chirp + a sentence is one moment). Emitting **no** verb is always legal — silence is a first-class answer, and the persona actively rewards it.

*What "code-enforced" means above: the validator truncates `say` to 18 words, rejects non-enum `sound`/`burst` values, and truncates/clamps `sing` to 6 notes in 80–900 hz / 120–1200 ms. The voice rules ("speakable words only", "played before any words") are prompt guidance plus actuator behavior — not validated.*

Easy adds for your own phone-class body: `vibrate(ms)` is a natural fifth verb; the shipped product omits it.

## 2. Two-leg walker body (reference extension — the shipped 85mm desk-walker)

What the same agent gains when the phone clips onto the 2-servo legged body:

| verb | kind | motion | args | hard limits (code-enforced) |
|---|---|---|---|---|
| `gesture` | atomic | yes | `steps: [{l, r, ms}]` | angles clamped in code to the file's soft band (the shipped walker file declares 50–130°, 90 = neutral; see SPEC-BODY-TRUTH §5 for the trim→band→min/max order); ms 120–2000 per step; whole gesture ≤3000 ms. Omit `l` or `r` in a step to hold that leg. **Free-authored** — the model invents the keyframes; named packs (wiggle/bow/sway) are few-shot examples, not the menu. |
| `walk` | **policy** | yes | `secs: number` | 0.5–8 s. A trained balance policy (30 Hz against the IMU) owns the gait; the agent only decides *to travel* and for how long. |
| `rest` | atomic | yes | — | both legs to neutral, then release (servos limp) |

Body-level budgets: 1 motion verb per tick — a gesture *or* a walk, or neither; move only when it means something. Duty window 20 s of motion per rolling 60 s.

## 3. N-servo bodies (designed direction, not shipped)

For arbitrary rigs the menu generalizes with channels addressed **by id** (see SPEC-BODY-TRUTH.md §6):

| verb | kind | shape |
|---|---|---|
| `gesture` | atomic | `steps: [{p: {"<channel_id>": deg, ...}, ms}]` — sparse pose maps; omitted channels hold |
| `walk` | policy | `(gain, secs)` — knobs exposed by the trained policy |
| `turn` | policy | `(gain)` — steering as a policy knob, not post-hoc mixing |
| `lift_leg` / `rotate` | atomic | named-channel primitives for arm/leg rigs |

Zero-shot LLMs reliably author expressive **gestures** on a described morphology; they do **not** reliably author coordinated cyclic **gaits**. Locomotion is the policy path. Cap the LLM path's channel count (a per-channel prompt table for 18 servos costs hundreds of tokens per call — collapse mirrored limbs by symmetry).

## 4. Engine-owned — never verbs

These exist so the creature is safe *regardless of what the model emits*. The agent cannot invoke, skip, or override them:

- **dead-man stop** — firmware neutrals the rig when the brain link goes silent (~500 ms)
- **duty budget** — motion time per rolling window; the actuator refuses past the cap
- **boot-limp** — an uncalibrated body never auto-moves; channels stay released until a human energizes one
- **reflexes** — instant trigger→act pairs (`tap→trill`) executed with no LLM call, even while the model is busy or the creature sleeps; the model may *install* one (whitelisted triggers/acts), never execute one inline
