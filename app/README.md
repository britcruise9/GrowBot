# app: browser code from growbot.dev (read-only)

A copy of browser code that growbot.dev serves, taken on 2026-10-13 from commit `17e8689c` of the private GrowBot repo, the build that was live that day. Every file here matches growbot.dev byte for byte. It is here so you can read how the app works and borrow pieces of it. Paths match the site: `app/v3/visual-memory.js` is [growbot.dev/v3/visual-memory.js](https://growbot.dev/v3/visual-memory.js).

Testers' names, session ids, device ids and internal paths were taken out of the comments on the live site itself before this copy was made. No code logic changed.

## Remembered images

The creature can remember what you show it: a person, an object, handwriting, a scene or a place.

- [`v3/visual-memory.js`](v3/visual-memory.js) saves, names, recalls, compares and forgets. Saved views stay on the phone, in the browser's IndexedDB. To check or compare, it sends the saved views and the camera image to the AI model the creature is using.
- [`v3/visual-memory-ui.js`](v3/visual-memory-ui.js) is what you see and hear while it looks.

Both lean on the main app page, [`v3/next.html`](v3/next.html), for the camera, brain and voice. It hands them functions such as `llmCfg`, `saveSoul`, `logEv`, `soulLog`, `soulOwned` and `brainChoice`. Search next.html for `visual-memory` to see how they are loaded and wired in.

## What else is here

- `v3/next.html`: the main app page (the creature, its brain loop, camera, voice and body). growbot.dev opens it for every robot link and for creatures that moved up from the first app.
- `v3/`: the creature's modules: prompts, soul format, expression, the agent kernel, face tracking, imitation, and `body.json` (the stock body).
- `tester/`: [growbot.dev/tester](https://growbot.dev/tester), the page builders use to pair and test a body (calibrate, move, face, custom agent).
- The root files: the relay client (`relay-transport.js`), walk, spin and get-up wiring, the policy runners, `agent-gateway.js` (the safety layer between your own agent and the robot), the analytics beacon and the feedback widget.
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
  | meSpeak, with eSpeak's en-us voice data | 2.0.7 | GPL | `/v2/mespeak*.js`, `/v2/en-us.json` |

## Read-only

This folder gets replaced each time I take a new copy, so a change made here would be overwritten. Found a bug or want something changed? Open an issue or tell us in the [GrowBot Discord](https://discord.gg/wCnAVaH4zR).

## License

PolyForm Noncommercial 1.0.0, same as the rest of the repo ([LICENSE](../LICENSE)). The licence covers the code. It does not give you rights to the GrowBot name or logo (`assets/brand/`), which are trademarks.
