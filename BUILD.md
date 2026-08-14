# Build the body (~30 min, no soldering, no code)

Give the creature a body: two servo legs, a Pico, a phone for a brain. Parts in [BOM.md](BOM.md). Prefer pictures and a checklist that talks back? The same guide is hosted at [growbot.dev/build](https://growbot.dev/build).

Using an ESP32 instead of a Pico? Follow [growbot.dev/build-esp32](https://growbot.dev/build-esp32), the steps below are Pico specific.

## 1. Wire the 2 servos to the Pico

Each servo has 3 wires: signal (orange) · power (red) · ground (brown).

| servo | signal → | red → | brown → |
|---|---|---|---|
| **left**  | **GP0** (pin 1) | battery + | common ground |
| **right** | **GP1** (pin 2) | battery + | common ground |

Both reds go to battery **+**. Then tie ALL the grounds together: battery **−**, a Pico **GND** pin, and both servo browns. One shared ground rail. That is the whole wiring.

> Powering from USB while testing on a desk is fine for gentle moves, but real walking needs the battery pack. The servos spike harder than USB can supply.

## 2. Put the firmware on the Pico

1. Hold the **BOOTSEL** button, plug the Pico into USB, a drive pops up.
2. Drag `firmware/micropython-pico2w.uf2` onto that drive. It reboots.
3. Copy 3 files from `firmware/` onto it. In a terminal:
   ```
   mpremote cp PicoRobotics_gpio.py :PicoRobotics.py
   mpremote cp act_engine.py        :act_engine.py
   mpremote cp robot-server.py      :main.py
   mpremote reset
   ```
   *(No terminal? Install the free **Thonny** app and copy those 3 files onto the Pico, same result.)*

   *(Using a Pico carrier board instead of direct-wire? Copy `PicoRobotics.py` instead of the `_gpio` variant.)*

## 3. Mount + wiggle test

1. Print the body: STLs in [`hardware/print/`](hardware/print/) (plain PLA, no supports). Or no printer: [cutout template](hardware/cutout-template.html) at 100% on paper, build from any stiff material.
2. One servo at each end, shafts facing **out**. Battery and Pico in the middle. Legs screw onto the servo horns. Phone mounts with foam tape.
3. Power on. On your phone, join the wifi network named **`GrowBot-Setup`**, open **`http://192.168.4.1`**, pick your home wifi.
4. It reboots onto your wifi. Open **`http://<pico-ip>/`** (the IP prints on the USB boot screen, or find it in your router) and tap **wiggle**.

**Legs sweep = done.** Send a clip!

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

- **Hosted brain**: go to [growbot.dev/start](https://growbot.dev/start) on the mounted phone.
- **Your own brain**: see [`agent-harness/`](agent-harness/), a self-contained loop you run with your own LLM key.

---

*Want to port GrowBot to another board (ESP32, Pi, anything)? See [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md) and prove your port with `protocol/conformance.html`. Ports are the PRs I most want to see.*
