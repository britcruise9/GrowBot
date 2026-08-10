# Bare-Pico servo smoke test — proves PicoRobotics_gpio.py's core before you trust it.
# No flashing, nothing saved:   mpremote run test_servo_gpio.py
# Wire ONE servo at a time: signal -> GP0 (then GP1), red -> VBUS (pin 40), brown -> GND.
from machine import Pin, PWM
import time

def duty(deg):
    us = 500 + (2500 - 500) * deg / 180      # 0.5–2.5 ms, same mapping as the shim
    return int(us / 20000 * 65535)

for gp in (0, 1):
    print("testing GP%d — put a servo's signal wire here" % gp)
    p = PWM(Pin(gp)); p.freq(50)
    for d in (90, 60, 120, 90):
        p.duty_u16(duty(d)); print("  ->", d, "deg"); time.sleep(0.6)
    p.duty_u16(0)                             # release = limp
    print("  released (should go limp)")
    time.sleep(0.5)
print("done — if it swept smoothly then went limp, the shim is good")
