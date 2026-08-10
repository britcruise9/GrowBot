# hello_legs.py  --  GrowBot body check + servo-center for gluing.
# Copy to your Pico as  main.py , then power it on (battery; USB unplugged).
# You also need  PicoRobotics.py  on the Pico (it comes with the kit).
#
# It runs the 4-check TWICE, then HOLDS both legs at 90 (slow LED blink):
#   1) CENTER  - both legs to 90 (straight out)
#   2) RIGHT   - only the RIGHT leg waves   (right = port 3)
#   3) LEFT    - only the LEFT  leg waves   (left  = port 1)
#   4) UNISON  - both legs sweep together
#   -> then both HOLD at 90 forever so you can glue the legs on straight.
#
# USE IT TWICE:
#   Run 1 (servos mounted, NO legs yet): watch it wiggle -> it parks at 90 ->
#          super-glue each leg on pointing straight out while it holds.
#   Run 2 (after the glue sets): power-cycle and run again to confirm both
#          legs sweep evenly and sit straight.
#
# IF SOMETHING'S OFF: see the build-page troubleshooting table.

import time
from machine import Pin
from PicoRobotics import KitronikPicoRobotics

LEFT, RIGHT = 1, 3          # servo ports: left leg = 1, right leg = 3  (port 2 is dead)
board = KitronikPicoRobotics()

try:
    led = Pin("LED", Pin.OUT)
except Exception:
    led = None

def flash(n, on=120, off=160):
    if not led:
        return
    for _ in range(n):
        led.on();  time.sleep_ms(on)
        led.off(); time.sleep_ms(off)

def wave(port, times=3):        # wave ONE leg around 90 while the other holds still
    for _ in range(times):
        board.servoWrite(port, 60);  time.sleep_ms(250)
        board.servoWrite(port, 120); time.sleep_ms(250)
    board.servoWrite(port, 90)

def sweep_both(lo=40, hi=140):  # both legs travel together
    d = lo
    while d <= hi:
        board.servoWrite(LEFT, d); board.servoWrite(RIGHT, d)
        if led: led.toggle()
        time.sleep_ms(12); d += 2
    while d >= lo:
        board.servoWrite(LEFT, d); board.servoWrite(RIGHT, d)
        if led: led.toggle()
        time.sleep_ms(12); d -= 2

# --- run the 4-check twice ---
for cycle in range(2):
    print("1) CENTER"); flash(1, 400, 200)
    board.servoWrite(LEFT, 90); board.servoWrite(RIGHT, 90); time.sleep_ms(900)
    print("2) RIGHT");  flash(2); wave(RIGHT); time.sleep_ms(400)
    print("3) LEFT");   flash(3); wave(LEFT);  time.sleep_ms(400)
    print("4) BOTH");   flash(4); sweep_both(); sweep_both()
    board.servoWrite(LEFT, 90); board.servoWrite(RIGHT, 90); time.sleep_ms(600)

# --- then HOLD at 90 forever: glue the legs straight out while it holds ---
print("HOLDING at 90 - glue legs straight out now")
flash(3, 80, 80)
while True:
    board.servoWrite(LEFT, 90); board.servoWrite(RIGHT, 90)
    if led: led.toggle()
    time.sleep_ms(500)
