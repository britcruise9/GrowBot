# Chip software (Pico 2 W)

What runs on the robot's chip. These are the files [growbot.dev/build](https://growbot.dev/build) installs, copied on 2026-10-13.

| file | what it does |
|---|---|
| `relay_chip.py` | The program. Goes on the Pico as `main.py`. Joins Wi-Fi, dials the GrowBot relay, prints a pairing code, plays the moves the app sends, and heals its own link (heartbeat, re-dial, watchdog). |
| `PicoRobotics.py` | The servo driver. Finds a carrier board with a servo chip (Kitronik 5329, generic PCA9685) or drives GP0 and GP1 directly (Waveshare Pico Servo Driver, bare Pico). Kitronik Simply Robotics 5348: set `GPIO_PINS = {1: 15, 3: 13}`. |
| `act_engine.py` | Glides between keyframes at 50 Hz. No MicroPython imports, so it runs on normal Python too. |
| `secrets.example.py` | Template for your Wi-Fi. Copy it to `secrets.py`. |
| `wifi_store.py`, `wifi_recovery.py`, `wifi-recovery.html` | Travel Wi-Fi. The robot remembers up to 8 networks. If it can't join any after a power-on, it opens its own protected setup network (`GrowBot-Setup-xxxxxx`) so your phone can give it a new one. Optional, and only on MicroPython 1.28.0. |
| `hello_legs.py` | Servo check with no Wi-Fi. Copy it as `main.py`: it wiggles each leg, then holds both at 90. |
| `micropython-pico2w.uf2` | MicroPython 1.28.0 for the Pico 2 W. |

## Install

Easiest: step 02 of [growbot.dev/build](https://growbot.dev/build), in Chrome or Edge on a computer. It installs all of this over USB and saves your Wi-Fi.

By hand:

1. Hold BOOTSEL while you plug the Pico in. Drag `micropython-pico2w.uf2` onto the `RP2350` drive.
2. Copy `secrets.example.py` to `secrets.py` and fill in your Wi-Fi. The Pico only joins 2.4 GHz.
3. `pip install mpremote`, then from this folder:
   ```
   mpremote cp PicoRobotics.py :PicoRobotics.py
   mpremote cp act_engine.py :act_engine.py
   mpremote cp secrets.py :secrets.py
   mpremote cp relay_chip.py :main.py
   mpremote reset
   mpremote repl
   ```
4. Note the `PAIRING CODE: gb-xxxxxx` it prints, then pair it ([BUILD.md](../BUILD.md) step 4).

Installed by hand, the robot uses the Wi-Fi in `secrets.py` and has no setup network. The setup network needs a password that the build page's installer creates and hands to your phone, so use the build page if you want travel Wi-Fi.

## Changing it

Motors are touched in two places only: `board.servoWrite(port, deg)` and `board.release(port)`, with port 1 = left and port 3 = right. Swap those for your hardware and the rest stays the same. The wire protocol is at [growbot.dev/body-docs.html](https://growbot.dev/body-docs.html), and [PORTING.md](../PORTING.md) covers other robots.

At power-on the chip runs a short movement check on both outputs. On a wheeled build, keep the wheels off the ground.

The carrier-board part of `PicoRobotics.py` follows Kitronik's Pico Robotics Board MicroPython code. Credit to Kitronik.
