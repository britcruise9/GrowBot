# GrowBot

GrowBot is an AI creature that lives in your phone and grows up from its own experiences.
Put the phone on a small robot body (a Pico, two servos, AA batteries) and it can sense, move and remember the world around it.

Try it at [growbot.dev](https://growbot.dev) · [Launch video](https://www.youtube.com/watch?v=mIfmUHiMN3U)

## What's in this repo

| folder | what it is |
|---|---|
| **[app/](app/)** | A read-only copy of browser code growbot.dev serves, including remembered images ([visual-memory.js](app/v3/visual-memory.js)). For reading and borrowing. It needs the GrowBot server, which is not in this repo. |
| **[firmware/](firmware/)** | The chip software for the Pico 2 W. The same files the build guide installs. |
| **[policy/](policy/)** | Walk policies and a forward model: runners, weights, training exports. |
| **[ports/](ports/)** | GrowBot on other machines. First up: a robot lawnmower. |
| **[hardware/](hardware/)** | Body STLs to print, and a paper cutout template if you have no printer. |
| **[agent-harness/](agent-harness/)** | Run your own model as the mind, from a terminal, no account. |

The docs: [BUILD.md](BUILD.md) builds the body, [BOM.md](BOM.md) lists the parts, [PORTING.md](PORTING.md) puts the brain in your own robot, [CONTRIBUTING.md](CONTRIBUTING.md) says how to send changes.

## Build and run

1. Build the body with the guide at [growbot.dev/build](https://growbot.dev/build). It has photos and a USB installer that sets up the chip. About 30 minutes, no soldering.
2. Open [growbot.dev](https://growbot.dev) on the phone that rides the robot. The last step of the build guide pairs the two.

Building your own robot, with wheels, more motors or another board? Read [growbot.dev/body-docs.html](https://growbot.dev/body-docs.html). Want your own AI to drive a GrowBot? Read [growbot.dev/agent-docs.html](https://growbot.dev/agent-docs.html).

The hosted brain is a free preview running on AI models that cost me money. You can buy credits in the app, bring your own OpenRouter key, or [run a model on your own computer](https://growbot.dev/local-brain.html).

## Why open

Top down home robots are the scary version: corporate machines nobody outside can inspect. Bottom up is safer: millions of small robots you fully control. Open it, read it, retrain it, use any model you want.

## Get help

Ask in the [GrowBot Discord](https://discord.gg/wCnAVaH4zR). Built something? Post a clip there, or open a PR ([CONTRIBUTING.md](CONTRIBUTING.md)). Email: info@growbot.dev

## Background

V0 learned to walk from scratch on a Pi, wired sensor by sensor over a year. It is preserved at the [v0 tag](https://github.com/britcruise9/GrowBot/releases/tag/v0). V1 moved the brain to the phone: more powerful, way cheaper.

## License

- **Code**, including app/ and firmware/: [PolyForm Noncommercial 1.0.0](LICENSE). Use it, change it, share it, just not commercially. Commercial licence: info@growbot.dev
- **Hardware and docs**: [CC BY-NC 4.0](hardware/LICENSE.md), credit Art of the Problem.

Made by [Art of the Problem](https://www.youtube.com/@ArtOfTheProblem).
