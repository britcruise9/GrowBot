# GrowBot on a robot mower (Pico 2 W)

For D4egon's Husqvarna Automower 310 conversion, and anyone else putting GrowBot
on a big wheeled base.

You already have the hard part done: a Pico 2 W driving a wheel motor forward and
back, off the mower's own battery, charging on the dock. This kit is the software
layer that turns that into an actual GrowBot, plus the things that will bite you
on a machine this size.

## Why not just use the ESP32 wheels kit

The existing wheels kit is written for an ESP32. Three things in it are fatal on
a Pico 2 W, and none of them fail in a way that tells you what is wrong:

| Problem | What happens on a Pico |
| --- | --- |
| `machine.Timer(0)` | The rp2 port has **soft timers only**, the id must be `-1`. `Timer(0)` raises `ValueError`, the driver never constructs, the firmware never boots. Dead board, no clue. |
| Pins `32` / `33` | Do not exist. A Pico has GP0 to GP29. |
| Pin `25` | On a Pico W / Pico 2 W, GP23/24/25/29 are wired to the CYW43 WiFi chip. Driving GP25 kills WiFi. |

The `PicoRobotics.py` in this folder is the Pico port with those fixed, plus the
mower-specific changes below.

## The two things that matter most on a mower

**1. Your H-bridge must survive 18 V.** The Automower 310 runs an 18 V Li-ion
pack. The drivers the ESP32 kit suggests do not survive that:

| Driver | Max motor supply | On an 18 V mower |
| --- | --- | --- |
| DRV8833 | **10.8 V** | No. Smoke. |
| TB6612FNG | **13.5 V** operating (15 V absolute max) | No. Smoke. |
| L298N | 46 V | Works, but lossy and only ~2 A |
| **BTS7960 / IBT-2** | **5.5 to 27.5 V** | **Yes. Recommended.** |

BTS7960 / IBT-2 is the one to get. It is cheap, it is a pair of half bridges
driven by two PWM pins (RPWM / LPWM), which is exactly the sign-magnitude scheme
this driver speaks. Tie `R_EN` and `L_EN` high to 3V3 so the board is enabled.

One honest note on the spec: the "43 A" in every IBT-2 listing is the BTS7960's
internal current-limit threshold, not a continuous rating. On the bare module with
no extra heatsinking, plan for something like 10 to 15 A continuous. That is still
far more headroom than a mower drivetrain needs. Avoid the DRV8871 here: the
voltage is fine at 45 V but its internal limit is about 3.6 A peak, which is likely
undersized for wheel motors under load in wet grass.

**2. The stock firmware lurches on every boot.** GrowBot's firmware runs a few seconds of
"boot calibration" movement check on cold boot, so you can fit legs on straight.
Look at what that actually is on wheels (`relay_chip.py`, `boot_calibration`):
the right wheel runs one way then the other, twice, then the left wheel does the
same, then both together, twice, all before it has even joined WiFi. On a 10 kg
machine that drives it off the dock. This driver holds the brake through that
window (`BOOT_LOCKOUT_MS`, default 15 s) and swallows it.

## Wiring

```
  18 V mower pack ──┬─ BTS7960 (or 2x) motor supply  B+/B-
                    │
                    └─ buck converter ──► Pico 2 W VSYS (5 V) or 3V3
                                          (you already have this working)

  Pico GP2 ──► LEFT  RPWM        Pico GP4 ──► RIGHT RPWM
  Pico GP3 ──► LEFT  LPWM        Pico GP5 ──► RIGHT LPWM
  Pico 3V3 ──► R_EN + L_EN (both boards)
  Pico GND ──► BTS7960 GND  ── COMMON GROUND WITH THE PACK. Not optional.
```

Add a bulk capacitor (470 uF or more, rated well above 18 V) across the motor
supply. A hard reversal on a shared rail browns out the Pico and reboots it
mid-move, and GrowBot's relay firmware treats a reboot as a link failure.

Those four pins are free on a Pico 2 W and each motor sits on its own PWM slice.
Avoid GP23, GP24, GP25, GP29 (WiFi) and GP0, GP1 (UART plus the bare-Pico servo
path).

## Install

1. Flash the normal GrowBot Pico build from **https://growbot.dev/build** (the
   one-click flasher). That gives you `secrets.py`, `act_engine.py` and
   `relay_chip.py` as `main.py`, which is the brain link plus the protocol.
2. Copy this driver over the servo one:

```bash
mpremote cp PicoRobotics.py :PicoRobotics.py && mpremote reset
```

3. Power on. It prints a **pairing code** on the serial console. Type that into
   the GrowBot app. The chip dials out to the relay, so it works from anywhere
   with WiFi, and you never need port forwarding.

## First power-up, in this order

Do not skip this. It is a machine that can drive into a pond.

