# Porting: plug the GrowBot brain into YOUR robot

You have a robot, or you are building one, and you want the GrowBot brain to drive it. There are two directions.

## Direction 1: my brain, your body

The phone brain does not know or care what hardware it is driving. It only speaks the protocol in [protocol/PROTOCOL.md](protocol/PROTOCOL.md): a few plain HTTP endpoints plus one WebSocket, served by your board over Wi-Fi. Any board that answers those messages IS a GrowBot body.

The path:

1. **Read [protocol/PROTOCOL.md](protocol/PROTOCOL.md).** Especially the "real vs aspirational" section at the top, it tells you what the code actually does today so you do not build against a someday design. The short version: your board serves `/act` (keyframe plans it glides between locally) and `/ws` (a ~30 Hz pose stream for walking), plus `/stop`, `/pose`, and friends.
2. **Start from the reference firmware** in [firmware/](firmware/) if your board runs MicroPython. `robot-server.py` is the whole server, `act_engine.py` is the 50 Hz glide engine, `PicoRobotics_gpio.py` drives servos straight off GPIO pins. On a different chip, port those three ideas in whatever language fits, the protocol section 5 has per-board notes (ESP32, carrier boards, Pi, and a warning about serial-bus servos).
3. **Prove it with [protocol/conformance.html](protocol/conformance.html).** Open it from disk, point it at your board's URL, and it runs every protocol message and shows PASS or FAIL. All green on the "Minimum viable body" block means the brain will drive your robot.
4. **Connect the brain.** In the app at [growbot.dev/start](https://growbot.dev/start) you can point it at your body's URL directly. One catch: the app is an HTTPS page, so it cannot fetch a plain `http://` LAN address. Either run a tunnel (`cloudflared` gives you a free HTTPS URL to your board) or ask in the Discord. This is the roughest edge of the path right now and I know it.

More than 2 servos, different limbs, a gripper? The protocol's `/servo` endpoint gives you direct per-channel writes, and the keyframe schema does not care what the joints mean. Start with the two-channel contract, get green conformance, then extend.

**Real example: a robot lawnmower.** Someone already put the GrowBot brain in a Husqvarna Automower. The write-up and working Pico firmware for big wheeled bases is in [ports/automower/](ports/automower/), including the traps (which motor drivers survive an 18 V pack, which Pico pins kill the WiFi, why the boot stretch lurches on wheels). If your robot has wheels instead of legs, start there.

**The walk policy is open too.** The actual trained net the app walks with is in [policy/](policy/), runner plus weights, with the input/output contract documented. Study it, run it on your rig, or retrain your own and swap the weights file.

## Direction 2: your brain, my body (or yours)

The reverse mod: skip my hosted brain and run your own LLM. That is what [agent-harness/](agent-harness/) is for, a self-contained loop (zero dependencies, Node 18+) that works with any OpenRouter model, or fully local via Ollama and friends. It emits validated verbs against a `body_truth.json` file that describes whatever body you have. Swap the body file, same mind, different robot.

## Show me

Ports are the contributions I most want. When your robot moves, open a PR with your firmware and conformance screenshot per [CONTRIBUTING.md](CONTRIBUTING.md), or just post the clip in Discord. The first port of each board becomes the reference for everyone after you.
