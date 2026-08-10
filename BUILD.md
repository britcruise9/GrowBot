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

## 4. Give it a brain

- **Hosted brain**: go to [growbot.dev/start](https://growbot.dev/start) on the mounted phone.
- **Your own brain**: see [`agent-harness/`](agent-harness/), a self-contained loop you run with your own LLM key.

---

*Want to port GrowBot to another board (ESP32, Pi, anything)? See [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md) and prove your port with `protocol/conformance.html`. Ports are the PRs I most want to see.*
