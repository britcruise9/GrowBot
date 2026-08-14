# GrowBot V1 Bill of Materials

The direct-wire build from the video: phone brain, Pico, two servo legs. About **$30 all-in**, no soldering.

Looking for the original V0 build (Pi Zero, from-scratch learning)? It is preserved at the [v0 tag](https://github.com/britcruise9/GrowBot/tree/v0).

## Parts

| # | Part | Spec | Qty | ~USD | Where / notes |
|---|------|------|----:|----:|----------------|
| 1 | Raspberry Pi Pico 2 W | RP2350, WiFi | 1 | $7 | official resellers, Adafruit, AliExpress. The W matters, it is the WiFi that talks to your phone. Pico hard to get or pricey where you are? An ESP32 works too, see below |
| 2 | MG90S micro servo | metal gear, 9 g, **standard 180°** | 2 | $8 / pair | AliExpress, Amazon. SG90s work too but are weaker (plastic gears). ⚠️ **Standard 180° only. NOT 360° / continuous rotation**, which sell under nearly identical names and titles. A continuous servo reads an angle as a *speed*, so it can never hold a position: the giveaway is legs that start moving on power-up and never stop |
| 3 | Mini breadboard + dupont jumpers | | 1 set | $5 | the direct-wire way. Or a Pico carrier board (~$13) if you want screw terminals |
| 4 | 4× AA lithium batteries | 1.5 V single-use (Energizer Ultimate type) | 4 | $15 | ⚠️ exactly these for strong legs. NOT USB-rechargeable 1.5 V AAs (they cut out under load) and NEVER 3.7 V 14500 cells (they will destroy the board). Plain alkaline AAs are fine to start, just heavier and weaker |
| 5 | 4×AA holder with switch | | 1 | $3 | the switch is your power button |
| 6 | Two-sided foam tape | | 1 roll | $5 | holds the phone and battery on. That is the whole fastening system |
| | | | | **~$30 to $43** | depending on what you already have |

## Parts hard to find where you live?

Availability varies a lot by country, so there are alternates for the two common problems:

- **No Pico, or Pico costs more than an ESP32.** Use an ESP32: [growbot.dev/build-esp32](https://growbot.dev/build-esp32) is the ESP32 build guide, and [PORTING.md](PORTING.md) covers any other Wi-Fi board.
- **No carrier board (Kitronik and Waveshare sell out or do not ship everywhere).** You do not need one, the breadboard direct-wire path above is the default. A generic PCA9685 servo board plus a buck converter for clean 5 V to the Pico also works, a community builder runs exactly that setup.

## Also needed (not electronics)

- **A phone.** Most phones from the last 6 or 7 years work. Check yours at [growbot.dev/build](https://growbot.dev/build).
- **3D printed body.** STLs in [`hardware/print/`](hardware/print/), plain PLA, no supports, legs screw onto the servo horns, no glue. No printer? Use the [cutout template](hardware/cutout-template.html), print it on paper at 100% and build from any stiff material.

## Power notes

The servos need 5 to 6 V and can spike over 2 A when they push hard. A weak supply browns out the Pico (legs twitch, then it resets). That is why the battery row above is picky. The 4× lithium AA pack stays strong even when a leg gets grabbed or the pack runs low.

## Wiring summary

Full steps in [BUILD.md](BUILD.md). The short version: servo signals to GP0 and GP1, both servo reds to battery +, and one common ground shared by battery −, Pico GND, and both servo browns.
