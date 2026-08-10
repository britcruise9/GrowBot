"""
PicoRobotics.py  --  GrowBot DC-MOTOR / WHEELS driver for the RASPBERRY PI PICO 2 W,
tuned for a BIG body (robot mower conversion). Drop-in replacement, one file.

This is a PICO port of the ESP32 wheels kit. Three things in that file are fatal on
a Pico 2 W, so do not just copy the ESP32 one across:

  1. machine.Timer(0)  -> the rp2 port has SOFT TIMERS ONLY (id must be -1).
                          Timer(0) raises ValueError, the board never finishes
                          booting, and you get a dead robot with no clue why.
  2. pins 32 / 33      -> do not exist on a Pico. GP0..GP29 only.
  3. pin 25            -> on a Pico W / Pico 2 W, GP23/24/25/29 are wired to the
                          CYW43 WiFi chip. Driving GP25 kills WiFi.

Flash the normal GrowBot Pico build first (growbot.dev/build, the one-click
flasher), then copy THIS file over PicoRobotics.py:

    mpremote cp PicoRobotics.py :PicoRobotics.py
    mpremote reset

Everything above the driver is angle-based and unchanged. The whole firmware
touches hardware through exactly two calls:

    board = KitronikPicoRobotics()
    board.servoWrite(port, deg)   # port 1 = LEFT wheel, port 3 = RIGHT wheel, 0..180
    board.release(port)           # stop that wheel

On a servo body `deg` is an angle (90 = neutral). On wheels we read it as a
signed drive command centred on 90:  90 = stop, >90 = one way, <90 = the other.

WHAT IS DIFFERENT FROM THE ESP32 KIT (beyond the three fixes above):

  * BOOT LOCKOUT. The stock firmware runs an ~8 s "boot calibration" leg stretch
    on every cold boot (relay_chip.py boot_calibration). On legs that is a cute
    wiggle. On a mower it is BOTH WHEELS HARD REVERSE for 260 ms, then hard
    forward, twice, before it has even joined WiFi. That drives a 10 kg machine
    off its dock. We swallow that window and hold the brake instead.
  * MAX_DUTY ceiling. An 18 V mower drivetrain at full duty is much faster than
    anything you want indoors or near feet. Default caps at ~45%.
  * CENTER_BRAKE defaults True. Coast on a slope means it rolls downhill.
  * GAIT_ROLL (OFF by default). The autonomous walk lane streams MIRRORED leg
    angles, which on wheels means the two motors counter-rotate and the bot
    twitches in place instead of rolling. This can convert that into forward roll,
    but it cannot tell an autonomous gait from a human steering, so read the note
    at GAIT_ROLL below before enabling it.
  * PER-SIDE DEAD-MAN. If one wheel's pose stream dies while the other keeps
    arriving, that wheel must not hold its last command. Handled in _mix.
  * STALL_MS OFF. Without current sense it cannot tell a jam from normal driving,
    and it brakes a healthy drive every few seconds. See the note at STALL_MS.

WIRING: see WIRING in README.md. Short version, IN/IN sign-magnitude H-bridge,
each motor = two PWM pins. DO NOT USE A DRV8833 (10.8 V max) OR A TB6612
(15 V max) ON AN 18 V MOWER RAIL. They will let the smoke out. Use a BTS7960 /
IBT-2 (6-27 V) or a DRV8871 (up to 45 V).
"""

import machine, utime
from machine import Pin, PWM

# ---- wiring: port -> (IN1 pin, IN2 pin) ---------------------------------
# Pico 2 W safe defaults. GP2/GP3 and GP4/GP5 are free, and each motor sits on
# its own PWM slice. AVOID GP23, GP24, GP25, GP29 (CYW43 WiFi) and GP0/GP1
# (UART0 + the bare-Pico servo path).
MOTOR_PINS = {1: (2, 3),          # LEFT  wheel  (port 1)
              3: (4, 5)}          # RIGHT wheel  (port 3)
INVERT     = {1: False, 3: False} # set True to flip a wheel that drives backwards