1. **Wheels off the ground.** Mower up on blocks or a crate.
2. Power on and wait out the 15 s boot lockout. Nothing should move at all. If a
   wheel twitches during that window, stop and check `BOOT_LOCKOUT_MS`.
3. Pair it: enter your pairing code in the [tester](https://growbot.dev/tester/).
   Then under Calibrate, slide Direct pose Left a little below 90 and Right a
   little above 90. **Both wheels should roll forward**, because the stock
   calibration mirrors the left side, like the legs. If one turns backward, flip
   that side's entry in `INVERT` at the top of the file. If both do, flip both.
4. Open [wheels mode](https://growbot.dev/v3/next.html?wheels=1) and pair it (see
   What works, below). Drive a little, stop, then close the app mid-drive. **The
   wheels must stop every time.**
5. Only then put it on the grass, somewhere flat and fenced, with the mower's own
   STOP button in reach.

## Tuning (all at the top of the file)

| Setting | Default | Notes |
| --- | --- | --- |
| `MOTOR_PINS`, `INVERT` | GP2/3, GP4/5 | your pins, and flipping a backwards wheel |
| `MAX_DUTY` | `0.45` | speed ceiling. Start here, raise slowly. |
| `MIN_DUTY` | `0.22` | stiction floor. Raise if it stalls at low speed. |
| `CENTER_BRAKE` | `True` | neutral brakes rather than coasts. Leave on for slopes. |
| `SLEW_PER_S` | `6.0` | reversal softening. Lower is gentler on the gearboxes. |
| `DEADMAN_MS` | `300` | per-wheel. Brakes if that wheel's own input goes quiet. |
| `STALL_MS` | `0` | **off on purpose**, see below |
| `GAIT_ROLL` | `False` | **off on purpose**, see below |
| `BOOT_LOCKOUT_MS` | `15000` | the anti-lurch window described above |
| `PWM_FREQ` | `20000` | drop to ~1500 if you use an L298N |

Two things ship disabled, and both are deliberate.

**`STALL_MS = 0`.** There is no current sense or encoder on this setup, so a "jam"
can only be defined as "commanded hard for N seconds", which is exactly what normal
driving looks like too. Measured at the old default of 4000: a plain straight drive
at `deg=130` spent **225 of 1000 frames braked**, a 1.5 s hard brake every ~5.5 s,
forever. Each wheel runs its own timer, so they trip at different moments and yaw
the machine. Enable it only once you feed it something real. The IBT-2 brings out
current-sense `IS` pins for exactly this.

**`GAIT_ROLL = False`.** Use wheels mode instead, see below.

**The dead-man is software.** The sweep runs on an rp2 soft timer, which the
MicroPython docs describe as prone to GC jitter and delays. It is not a hardware
watchdog. Keep the mower's own STOP button reachable.

## What works

Working today: teleop, gestures and routines, chat, voice, the senses, the whole
personality. It is a real GrowBot that happens to be a lawnmower.

**Use wheels mode for driving.** Open `growbot.dev/v3/next.html?wheels=1`, tap
brain, then Settings, then Pair on the body row, and enter your pairing code.
Bookmark the page after pairing. In wheels mode the brain drives instead of
walking: a steady speed per side, then 90,90 to stop. It drives forward or pivots,
with no reverse. Declare a band of `[50,130]` in your body settings and keep
`MAX_DUTY` as your real ceiling. Details:
[growbot.dev/body-docs.html](https://growbot.dev/body-docs.html).

Without wheels mode, the walk lane streams mirrored leg angles (`l = 90 - x`,
`r = 90 + x`). Two servos read that as a gait. Two wheels read it as "spin one way,
then the other", so the mower twitches on the spot and never travels.

**`GAIT_ROLL` is from before wheels mode existed. Leave it off.** It tried to fix
that twitch on the chip by turning a gait into forward roll. The driver only gets
`servoWrite()` and `release()`, with no mode bit, so it can't tell a gait from a
human working the turn stick. Measured with it on, a ±25° teleop steering wiggle
injected **+0.255 mean forward drive**, so the mower rolls off while you think you
are turning on the spot. It can also only ever roll forward. Wheels mode is the
mode bit it was missing.

## One question before you buy a driver

Are the 310's wheel motors plain brushed DC, or are they the brushless assemblies
with their own little controller board? Sources disagree by model year, and it
changes what you need. You already have forward and reverse working from the Pico,
which strongly suggests brushed (or that you are driving an existing controller),
because a raw 3-phase BLDC will not do that on an H-bridge. Worth confirming before
you spend money, and worth knowing the stall current so you size the driver.

Also: the wheel motors probably have hall or encoder wires. If they do, those are
worth keeping. Odometry would let her know how far she has actually travelled,
which is the difference between wandering and exploring.
