# app: browser code from growbot.dev (read-only)

A copy of browser code that growbot.dev serves, taken on 2026-10-13 from commit `6fa89d9a` of the private GrowBot repo, the build that was live that day. It is here so you can read how the app works and borrow pieces of it. Paths match the site: `app/v3/visual-memory.js` is [growbot.dev/v3/visual-memory.js](https://growbot.dev/v3/visual-memory.js).

Before copying I edited a few comments to take out testers' names, session ids, a device id and internal file paths, and changed one example pairing code to `gb-xxxxxx`. No code logic was changed.

## Remembered images

The creature can remember what you show it: a person, an object, handwriting, a scene or a place.

- [`v3/visual-memory.js`](v3/visual-memory.js) saves, names, recalls, compares and forgets. Saved views stay on the phone, in the browser's IndexedDB. To check or compare, it sends the saved views and the camera image to the AI model the creature is using.
- [`v3/visual-memory-ui.js`](v3/visual-memory-ui.js) is what you see and hear while it looks.

Both lean on the main app page, `v3/next.html`, for the camera, brain and voice. It hands them functions such as `llmCfg`, `saveSoul`, `logEv`, `soulLog`, `soulOwned` and `brainChoice`. That page is not in this copy (see below), so lift the parts you need rather than expecting the files to run on their own.

## What else is here

- `v3/`: the creature's modules: prompts, soul format, expression, the agent kernel, face tracking, imitation, and `body.json` (the stock body).
- `tester/`: [growbot.dev/tester](https://growbot.dev/tester), the page builders use to pair and test a body (calibrate, move, face, custom agent).
- The root files: the relay client (`relay-transport.js`), walk, spin and get-up wiring, the policy runners, `agent-gateway.js` (the safety layer between your own agent and the robot), the analytics beacon and the feedback widget.
- `policy_85mm.json`: the walk the app launched with, the same file as [`policy/policy_85mm.json`](../policy/policy_85mm.json).

## What is not here

- **The server.** Everything under growbot.dev/api (brain, journal, feedback, credits) is not in this repo. These files call growbot.dev's APIs, so they will not run on their own as-is.
- **The main app page**, `v3/next.html`, and the tester's LLM tab, `tester/llm.html`. Both are held back from this copy for now. You can still open them at growbot.dev.
- **Most trained weights.** The current walks and spins the app loads (`policies/`, `policy_drrma.json`, `optional-gyro-bench/specialist.json`) are not in this copy yet, so the files that fetch them get a 404 here.
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