# ---- tuning --------------------------------------------------------------
PWM_FREQ          = 20000   # 20 kHz, silent. Use ~1500 for an L298N.
DEADBAND_DEG      = 4       # |deg-90| below this = neutral (no drive)
MIN_DUTY          = 0.22    # floor so a small command still overcomes stiction
MAX_DUTY          = 0.45    # CEILING. Heavy machine: start low, raise slowly.
SPEED_GAIN        = 1.0     # raise (~2.0) if the expressive band feels too slow
CENTER_BRAKE      = True    # neutral: True = brake (stops dead), False = coast
SLEW_PER_S        = 6.0     # ramp rate; softens hard reversals. 0 = off.
DEADMAN_MS        = 300     # brake a wheel if ITS OWN input goes quiet this long
STALL_MS          = 0       # OFF. See the note below before you turn this on.
STALL_LEVEL       = 0.35    # |command| above this counts as "driving hard"
STALL_COOLDOWN_MS = 1500    # after a jam trip, stay braked this long, then retry
# ^ STALL_MS is OFF on purpose. There is no current sense or encoder here, so a
# "jam" can only be defined as "commanded hard for N seconds", which is also what
# ordinary driving looks like. Measured at STALL_MS=4000: a normal straight drive
# at deg=130 spent 225 of 1000 frames braked, i.e. a 1.5 s hard brake every ~5.5 s
# forever, and because each wheel keeps its own timer they trip at different
# moments and yaw the machine. Turn this on only once you feed it real feedback
# (the IBT-2 brings out current-sense IS pins, or use the wheel encoders).
BOOT_LOCKOUT_MS   = 15000   # ignore + brake for this long after power-up. This is
                            # what swallows the boot calibration lurch. 0 = off.

# ---- GAIT_ROLL: make the autonomous walk lane actually roll --------------
# The brain's walk policy emits MIRRORED leg angles (l = 90 - x, r = 90 + x).
# Two servos read that as a gait. Two wheels read it as "spin one way, then the
# other", so the mower just twitches on the spot and never goes anywhere.
#
# We decompose each pose into throttle (both wheels together) and yaw (the
# difference). For teleop and same-sign gestures this is an exact identity and
# changes nothing. When we see the signature of a gait we convert how hard she is
# gaiting into forward roll, and damp the yaw so it wiggles rather than
# counter-rotates.
#
# The gait signature is OSCILLATION, not just "yaw is big". A steady teleop turn
# also has big yaw and near-zero throttle, and must stay a turn: if we keyed off
# magnitude alone, telling the mower to spin on the spot would drive it forward
# instead. So we require yaw to keep CROSSING ZERO (GAIT_CROSS_MIN), which a
# held turn never does.
#
# Result: when GrowBot decides to walk, the mower rolls forward with a slight
# waddle, at a speed proportional to how hard she is trying.
#
# ⚠️ OFF BY DEFAULT, AND HERE IS THE HONEST REASON. The firmware gives this driver
# only servoWrite() and release(). There is no mode bit, so nothing here can tell
# an autonomous gait from a human working the turn stick: both are a mirrored yaw
# oscillation with near-zero net throttle. Measured with GAIT_ROLL on, a ±25 deg
# teleop steering wiggle injected +0.255 mean forward drive, so the mower rolls
# off while the operator believes they are turning on the spot. The injection is
# also forward-only, because a mirrored stream carries no direction information,
# so an autonomous gait can only ever roll TOWARD whatever is in front of it.
#
# Turn this on only for untended autonomous runs: blade removed, boundary wire
# live, and after you have watched it on blocks. For teleop, leave it off.
GAIT_ROLL      = False
GAIT_ROLL_GAIN = 1.0     # forward speed per unit of gait amplitude
GAIT_YAW_KEEP  = 0.35    # how much of the original wiggle to keep (0 = dead straight)
GAIT_MIN_ENV   = 0.08    # gait must be at least this strong before we roll
GAIT_THR_MAX   = 0.25    # ...and net throttle below this (i.e. not a teleop command)
GAIT_CROSS_MIN = 1.2     # ...and yaw must be oscillating this fast, in Hz
GAIT_ENV_ALPHA = 0.10    # envelope smoothing (lower = slower to react)
GAIT_X_DECAY   = 0.96    # zero-cross decay per pose; makes xrate read out in Hz
ROLL_MAX       = 0.60    # clamp on the injected command (duty is capped at MAX_DUTY)

_FULL     = 65535
_DEADBAND = DEADBAND_DEG / 90.0


def _clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


