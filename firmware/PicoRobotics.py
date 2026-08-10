"""
PicoRobotics.py  --  GrowBot auto-detecting servo driver.

Drop this on the Pico as  PicoRobotics.py . The programs on top all call:
    board = KitronikPicoRobotics()
    board.servoWrite(port, deg)        # port 1 = LEFT, port 3 = RIGHT; deg 0..180
...and don't care what's underneath. This file picks the driver at boot:

  * CARRIER BOARD (I2C / PCA9685 chip, e.g. Kitronik Robotics @0x6C,
    generic PCA9685 @0x40 on GP8/GP9) -> detected on the I2C bus, driven over I2C.
        [VERIFIED on the Kitronik Robotics Board 5329]
  * DIRECT-WIRE (no chip on the bus) -> servos driven straight off
    GP0 (left) / GP1 (right) with hardware PWM.
        [VERIFIED 2026-07-27 on the Waveshare Pico Servo Driver. That board
         carries NO PCA9685 -- an I2C sweep of every legal pin pair found
         nothing on the bus -- so every Waveshare build runs this path, and
         its silkscreen socket numbers ARE the GPIO numbers: 0 = left,
         1 = right. Same path for a bare Pico with servos on GP0/GP1.]

Ports:  1 = left, 3 = right   (port 2 is the dead socket on the Kitronik board).

ADVANCED override (skip auto-detect): set FORCE = "i2c" or "gpio" below, and
edit the I2C pins / addresses or GPIO_PINS for an unusual board.
"""
import machine, utime
from machine import Pin, PWM

# ---- config / manual override -------------------------------------------
FORCE      = None            # None = auto-detect ; or "i2c" / "gpio"
I2C_ID     = 0               # Kitronik Robotics board: I2C0 ...
SDA_PIN    = 8               # ... SDA on GP8 ...
SCL_PIN    = 9               # ... SCL on GP9
CHIP_ADDRS = (0x6C, 0x40)    # Kitronik = 0x6C, generic PCA9685 = 0x40
GPIO_PINS  = {1: 0, 3: 1}    # direct-wire: port 1 -> GP0 (left), port 3 -> GP1 (right)


# ---- I2C / PCA9685 driver (carrier board) --- verbatim Kitronik logic ----
class _I2CBoard:
    SRV_REG_BASE = 0x08
    REG_OFFSET   = 4
    PRESCALE_VAL = b'\x79'           # prescale 121 -> ~50 Hz servo frame

    def __init__(self, addr):
        self.CHIP_ADDRESS = addr
        self.i2c = machine.I2C(I2C_ID, sda=Pin(SDA_PIN), scl=Pin(SCL_PIN), freq=100000)
        self.initPCA()

    def initPCA(self):
        self.i2c.writeto(0, b'\x06')                       # general-call reset
        self.i2c.writeto_mem(self.CHIP_ADDRESS, 0xfe, self.PRESCALE_VAL)
        for r in (0xfa, 0xfb, 0xfc, 0xfd):                 # clear ALL_LED on/off
            self.i2c.writeto_mem(self.CHIP_ADDRESS, r, b'\x00')
        self.i2c.writeto_mem(self.CHIP_ADDRESS, 0x00, b'\x01')   # MODE1: wake + allcall
        utime.sleep_us(500)

    def servoWrite(self, servo, degrees):
        degrees = 0 if degrees < 0 else 180 if degrees > 180 else degrees
        if servo < 1 or servo > 8:
            raise Exception("INVALID SERVO NUMBER")
        reg = self.SRV_REG_BASE + (servo - 1) * self.REG_OFFSET
        v = int(degrees * 2.2755) + 102                    # 0deg ~0.5ms .. 180deg ~2.5ms
        self.i2c.writeto_mem(self.CHIP_ADDRESS, reg,     bytes([v & 0xFF]))
        self.i2c.writeto_mem(self.CHIP_ADDRESS, reg + 1, bytes([(v >> 8) & 0x01]))

    def release(self, servo):
        reg = self.SRV_REG_BASE + (servo - 1) * self.REG_OFFSET
        self.i2c.writeto_mem(self.CHIP_ADDRESS, reg + 1, bytes([0x10]))   # full-off -> limp


# ---- GPIO driver (direct-wire) --- verified on the Waveshare Pico Servo Driver ----
_FREQ = 50
_MIN_US, _MAX_US = 500, 2500
_PERIOD_US = 1_000_000 // _FREQ

def _duty(deg):
    deg = 0 if deg < 0 else 180 if deg > 180 else deg
    us = _MIN_US + (_MAX_US - _MIN_US) * deg / 180
    return int(us / _PERIOD_US * 65535)

class _FakeI2C:
    """robot-server's release() pokes a PCA9685 register; decode it back to a port -> limp."""
    def __init__(self, owner):
        self._o = owner
    def writeto_mem(self, addr, reg, data):
        off = reg - 0x0B
        if off >= 0 and off % 4 == 0:
            self._o.release(off // 4 + 1)

class _GPIOBoard:
    def __init__(self):
        self.pwm = {}
        for port, gp in GPIO_PINS.items():
            p = PWM(Pin(gp)); p.freq(_FREQ); p.duty_u16(0)
            self.pwm[port] = p
        self.i2c = _FakeI2C(self)
    def servoWrite(self, port, deg):
        p = self.pwm.get(port)
        if p:
            p.duty_u16(_duty(deg))
    def release(self, port):
        p = self.pwm.get(port)
        if p:
            p.duty_u16(0)


# ---- auto-detect factory -------------------------------------------------
def _detect_addr():
    try:
        bus = machine.I2C(I2C_ID, sda=Pin(SDA_PIN), scl=Pin(SCL_PIN), freq=100000)
        found = bus.scan()
        for a in CHIP_ADDRS:
            if a in found:
                return a
    except Exception:
        pass
    return None

def KitronikPicoRobotics():
    """Factory: an I2C board driver if a servo chip is on the bus, else direct-wire GPIO."""
    mode = FORCE
    addr = None
    if mode is None:
        addr = _detect_addr()
        mode = "i2c" if addr is not None else "gpio"
    elif mode == "i2c":
        addr = CHIP_ADDRS[0]
    if mode == "i2c":
        print("PicoRobotics: I2C servo board detected @", hex(addr))
        return _I2CBoard(addr)
    print("PicoRobotics: no I2C chip -> direct-wire, GP0 = left, GP1 = right")
    return _GPIOBoard()
