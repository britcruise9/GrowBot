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

**2. The stock firmware lurches on every boot.** GrowBot's firmware runs an ~8 s
"boot calibration" leg stretch on cold boot, so you can glue legs on straight.
Look at what that actually is on wheels (`relay_chip.py`, `boot_calibration`):
both wheels hard reverse for 260 ms, then hard forward, twice, before it has even
joined WiFi. On a 10 kg machine that drives it off the dock. This driver holds the
brake through that window (`BOOT_LOCKOUT_MS`, default 15 s) and swallows it.

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
3. Pair the app, then drive forward in teleop. **Both wheels should turn the same
   way.** If one runs backwards, flip that side's entry in `INVERT` at the top of
   the file. If the whole thing goes backwards, flip both.
4. Turn command: wheels should counter-rotate.
5. Ask her to walk. Both wheels should roll forward with a slight waddle (that is
   `GAIT_ROLL`, see below).
6. Only then put it on the grass, somewhere flat and fenced, with the mower's own
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

**`GAIT_ROLL = False`.** See the section below.

**The dead-man is software.** The sweep runs on an rp2 soft timer, which the
MicroPython docs describe as prone to GC jitter and delays. It is not a hardware
watchdog. Keep the mower's own STOP button reachable.

## What works, and one thing that does not

Working today: teleop, gestures and routines, chat, voice, the senses, the whole
personality. It is a real GrowBot that happens to be a lawnmower.

The catch, stated plainly: **the autonomous walk lane streams mirrored leg angles**
(`l = 90 - x`, `r = 90 + x`). Two servos read that as a gait. Two wheels read it as
"spin one way, then the other", so a stock wheeled bot twitches on the spot and
never travels. The ESP32 kit's README tells you to fix this by opening the app once
with `?wheels=1`. **That mode is not live.** I checked the deployed app and the
source: there is no wheels mode in either. Do not go hunting for it.

So this driver can fix it on the chip instead, with `GAIT_ROLL`. Each pose is split
into throttle (both wheels together) and yaw (the difference). For teleop that split
is an exact identity and changes nothing. When it sees a gait it converts how hard
she is gaiting into forward roll and damps the yaw, so she waddles forward instead
of twitching.

**It ships off, and you should understand why before you turn it on.** The
firmware hands this driver only `servoWrite()` and `release()`. There is no mode
bit, so nothing here can tell an autonomous gait from a human working the turn
stick: both are a mirrored yaw oscillation with near-zero net throttle. Measured
with it on, a ±25° teleop steering wiggle injected **+0.255 mean forward drive**,
so the mower rolls off while you believe you are turning on the spot. It is also
forward-only, because a mirrored stream carries no direction information, so an
autonomous gait can only ever roll **toward** whatever is in front of it.

Gating on zero-crossings does stop a *held* turn from being misread (that case is
covered and tested), but a human wiggling a stick produces genuine oscillation and
is simply indistinguishable. Turn `GAIT_ROLL = True` only for untended autonomous
runs: blade removed, boundary wire live, and after you have watched it on blocks.
For driving it around yourself, leave it off.

The real fix is a mode bit from the app, which is a change on our side, not yours.

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