class _Motor:
    def __init__(self, in1, in2, invert):
        self.a = PWM(Pin(in1)); self.a.freq(PWM_FREQ); self.a.duty_u16(0)
        self.b = PWM(Pin(in2)); self.b.freq(PWM_FREQ); self.b.duty_u16(0)
        self.invert = invert
        self.cur = 0.0                 # current (slew-limited) signed command
        self.last = utime.ticks_ms()
        self.last_cmd = self.last      # last time a command arrived (dead-man)
        self.hard_since = None         # when hard driving began (jam watchdog)
        self.cool_until = None         # braked until this tick after a jam trip

    def _out(self, da, db):
        self.a.duty_u16(da); self.b.duty_u16(db)

    def coast(self):
        self._out(0, 0); self.cur = 0.0; self.hard_since = None

    def brake(self):
        self._out(_FULL, _FULL); self.cur = 0.0; self.hard_since = None

    def release(self):
        # NOTE: does NOT clear a jam cooldown -- it is time-bounded, and letting a
        # stop->drive cycle re-arm a tripped motor allows indefinite grinding.
        self.brake()                   # stop hard: a rolling machine must not coast

    def _apply(self, s):
        # stiction floor fades in across the deadband so a slewed reversal passes
        # through ~0 duty at the sign flip instead of snapping -22% -> +22%
        a = abs(s)
        mag = (MIN_DUTY + (MAX_DUTY - MIN_DUTY) * _clamp(a * SPEED_GAIN, 0.0, 1.0)) \
              * _clamp(a / _DEADBAND, 0.0, 1.0)
        duty = int(_clamp(mag, 0.0, 1.0) * _FULL)
        forward = (s > 0) != self.invert
        if forward:
            self._out(duty, 0)
        else:
            self._out(0, duty)

    def drive(self, target):
        now = utime.ticks_ms()
        dt = utime.ticks_diff(now, self.last) / 1000.0
        self.last = now
        self.last_cmd = now            # feed the dead-man
        target = _clamp(target, -1.0, 1.0)

        # jam cooldown: stay braked until it expires
        if self.cool_until is not None:
            if utime.ticks_diff(self.cool_until, now) > 0:
                self.brake(); return
            self.cool_until = None

        # neutral -> stop
        if abs(target) < _DEADBAND:
            if CENTER_BRAKE:
                self.brake()
            else:
                self.coast()
            return

        # jam watchdog: driven hard for too long -> brake + cool off, then retry
        if STALL_MS and abs(target) >= STALL_LEVEL:
            if self.hard_since is None:
                self.hard_since = now
            elif utime.ticks_diff(now, self.hard_since) > STALL_MS:
                self.cool_until = utime.ticks_add(now, STALL_COOLDOWN_MS)
                self.brake(); return
        else:
            self.hard_since = None

        # slew-limit toward target so a full reversal ramps instead of slamming.
        # dt==0 (two commands in the same ms) must NOT snap to target, and dt is
        # capped so the first command after an idle gap still ramps.
        if SLEW_PER_S > 0:
            if dt > 0:
                step = SLEW_PER_S * (0.05 if dt > 0.05 else dt)
                self.cur += _clamp(target - self.cur, -step, step)
        else:
            self.cur = target
        self._apply(self.cur)


