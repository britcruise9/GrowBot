"""
PicoRobotics.py — BARE-PICO drop-in (NO Kitronik board needed).

Copy this onto the Pico AS  PicoRobotics.py  and robot-server.py + act_engine.py
run UNCHANGED. Instead of the Kitronik I2C servo chip, it drives two SG90/MG90
servos straight off two GPIO pins using the RP2350 hardware PWM. It exposes the
exact same calls the firmware makes:
    board = KitronikPicoRobotics()
    board.servoWrite(port, deg)     # port 1 = left, port 3 = right; deg 0..180
    board.i2c.writeto_mem(...)      # the firmware's "release" poke -> servo limp

WIRING — each servo has 3 wires (signal / power / ground):
    signal (orange/yellow) -> the GPIO in PORT_GP below
    power  (red)           -> the battery + rail (see POWER)
    ground (brown/black)   -> GND  (shared with the Pico)

POWER — SG90/MG90 are happy on a raw 1S LiPo (~3.7-4.2V); nothing needs to
boost to 5V (Brit's bench rig runs them straight off ~4V and they're fine).
Two easy ways:
  • UNTETHERED (matches the real rig): 1S LiPo + -> Pico VSYS (pin 39) AND
    both servo reds; LiPo - -> a Pico GND AND both servo browns. One cell
    powers everything. Put your battery switch on the + lead.
  • BENCH/FILMING: just a USB cable or power bank into the Pico; run both
    servo reds off VBUS (pin 40). Don't also feed VSYS from a battery while
    USB is plugged unless you know the Schottky-diode trick.
Always tie the servo grounds to the Pico ground. Servos pull their current
from the BATTERY rail, never from a logic pin / 3V3.

To use different pins, edit PORT_GP. (SG90 and MG90S are identical here —
same 50 Hz signal; MG90S just pulls more current.)

Not yet tested on hardware — bench check: after flashing, both arms should
twitch to center (90 deg) on boot, then a /routine should move both.
"""
from machine import Pin, PWM

PORT_GP = {1: 0, 3: 1}          # board "port" -> Pico GPIO  (1=left->GP0, 3=right->GP1)

_FREQ = 50                      # SG90/MG90 servos run at 50 Hz (20 ms frame)
_MIN_US, _MAX_US = 500, 2500    # 0.5 ms = 0 deg, 2.5 ms = 180 deg
_PERIOD_US = 1_000_000 // _FREQ


def _duty(deg):
    deg = 0 if deg < 0 else 180 if deg > 180 else deg
    us = _MIN_US + (_MAX_US - _MIN_US) * deg / 180
    return int(us / _PERIOD_US * 65535)


class _FakeI2C:
    """robot-server._release() pokes a PCA9685 register to cut a port's pulse.
    We decode that register back to a port number and drop the PWM (= limp)."""
    def __init__(self, owner):
        self._o = owner

    def writeto_mem(self, addr, reg, data):
        off = reg - 0x0B                  # firmware writes 0x08 + (port-1)*4 + 3
        if off >= 0 and off % 4 == 0:
            self._o.release(off // 4 + 1)


class KitronikPicoRobotics:
    def __init__(self):
        self.pwm = {}
        for port, gp in PORT_GP.items():
            p = PWM(Pin(gp))
            p.freq(_FREQ)
            p.duty_u16(0)                 # start limp (no pulse)
            self.pwm[port] = p
        self.i2c = _FakeI2C(self)

    def servoWrite(self, port, deg):
        p = self.pwm.get(port)
        if p:
            p.duty_u16(_duty(deg))

    def release(self, port):
        p = self.pwm.get(port)
        if p:
            p.duty_u16(0)                 # stop pulsing -> no holding torque (limp)
