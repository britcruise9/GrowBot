# app: browser code from growbot.dev (read-only)

A copy of browser code that growbot.dev serves, taken on 2026-11-12 from commit `39eb8143` of the private GrowBot repo (build `6eayvkvufuuy`), the build that was live that day. Every file here matches growbot.dev byte for byte, except the three listed under "Edited comments" below. It is here so you can read how the app works and borrow pieces of it. Paths match the site: `app/v3/visual-memory.js` is [growbot.dev/v3/visual-memory.js](https://growbot.dev/v3/visual-memory.js).

Testers' names, session ids, device ids and internal paths were taken out of the comments on the live site itself on 2026-10-13. No code logic changed.

## Edited comments

Newer comments in three files named testers or pointed at internal notes. In this copy I swapped only that comment text for "a tester", "another tester", "a Discord user", "internal notes" or "the brand reference". No code changed, so these three files differ from growbot.dev in those comment lines only.

| file | sha256 of the growbot.dev original | lines | what was taken out |
|---|---|---|---|
| `v3/next.html` | `3a786e22b1ebaacc2d38f536ef7ed3e389c14ea403d6a0be8c1f89f6480cecc8` | 1541, 1678, 1707, 2290, 5719, 6540, 6734, 9339, 11369, 12931 | testers' names |
| | | 2313, 5746, 6174, 6269, 10817, 10936, 11562, 12931, 12952 | internal file paths |
| `v3/prompts.js` | `c35dcb4602098b9fd98e15d9155f1776c81c6b1f9fa812be062e4e52b4bde3fc` | 387, 519 | internal file paths |
| `v3/soul.js` | `48d6ae3e42583585c869427c2407435f51453f0af1bebaf74ef1763cacf3c79f` | 53 | an internal file path |

## Changes since the 2026-10-13 copy

- Updated to today's bytes: `getup-agent.js`, `getup-wire.js`, `normal-spin.js`, `relay-transport.js`, `tester/custom.html`, `tester/face.html`, `tester/face-original.html`, `tester/index.html`, `tester/motor.html`, `tester/policy.html`, `v3/expression.js`, `v3/next.html`, `v3/prompts.js`, `v3/soul.js`, `v3/visual-memory.js`.
- New: `trim-store.js`, `parts.js`, `leg-trim.mjs`, `v3/world-eye.js`, `tester/arm.html`.
- Removed: none. Every file in the last copy is still served.

## Remembered images

The creature can remember what you show it: a person, an object, handwriting, a scene or a place.

- [`v3/visual-memory.js`](v3/visual-memory.js) saves, names, recalls, compares and forgets. Saved views stay on the phone, in the browser's IndexedDB. To check or compare, it sends the saved views and the camera image to the AI model the creature is using.
- [`v3/visual-memory-ui.js`](v3/visual-memory-ui.js) is what you see and hear while it looks.

Both lean on the main app page, [`v3/next.html`](v3/next.html), for the camera, brain and voice. It hands them functions such as `llmCfg`, `saveSoul`, `logEv`, `soulLog`, `soulOwned` and `brainChoice`. Search next.html for `visual-memory` to see how they are loaded and wired in.

## What else is here

- `v3/next.html`: the main app page (the creature, its brain loop, camera, voice and body). growbot.dev opens it for every robot link and for creatures that moved up from the first app.
- `v3/`: the creature's modules: prompts, soul format, expression, the agent kernel, face tracking, imitation, and `body.json` (the stock body).
- `v3/world-eye.js`: an opt-in, log-only experiment that keeps small fingerprints of what the camera sees, on the phone. It does not steer anything.
- `tester/`: [growbot.dev/tester](https://growbot.dev/tester), the page builders use to pair and test a body (calibrate, move, face, custom agent), plus `tester/arm.html`, a manual remote for a servo arm.
- The root files: the relay client (`relay-transport.js`), walk, spin and get-up wiring, the policy runners, `agent-gateway.js` (the safety layer between your own agent and the robot), per-robot leg trims (`trim-store.js`, `leg-trim.mjs`), extra servos the creature moves by name (`parts.js`), the analytics beacon and the feedback widget.
- Trained walks and spins the app loads:
  - `policy_85mm.json` (the walk the app launched with, same file as [`policy/policy_85mm.json`](../policy/policy_85mm.json)) and `policy_drrma.json` (the DR-RMA walk), both trained by Harsh Dadwal.
  - `policies/spin-v4-0911.json`: the stock leg spin, trained by Harsh Dadwal.
  - `policies/diy-v1/`, `policies/forward-0930/`, `policies/normal-spin-1005/` and `optional-gyro-bench/`: newer walks and spins trained in our own sim. Some are still experiments behind test links.

## What is not here

- **The server.** Everything under growbot.dev/api (brain, journal, feedback, credits) is not in this repo. These files call growbot.dev's APIs, so they will not run on their own as-is.
- **The tester's LLM tab**, `tester/llm.html`. You can still open it at growbot.dev.
- **Third-party files** growbot.dev serves next to this code. They belong to their authors, under their own licences:

  | what | version | licence | on growbot.dev |
  |---|---|---|---|
  | Google MediaPipe tasks-vision, with the BlazeFace short-range face model | 0.10.18 | Apache 2.0 | `/vendor/mediapipe/` |
  | ONNX Runtime Web | 1.19.2 | MIT | `/ml/ort*` |
  | Silero VAD (voice detection model) | | MIT | `/ml/silero_vad.onnx` |
  | meSpeak, with eSpeak's en-us voice data | 2.0.7 | GPL | `/v2/mespeak*.js`, `/v3/mespeak.js`, `/v2/en-us.json` |

## Read-only

This folder gets replaced each time I take a new copy, so a change made here would be overwritten. Found a bug or want something changed? Open an issue or tell us in the [GrowBot Discord](https://discord.gg/wCnAVaH4zR).

## License

PolyForm Noncommercial 1.0.0, same as the rest of the repo ([LICENSE](../LICENSE)). The licence covers the code. It does not give you rights to the GrowBot name or logo (`assets/brand/`), which are trademarks.