class _FakeI2C:
    """robot-server.py's release() pokes a PCA9685 register; decode it back to a port.
    Kept so this driver also works under the older LAN firmware, not just relay_chip."""
    def __init__(self, owner):
        self._o = owner
    def writeto_mem(self, addr, reg, data):
        off = reg - 0x0B
        if off >= 0 and off % 4 == 0:
            self._o.release(off // 4 + 1)


class _WheelBoard:
    L_PORT, R_PORT = 1, 3

    def __init__(self):
        self.motors = {p: _Motor(a, b, INVERT.get(p, False))
                       for p, (a, b) in MOTOR_PINS.items()}
        self.i2c = _FakeI2C(self)
        now = utime.ticks_ms()
        self.raw = {self.L_PORT: 0.0, self.R_PORT: 0.0}   # latest signed cmd per side
        self.raw_ts = {self.L_PORT: now, self.R_PORT: now}  # when each side last spoke
        self._dirty_l = False                              # both sides fresh -> mix
        self._dirty_r = False
        self._seen_l = False                               # has this side ever spoken?
        self._seen_r = False
        self.env = 0.0                                     # gait amplitude envelope
        self.xrate = 0.0                                   # yaw zero-crossing rate
        self._ysign = 0                                    # last yaw sign seen
        self._boot = now
        # DEAD-MAN: a servo freezing mid-pose on a dropped link is benign; a wheel
        # holding its last duty drives the machine into a pond. Sweep from a timer so
        # a dead command stream cannot leave a motor running.
        # rp2 = SOFT TIMERS ONLY: the id must be -1. Timer(0) raises ValueError here.
        self._wd = machine.Timer(-1)
        self._wd.init(period=100, mode=machine.Timer.PERIODIC, callback=self._sweep)

    def _sweep(self, t):
        now = utime.ticks_ms()
        for m in self.motors.values():
            if m.cur != 0.0 and utime.ticks_diff(now, m.last_cmd) > DEADMAN_MS:
                m.brake()

    def _locked_out(self):
        if not BOOT_LOCKOUT_MS:
            return False
        return utime.ticks_diff(utime.ticks_ms(), self._boot) < BOOT_LOCKOUT_MS

    def _mix(self):
        """Latest L/R pose -> actual wheel commands. Identity unless GAIT_ROLL fires."""
        # PER-SIDE DEAD-MAN. The timer sweep below only catches a stream that has
        # died completely, because _mix drives BOTH motors and so refreshes both
        # dead-man clocks on any single write. If one side's pose stream stops
        # while the other keeps arriving, that stale side would otherwise hold its
        # last command forever (measured: still driving at 0.35 two seconds after
        # its stream died). So expire the INPUT, per side, before mixing.
        now = utime.ticks_ms()
        for p in (self.L_PORT, self.R_PORT):
            if self.raw[p] != 0.0 and utime.ticks_diff(now, self.raw_ts[p]) > DEADMAN_MS:
                self.raw[p] = 0.0
        l = self.raw[self.L_PORT]
        r = self.raw[self.R_PORT]
        thr = (l + r) / 2.0            # common mode: both wheels together
        yaw = (l - r) / 2.0            # differential: spin

        if GAIT_ROLL:
            self.env += (abs(yaw) - self.env) * GAIT_ENV_ALPHA
            # zero-crossing rate: high for an oscillating gait, zero for a held turn
            sign = 1 if yaw > _DEADBAND else (-1 if yaw < -_DEADBAND else 0)
            self.xrate *= GAIT_X_DECAY
            if sign and self._ysign and sign != self._ysign:
                self.xrate += 1.0
            if sign:
                self._ysign = sign
            if (self.xrate > GAIT_CROSS_MIN and self.env > GAIT_MIN_ENV
                    and abs(thr) < GAIT_THR_MAX):
                thr += _clamp(GAIT_ROLL_GAIN * self.env, 0.0, ROLL_MAX)
                yaw *= GAIT_YAW_KEEP

        self.motors[self.L_PORT].drive(_clamp(thr + yaw, -1.0, 1.0))
        self.motors[self.R_PORT].drive(_clamp(thr - yaw, -1.0, 1.0))

    def servoWrite(self, port, deg):
        if port not in self.raw:
            return
        if self._locked_out():
            for m in self.motors.values():
                m.brake()
            return
        deg = 0 if deg < 0 else 180 if deg > 180 else deg
        self.raw[port] = (deg - 90) / 90.0      # 90 = stop; 0..180 -> -1..+1
        self.raw_ts[port] = utime.ticks_ms()
        # Mix ONCE PER POSE, when both sides are fresh. The firmware writes L then
        # R back to back, so mixing on every write applied (new L, old R) to the
        # hardware, and the R write landed in the same millisecond where dt==0 left
        # self.cur untouched -- so the half-stale output stood for the whole frame
        # and the right wheel ran a pose behind, twitching the yaw on every step.
        if port == self.L_PORT:
            self._dirty_l = True
            self._seen_l = True
            other, seen_other = self.R_PORT, self._seen_r
        else:
            self._dirty_r = True
            self._seen_r = True
            other, seen_other = self.L_PORT, self._seen_l
        # Fall through anyway if the OTHER side has gone quiet past the dead-man, so
        # a one-sided stream still reaches the wheels (with the dead side expired to
        # neutral by _mix) instead of freezing the mixer. Requires that side to have
        # spoken at least once: at boot neither has, and without this the very first
        # write would look "stale" and mix a half pose.
        stale = seen_other and \
            utime.ticks_diff(self.raw_ts[port], self.raw_ts[other]) > DEADMAN_MS
        if (self._dirty_l and self._dirty_r) or stale:
            self._dirty_l = False
            self._dirty_r = False
            self._mix()

    def release(self, port):
        m = self.motors.get(port)
        if m:
            self.raw[port] = 0.0
            self.env = 0.0
            self.xrate = 0.0
            self._ysign = 0
            m.release()


def KitronikPicoRobotics():
    """Factory, name-compatible with the servo driver the firmware imports."""
    print("PicoRobotics: WHEELS/MOWER mode (Pico 2 W) -- H-bridge on", MOTOR_PINS)
    if BOOT_LOCKOUT_MS:
        print("  boot lockout %d ms: wheels braked, calibration stretch suppressed"
              % BOOT_LOCKOUT_MS)
    return _WheelBoard()
