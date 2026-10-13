# Porting: plug the GrowBot brain into YOUR robot

You have a robot, or you are building one, and you want the GrowBot brain to drive it. There are two directions.

## Direction 1: my brain, your body

The phone brain does not know or care what hardware it is driving. It never talks to your board directly either. Both sides meet at a relay I run: **your board dials out** over `wss` and says hello with a code, the app attaches to the same code, and the relay forwards messages between them without looking inside. That means no tunnel, no port forwarding, no LAN addresses, and the phone does not have to be on your network. It also means anything that can hold a websocket can be a body.

The path:

1. **Start from [`firmware/relay_chip.py`](firmware/relay_chip.py).** This is the firmware that ships in kits: MicroPython, dials the relay, plays keyframes, sends a heartbeat, self heals the link. The only hardware calls in the whole file are `board.servoWrite(port, deg)` and `board.release(port)`. Swap those two for whatever your machine speaks and you are done. [`firmware/PicoRobotics.py`](firmware/PicoRobotics.py) shows how thin that layer is, and [`firmware/act_engine.py`](firmware/act_engine.py) is the 50 Hz keyframe glide engine in 147 lines with zero MicroPython imports, so it runs unchanged on CPython.
2. **Or write your own body in any language.** The whole contract is a handful of messages. Connect to `wss://growbot-relay.growbot.workers.dev/d/<code>`, send `{"t":"hello","id":"<code>"}` as your first frame, then:

   | you receive | meaning |
   | --- | --- |
   | `{"t":"pose","lr":"70,110"}` | two absolute values, 0 to 180, latest wins, no reply. About 25 per second on a walk, about 10 in wheels mode |
   | `{"t":"act","rid":7,"steps":[{"l":60,"r":120,"ms":400}],"mode":"replace"}` | a short keyframe plan, reach each pair over its `ms` |
   | `{"t":"routine","rid":8,"name":"wiggle"}` | a named move whose choreography **you** own. The brain never sends this, only the tester's wiggle button does |
   | `{"t":"stop","rid":9}` | drop everything and go safe |

   You reply to act, routine and stop with `{"t":"ack","rid":7,"ok":1,"queued_ms":400}`, sent immediately and before you play the motion. Also put `"caps":["hb"]` in your hello and send `{"t":"hb"}` every 15 s, so the relay notices when your body loses power. That is the whole protocol. Full version, with worked code and the traps: [growbot.dev/body-docs.html](https://growbot.dev/body-docs.html).
3. **Pair it.** Power the board, it prints `PAIRING CODE: gb-xxxxxx` (derived from the chip id, or pin your own). On the phone that rides the robot, open `growbot.dev/v3/next.html?id=<your code>&mode=legs`. For a wheeled body open `growbot.dev/v3/next.html?wheels=1`, then tap brain, Settings, and Pair on the body row. No body URL to paste and no tunnel to run.
4. **Honest note on the pairing code.** The relay has no authentication yet. Whoever has your code can drive your machine, pretend to be it, or read its connection log. Treat it like a password, and do not put it in a screenshot.

### More than two servos, wheels, tracks, DC motors

The brain addresses exactly two channels, `l` and `r`. That is a smaller vocabulary than your machine probably has, and it is less limiting than it sounds, because **the two numbers are intent and your body decides what they mean**:

- **Two legs**: the stock reading, absolute servo angles, 90 is upright.
- **Differential drive** (mower, tank tracks, rover, two motor RC car): use wheels mode (`?wheels=1`, see step 3). The brain drives instead of walking: a steady speed per side, 90 is stop, and 90,90 when it stops. The stock calibration mirrors the left side like the legs, so flip it first (`l = 180 - l`) and forward is both values above 90. Need throttle and yaw? After the flip, `throttle = (l + r) / 2 - 90` and `yaw = (l - r) / 2`.
- **Steering plus throttle** (a normal RC car): same flip and split, yaw becomes steering. A wheels mode turn is a pivot, which a car can't do, so give a turn a minimum throttle.
- **Six servos, a hexapod, an arm**: map the pair to gait amplitude and turn, to an IK target, or to an index into your own pose library. Treat `act` plans as cues for your own choreography rather than as joint angles.
- **Anything that is not a hobby servo**: steppers, ESCs, serial bus servos, a motor driver with PWM and a direction pin. It all lives inside your two functions.

Two warnings that cost real hardware. First, don't map the leg walk onto wheels. It steps back and forth, so a rover twitches in place and never travels. Use wheels mode. Second, on a velocity machine a stale command is not a held limb, it is a runaway. Make the auto-stop brake rather than coast. Wheels mode sends a frame every 100 ms, so about 300 ms is right.

**Real example: a robot lawnmower.** Someone put the GrowBot brain in a Husqvarna Automower 310. Working Pico firmware and the write up are in [`ports/automower/`](ports/automower/), including the traps that do not fail loudly: which H bridges survive an 18 V pack (DRV8833 and TB6612 do not, BTS7960 / IBT-2 does), why `machine.Timer(0)` stops a Pico booting, which Pico pins are wired to the WiFi chip, and why the boot calibration stretch drives a 10 kg machine off its dock. If your robot has wheels, start there.

**Tell the app what you are.** The app reads a body block that says what your robot is. Each GrowBot saves its own copy the first time it wakes, and that copy wins from then on, so change it through the soul file (brain, Settings, soul, save the file, edit its body, load it back). Declare `walk.present: false`, or put `wheel` in the body id or `geometry.drive`, and you get wheels mode for good: the brain is told it has wheels, it stops thinking it tipped over, and fall recovery and face tracking turn off. Always declare `servos[0].band`: it limits gestures and held poses, and in wheels mode it scales drive speed. Today a servos list without a band stops the brain from thinking. Every field: [body-docs](https://growbot.dev/body-docs.html), "Tell the app what you are".

**The walk policies are open too.** [`policy/`](policy/) has the walk the app launched with (runner, weights, and the input and output contract) plus contributed training exports. Study them, run them on your rig, or retrain. They were trained for the 85 mm two leg body, so on a different body expect to retrain rather than to tune. The app ignores `walk.policy` in a body file. Its walks are built in for the stock body, so a different leg layout needs its own gait.

### The old LAN path

Before the relay, a board ran an HTTP server on your home network and the phone reached it through a tunnel. The app no longer speaks it, and an https page can't reach a plain http board on your LAN anyway. That firmware (`robot-server.py`) and its protocol docs are kept at the [v1.0.0 tag](https://github.com/britcruise9/GrowBot/tree/v1.0.0/protocol).

## Direction 2: your brain, my body (or yours)

The reverse mod: skip my hosted brain and run your own LLM. That is what [`agent-harness/`](agent-harness/) is for, a self contained loop (zero dependencies, Node 18+) that works with any OpenRouter model, or fully local through Ollama and friends. It emits validated verbs against a `body_truth.json` describing whatever body you have. Swap the body file, same mind, different robot. To drive a stock GrowBot with your own agent through the app's safety layer, see [growbot.dev/agent-docs.html](https://growbot.dev/agent-docs.html).

If you are building something with more joints than the hosted brain can address, read [`agent-harness/SPEC-BODY-TRUTH.md`](agent-harness/SPEC-BODY-TRUTH.md) even if you never run the harness. It is the general body description: a channel table with per channel travel, neutral, soft band, sign and trim, an index into a wire vector, duty windows, boot limp, and a trust model that says plainly that clamping to limits a file handed you is not a safety control. That spec is where an n channel body belongs. The hosted app does not read it yet, and closing that gap is the most useful thing a port can push on.

There is a third shape, worth naming because people keep discovering it on their own: **own both ends.** The relay forwards any JSON verbatim between the two sockets on a code, so if you write the controller as well as the body, you can invent your own messages, as many channels as you like, with sensors flowing back up. You lose the creature and its brain and keep a connection that works from anywhere with no account and no port forwarding.

## Show me

Ports are the contributions I most want. When your robot moves, open a PR with your firmware and a clip per [CONTRIBUTING.md](CONTRIBUTING.md), or just post it in the [GrowBot Discord](https://discord.gg/wCnAVaH4zR). The first port of each board becomes the reference for everyone after you. Tell me what your machine needs that the two channel contract cannot express, because that is what decides what gets built next.
