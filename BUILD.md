# Build the body (about 30 minutes, no soldering)

The full guide, with photos, a USB installer and a checklist, is at [growbot.dev/build](https://growbot.dev/build). Use that if you can. This page is the same build in short, for doing it by hand. Parts are in [BOM.md](BOM.md).

Using an ESP32 instead of a Pico? Follow [growbot.dev/build-esp32](https://growbot.dev/build-esp32). The steps below are for the Pico 2 W.

## 1. Wire the servos

**On the Waveshare Pico Servo Driver** (the board in the kit):

- Push the Pico into the board, USB ends matching.
- Left servo into socket 0, right servo into socket 1. Match the wires to the labels: brown to G, red to V, yellow or orange to S.
- Battery holder red to + (VIN) and black to GND, in the board's screw terminal. Never on the Pico's own pins.

The Kitronik Robotics Board 5329 works too, with different sockets. See "want to use another board?" on [growbot.dev/build](https://growbot.dev/build).

The servos run off the battery pack. USB alone won't move them.

## 2. Put the chip software on

Easiest: step 02 of [growbot.dev/build](https://growbot.dev/build), in Chrome or Edge on a computer. It installs everything over USB and saves your Wi-Fi.

By hand, with the files in [`firmware/`](firmware/):

1. Hold **BOOTSEL** while you plug the Pico into USB. A drive called `RP2350` appears. Drag `micropython-pico2w.uf2` onto it.
2. Copy `secrets.example.py` to `secrets.py` and fill in your Wi-Fi name and password. The Pico only joins 2.4 GHz Wi-Fi.
3. Install mpremote (`pip install mpremote`), then from the `firmware/` folder:
   ```
   mpremote cp PicoRobotics.py :PicoRobotics.py
   mpremote cp act_engine.py :act_engine.py
   mpremote cp secrets.py :secrets.py
   mpremote cp relay_chip.py :main.py
   mpremote reset
   mpremote repl
   ```
4. Write down the `PAIRING CODE: gb-xxxxxx` it prints. You need it in step 4.

No terminal? In [Thonny](https://thonny.org), open each file and use File > Save As > Raspberry Pi Pico, saving `relay_chip.py` as `main.py`.

## 3. Mount it and run the movement check

1. Print the body from [`hardware/print/`](hardware/print/) (plain PLA, no supports). No printer? Use the [cutout template](hardware/cutout-template.html) at 100% on paper and build from any stiff material.
2. Servo board at one end, battery holder at the other, both on foam tape. Fit the servos with their shafts pointing out, held with screws or hot glue.
3. Unplug USB, put in 4 AA batteries and switch on. The movement check runs by itself: both servos centre, the right one sweeps, then the left, then both, and they park at 90.
4. While they are parked, drop each servo horn into its leg's slot, then screw it onto the servo shaft so the leg sits straight out from the body.
5. Switch off and on again. Right leg first, then left? Done. Wrong leg first? Switch off and swap the two servo plugs.

**Legs turn but never stop?** You almost certainly have 360° continuous-rotation servos instead of
standard 180° ones. They sell under nearly identical names. A standard servo swings to a position and
holds it; a continuous one reads the same signal as a speed and can never hold still. Check the
listing before you blame your wiring.

## Which leg is which, and which way is forward

Worth reading even if you are building your own body, because the app assumes all of this.

- **Forward is the way the screen faces.** Left and right are from the creature's point of view, not
  yours, so when you are looking at the screen its left leg is on your right.
- **The two legs are mirror images of each other**, because the servos sit at opposite ends with
  their shafts pointing outward. The consequence catches everybody: **the same number sent to both
  legs swings them in opposite directions.** That is a scissor or a twist, not a move together.
- **To move both legs the same way, the two numbers must add up to 180.** `{l:90, r:90}` is neutral
  and upright. `{l:50, r:130}` sweeps both legs down and levers the body up to stand tall.
  `{l:130, r:50}` sweeps both up and folds it forward. Those two are bench-calibrated.
- **Use that to settle left and right without measuring anything.** Send `{l:50, r:130}`. If the body
  pushes **up**, your left and right are correct. If it folds forward instead, swap them.

Building a custom body? On the standard build the mirroring comes from how the servos are physically
mounted. If yours are mounted the same way round, or you are using serial servos that take direction
in software, invert one of them in your firmware so the rule above still holds.

## 4. Give it a brain

1. Mount the phone with foam tape or an elastic band: screen facing out, camera at the top, away from the batteries.
2. On that phone, open `growbot.dev/v3/next.html?id=<your code>&mode=legs` and bookmark it. Step 09 of [growbot.dev/build](https://growbot.dev/build) gives you a QR code that does this and brings your leg trim along.
3. Legs look uneven? Straighten them with step 07 (trim) of the build guide.

Want your own model or your own code as the brain? See [`agent-harness/`](agent-harness/) and [growbot.dev/agent-docs.html](https://growbot.dev/agent-docs.html).

---

*Building a different robot (wheels, more motors, another board)? Start with [PORTING.md](PORTING.md) and [growbot.dev/body-docs.html](https://growbot.dev/body-docs.html). Ports are the PRs I most want to see.*
