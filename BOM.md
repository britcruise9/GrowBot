# GrowBot Bill of Materials

The parts for the standard build: a Pico, two servo legs, AA batteries and a phone for a brain. No soldering. Have a GrowBot kit? You already have all of this, so go straight to [growbot.dev/build](https://growbot.dev/build).

The build guide links the exact parts we tested. Prices vary a lot by country, so they are not listed here.

Looking for the original V0 build (Pi Zero, from-scratch learning)? It is preserved at the [v0 tag](https://github.com/britcruise9/GrowBot/tree/v0).

## Parts

| # | Part | Spec | Qty | Notes |
|---|------|------|----:|-------|
| 1 | Raspberry Pi Pico 2 W | RP2350, Wi-Fi, **headers already soldered** | 1 | The W matters: Wi-Fi is how it reaches your phone. Hard to get or pricey where you are? An ESP32 works too, see below |
| 2 | MG90S micro servo | metal gear, 9 g, **standard 180°** | 2 | **Standard 180° only, NOT 360° / continuous rotation**, which sell under nearly identical names. A continuous servo reads an angle as a speed, so it can never hold a position: the giveaway is legs that start moving on power-up and never stop. SG90s are not tested in this body |
| 3 | Waveshare Pico Servo Driver | Pico carrier with servo sockets, screw terminal and power switch | 1 | What the kit uses. The Kitronik Robotics Board 5329 also works |
| 4 | AA batteries | 1.5 V, rechargeable lithium recommended | 4 | Fresh alkalines work but do not last as long. Use four of the same kind, fresh or fully charged. **Never 3.7 V 14500 cells**: they look like AAs and will destroy the board |
| 5 | 4×AA battery holder | low profile, no cover, bare wire ends | 1 | Covered holders don't fit the body |
| 6 | Double-sided foam tape | | 1 roll | Holds the board, the battery holder and the phone on |

Tools: a small Phillips screwdriver for the servo screws, and a tiny flat-head for the battery terminal.

## Parts hard to find where you live?

- **No Pico, or Pico costs more than an ESP32.** Use an ESP32: [growbot.dev/build-esp32](https://growbot.dev/build-esp32) is the ESP32 build guide, and [PORTING.md](PORTING.md) covers any other Wi-Fi board.

## Also needed

- **A phone.** Most phones from the last 6 or 7 years work. Check yours at [growbot.dev/check](https://growbot.dev/check).
- **3D printed body.** STLs in [`hardware/print/`](hardware/print/), plain PLA, no supports. No printer? Use the [cutout template](hardware/cutout-template.html), or order the body printed from the link on [growbot.dev/build](https://growbot.dev/build).

## Power notes

The servos need 5 to 6 V and can spike over 2 A when they push hard. A weak supply browns out the Pico: the legs twitch, then it resets. One tired battery causes most of these problems, so use four fresh or fully charged cells, all the same kind.

## Wiring summary

Full steps in [BUILD.md](BUILD.md). Waveshare: left servo in socket 0, right in socket 1, battery into the screw terminal.
