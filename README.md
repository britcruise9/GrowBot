# GrowBot

An experimental project to build the cheapest possible state of the art AI robot platform. The idea: an AI robot that grows up differently based on its own experiences of the world.

The brain is any smartphone. The body is a Pico, two servos, and a battery. About $30, 30 minutes, no soldering. It senses through the phone, stores its experiences in a soul file, and dreams to self improve.

[Launch video](https://www.youtube.com/watch?v=mIfmUHiMN3U) · [Wake one up](https://growbot.dev/start)

## Why open

Top down home robots are the scary version: corporate machines nobody outside can inspect. Bottom up is safer: millions of small robots you fully control. Open it, read it, retrain it, use any model you want.

## In this repo

| | |
|---|---|
| **[BUILD.md](BUILD.md)** | The build: 2 servos + Pico + phone |
| **[BOM.md](BOM.md)** | Parts list with sourcing links |
| **[hardware/](hardware/)** | Body STLs, plus a paper cutout template if you have no printer |
| **[firmware/](firmware/)** | Pico firmware, drag and drop |
| **[protocol/](protocol/)** | The open body protocol + conformance test |
| **[agent-harness/](agent-harness/)** | Run your own LLM on your robot, no account |
| **[PORTING.md](PORTING.md)** | Plug the GrowBot brain into your own robot |
| **[policy/](policy/)** | The trained walk policy: runner, weights, contract |
| **[ports/](ports/)** | Community ports. First up: a robot lawnmower |
| **[apps/native/](apps/native/)** | Native iOS/Android creature MVP: Habitat, Story, Workshop |
| **[packages/creature-core/](packages/creature-core/)** | Pure creature state machine and effect contract |

Build guide with pictures: [growbot.dev/build](https://growbot.dev/build)

## Two ways in

- **Free.** Build the body, run [agent-harness/](agent-harness/) on your own key or a local model.
- **Adopt him, $20.** The hosted brain at [growbot.dev/start](https://growbot.dev/start). No keys, no setup.

The hosted creature costs me real money to run. That is what the $20 covers.

## Ports

The protocol is open on purpose: any board that speaks it is a GrowBot body. Port it, prove it with the conformance test, open a PR. Small PRs please: [CONTRIBUTING.md](CONTRIBUTING.md).

## Background

V0 learned to walk from scratch on a Pi, wired sensor by sensor over a year. Preserved at the [v0 tag](https://github.com/britcruise9/GrowBot/releases/tag/v0). V1 moves the brain to the phone: more powerful, way cheaper.

## License

- **Code**: [PolyForm Noncommercial 1.0.0](LICENSE). Use, change, share, noncommercial. Commercial: info@growbot.dev
- **Hardware and docs**: [CC BY-NC 4.0](hardware/LICENSE.md), credit Art of the Problem.

Made by [Art of the Problem](https://www.youtube.com/@ArtOfTheProblem).
