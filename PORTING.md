# Porting: plug the GrowBot brain into YOUR robot

You have a robot, or you are building one, and you want the GrowBot brain to drive it. There are two directions.

## Direction 1: my brain, your body

The phone brain does not know or care what hardware it is driving. It never talks to your board directly either. Both sides meet at a relay I run: **your board dials out** over `wss` and says hello with a code, the app attaches to the same code, and the relay forwards messages between them without looking inside. That means no tunnel, no port forwarding, no LAN addresses, and the phone does not have to be on your network. It also means anything that can hold a websocket can be a body.

The path:

1. **Start from [`firmware/relay_chip.py`](firmware/relay_chip.py).** This is the firmware that ships in kits: MicroPython, dials the relay, plays keyframes, self heals the link. The only hardware calls in the whole file are `board.servoWrite(port, deg)` and `board.release(port)`. Swap those two for whatever your machine speaks and you are done. If your board is not a Pico, [`firmware/PicoRobotics_gpio.py`](firmware/PicoRobotics_gpio.py) shows how thin that layer is, and [`firmware/act_engine.py`](firmware/act_engine.py) is the 50 Hz keyframe glide engine in 147 lines with zero MicroPython imports, so it runs unchanged on CPython.
2. **Or write your own body in any language.** The whole contract is six messages. Connect to `wss://growbot-relay.growbot.workers.dev/d/<code>`, send `{"t":"hello","id":"<code>"}` as your first frame, then:

   | you receive | meaning |
   | --- | --- |
   | `{"t":"pose","lr":"70,110"}` | two absolute values, 0 to 180, about 30 per second, latest wins, no reply |
   | `{"t":"act","rid":7,"steps":[{"l":60,"r":120,"ms":400}],"mode":"replace"}` | a short keyframe plan, reach each pair over its `ms` |
   | `{"t":"routine","rid":8,"name":"wiggle"}` | a named move whose choreography **you** own |
   | `{"t":"stop","rid":9}` | drop everything and go safe |

   You reply to act, routine and stop with `{"t":"ack","rid":7,"ok":1,"queued_ms":400}`, sent immediately and before you play the motion. That is the entire protocol. Full version, with worked code and the traps: [growbot.dev/body-docs.html](https://growbot.dev/body-docs.html).
3. **Pair it.** Power the board, it prints `PAIRING CODE: gb-xxxxxx` (derived from the chip id, or pin your own). Open [growbot.dev/start](https://growbot.dev/start) on the phone, choose Wake Robot, type that code. There is no body URL to paste any more and no tunnel to run.
4. **Honest note on the pairing code.** The relay has no authentication yet. Whoever has your code can drive your machine or pretend to be it. Treat it like a password, and do not put it in a screenshot.

### More than two servos, wheels, tracks, DC motors

The brain addresses exactly two channels, `l` and `r`. That is a smaller vocabulary than your machine probably has, and it is less limiting than it sounds, because **the two numbers are intent and your body decides what they mean**:

- **Two legs**: the stock reading, absolute servo angles, 90 is upright.
- **Differential drive** (mower, tank tracks, rover, two motor RC car): velocities per side, 90 is stop. Split each pose into `throttle = (l + r) / 2 - 90` and `yaw = (l - r) / 2`. That split is an exact identity for teleop, nothing is lost.
- **Steering plus throttle** (a normal RC car): same split, yaw becomes steering angle.
- **Six servos, a hexapod, an arm**: map the pair to gait amplitude and turn, to an IK target, or to an index into your own pose library. Treat `act` plans as cues for your own choreography rather than as joint angles.
- **Anything that is not a hobby servo**: steppers, ESCs, serial bus servos, a motor driver with PWM and a direction pin. It all lives inside your two functions.

Two warnings that cost real hardware. First, the walk policy emits **mirrored** angles (`l = 90 - x`, `r = 90 + x`), which two legs read as a gait and two wheels read as counter rotation, so a wheeled build shudders in place until you do the throttle and yaw split above. Second, on a velocity machine a stale command is not a held limb, it is a runaway, so make the dead man brake rather than coast and keep it tight, 200 to 300 ms per side.

**Real example: a robot lawnmower.** Someone put the GrowBot brain in a Husqvarna Automower 310. Working Pico firmware and the write up are in [`ports/automower/`](ports/automower/), including the traps that do not fail loudly: which H bridges survive an 18 V pack (DRV8833 and TB6612 do not, BTS7960 / IBT-2 does), why `machine.Timer(0)` stops a Pico booting, which Pico pins are wired to the WiFi chip, and why the boot calibration stretch drives a 10 kg machine off its dock. If your robot has wheels, start there.

**Tell the app what you are.** The app carries a body description, and a wheeled or non walking body should declare itself (`walk.present: false`, or a `wheel` in the body id or `geometry.drive`). It is not cosmetic: the creature is told the wheeled truth instead of narrating legs it does not have, the fallen posture verdict goes away, the idle breath is disabled because a small periodic wiggle on a velocity wire is a slow crawl, and the clamp band defaults to something a drivetrain can survive.

**The walk policy is open too.** The trained net the app walks with is in [`policy/`](policy/), runner plus weights, with the input and output contract documented. Study it, run it on your rig, or retrain and swap the weights. It was trained for 85 mm legs, so on a different body expect to retrain rather than to tune.

### The older LAN path, still in this repo

Before the relay, a board ran an HTTP server on your home network and the phone reached it through a `cloudflared` tunnel. That is what [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md), [`protocol/conformance.html`](protocol/conformance.html) and [`firmware/robot-server.py`](firmware/robot-server.py) describe. It still works if you want a body you can drive from your own LAN with no cloud in the loop, and the motion model in that document (absolute degrees, keyframes glided locally, the dead man, the safety rules) is still exactly right.

**What is no longer true there:** the app does not speak it. A board can pass `conformance.html` completely and still be unable to connect to a phone, and the `/servo` endpoint it documents for extra channels exists only on that firmware, not on the relay path. Port to the relay contract above unless you specifically want the offline setup.

## Direction 2: your brain, my body (or yours)

The reverse mod: skip my hosted brain and run your own LLM. That is what [`agent-harness/`](agent-harness/) is for, a self contained loop (zero dependencies, Node 18+) that works with any OpenRouter model, or fully local through Ollama and friends. It emits validated verbs against a `body_truth.json` describing whatever body you have. Swap the body file, same mind, different robot.

If you are building something with more joints than the hosted brain can address, read [`agent-harness/SPEC-BODY-TRUTH.md`](agent-harness/SPEC-BODY-TRUTH.md) even if you never run the harness. It is the general body description: a channel table with per channel travel, neutral, soft band, sign and trim, an index into a wire vector, duty windows, boot limp, and a trust model that says plainly that clamping to limits a file handed you is not a safety control. That spec is where an n channel body belongs. The hosted app does not read it yet, and closing that gap is the most useful thing a port can push on.

There is a third shape, worth naming because people keep discovering it on their own: **own both ends.** The relay forwards any JSON verbatim between the two sockets on a code, so if you write the controller as well as the body, you can invent your own messages, as many channels as you like, with sensors flowing back up. You lose the creature and its brain and keep a connection that works from anywhere with no account and no port forwarding.

## Show me

Ports are the contributions I most want. When your robot moves, open a PR with your firmware and a clip per [CONTRIBUTING.md](CONTRIBUTING.md), or just post it in Discord. The first port of each board becomes the reference for everyone after you. Tell me what your machine needs that the two channel contract cannot express, because that is what decides what gets built next.
