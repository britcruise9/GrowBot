# GrowBot V0 Bill of Materials

This is everything on the robot in the video. It is the single cell, breadboard friendly build, not the V1 PCB (that is a separate board I am still working on). If you want to copy what is in the video, this is the list.

The whole thing comes in well under $100.

## Parts

| # | Part | Spec | Qty | ~CAD | Where / notes |
|---|------|------|----:|----:|----------------|
| **Compute** |
| 1 | Raspberry Pi Zero 2 W | quad core A53, WiFi/BT, 40 pin | 1 | $22 | [Adafruit (no header)](https://www.adafruit.com/product/5291) · [Adafruit (header pre-soldered)](https://www.adafruit.com/product/6008) — you will need to solder on a 40 pin header if you get the bare board |
| 2 | microSD card | 16 to 32 GB, Class 10 / A1 | 1 | $8 | any brand; I run Raspberry Pi OS Lite (64 bit) |
| 3 | 2x20 GPIO header | 0.1 inch male | 1 | $1 | [Amazon (10-pack)](https://www.amazon.com/Break-Away-2x20-pin-Strip-Header-Raspberry/dp/B0756KM7CY) — skip if your Pi already has one |
| **Actuation** |
| 4 | Feetech SCS0009 serial servo | half duplex UART 1 Mbps, 9 g, 1.5 kg·cm, 4 to 6 V (run ~5.1 V), 300° (same as Waveshare SC09) | 2 | $5 to 6 ea | [AliExpress](https://www.aliexpress.com/item/1005009980824534.html) — also available in [12-packs](https://www.aliexpress.com/item/1005010313759367.html) |
| 5 | 1 kΩ resistor | ¼ W | 1 | pennies | any electronics supplier or grab a resistor kit on AliExpress — for the servo half duplex line |
| **Sensing** |
| 6 | MPU-6050 IMU (GY-521) | I²C 0x68, 6 axis, 3.3 V | 1 | $3 | [AliExpress](https://www.aliexpress.com/item/32340949017.html) |
| 7 | OV5647 camera (Pi Zero) | 5 MP, narrow 22 to 15 pin CSI ribbon | 1 | $12 | [AliExpress — Pi Zero version](https://www.aliexpress.com/item/2251832596186902.html) — get the Pi Zero version with the narrow ribbon, not the standard one |
| 8 | INMP441 I²S mic | 3.3 V, 24 bit | 1 | $4 | [AliExpress](https://www.aliexpress.com/item/32962426410.html) |
| **Voice and lights** |
| 9 | MAX98357A I²S amp | 3.2 W class D mono | 1 | $5 | [AliExpress](https://www.aliexpress.com/item/1005008455683459.html) · [Adafruit](https://www.adafruit.com/product/3006) |
| 10 | speaker | 8 Ω, 0.5 to 3 W, small | 1 | $2 | [AliExpress search](https://www.aliexpress.com/w/wholesale-8ohm-speaker-small.html) — any small 8 Ω driver fits |
| 11 | WS2812B LED ring | 7 pixels, 5 V | 1 | $3 | [eBay (has 7-way option)](https://www.ebay.com/itm/254302794898) · [AliExpress (8-pixel is the closest common size)](https://www.aliexpress.com/item/1005002287819725.html) |
| **Power** |
| 12 | 1S LiPo or 18650 cell | 3.7 V, 800 to 1200 mAh | 1 | $4 | [AliExpress search](https://www.aliexpress.com/w/wholesale-lipo-battery-3.7v-jst.html) — whatever you have on hand |
| 13 | TP4056 module | USB-C, charge and protect | 1 | $1 | [AliExpress](https://www.aliexpress.com/item/32930640893.html) — get the protected version with OUT+/OUT- |
| 14 | MT3608 boost module | step up, set to about 5.1 V | 1 | pennies | [AliExpress](https://www.aliexpress.com/item/32450571426.html) |
| 15 | electrolytic cap | 470 to 1000 µF, 10 V or higher | 1 | pennies | any electronics supplier — goes across the 5 V rail at the servos |
| 16 | SPST power switch | | 1 | pennies | [AliExpress search](https://www.aliexpress.com/w/wholesale-spst-mini-toggle-switch.html) |
| | | | | **~$77 CAD** | about $56 USD |

## Also needed (not electronics)

- **3D printed body.** The STLs are in [`mechanical/`](mechanical/stl_snapshot/). Print in PLA or PETG, a small amount, well under a spool.
- **Hookup wire and dupont jumpers** to wire it up per the diagram.
- **Mounting.** I skipped screws and just stuck the boards down with 3M double sided mounting squares. Fast, and easy to move things around.

## GPIO pin map (Pi Zero 2 W, 40 pin header)

| Pi pin | Signal | Goes to |
|-------:|--------|---------|
| 2 / 4 | 5 V | 5 V rail from the MT3608 (Pi, servos, amp, LED) |
| 1 | 3.3 V | IMU VCC |
| 17 | 3.3 V | mic VDD |
| 6 / 9 / 14 / 25 | GND | common ground rail |
| 3 | GPIO2 / SDA | IMU SDA |
| 5 | GPIO3 / SCL | IMU SCL |
| 8 | GPIO14 / TXD | 1 kΩ, then the servo DATA bus |
| 10 | GPIO15 / RXD | servo DATA bus (direct) |
| 12 | GPIO18 | amp BCLK and mic SCK (shared) |
| 35 | GPIO19 | amp LRC and mic WS (shared) |
| 38 | GPIO20 | mic SD (data in) |
| 40 | GPIO21 | amp DIN (data out) |
| 32 | GPIO12 | WS2812 DIN |
| CSI | ribbon | camera (not GPIO) |

## Power

> [!CAUTION]
> V0 runs the servos and the Pi off one shared 5 V rail. A capacitor across the rail covers the voltage dips when the servos pull hard. This is the hacky part of V0; V1 separates them properly.

The 3.3 V for the IMU and the mic comes from the Pi's own 3.3 V pins, not from the booster.

## Setup notes (the stuff that gave me trouble)

1. Set the MT3608 to about 5.1 V with a multimeter before you connect the Pi. These boost modules ship turned up high.
2. The servos talk over the Pi's serial port, but the Pi uses it for other things by default. To hand it to the servos: add `dtoverlay=disable-bt` to `/boot/config.txt` (this frees the good serial port from Bluetooth), and in `raspi-config` turn the serial login off but leave the serial port itself on. After that the servos are on `/dev/serial0`.
3. The SCS0009 use big endian byte order for the 2 byte reads and writes. I assumed little endian at first and it silently read and wrote garbage.
4. Assign servo IDs 1 and 2 (both ship as ID 1, so you need to change one). This was a headache at first. The 3-pin servo lead is GND, VCC (5 V), DATA, but check your own servo's pinout before plugging in.
5. Torque limit the servos to about 70 percent so a double stall stays inside the MT3608's 2 A budget, otherwise use dedicated power for full load (a second MT3608 on the same ground).
6. Mic L/R to GND gives the left channel. The amp SD pin has to be high to play sound, so tie it to 3.3 V, and leaving the amp GAIN pin floating is about 9 dB.
7. The Pi Zero needs the narrow CSI ribbon (22 pin to 15 pin), not the standard camera ribbon.
8. The WS2812 data line needs root, so launch with `sudo`.

## Power budget

| Draw | Typical | Peak |
|------|--------:|-----:|
| Pi Zero 2 W | 200 mA | 400 mA |
| 2x SCS0009 (walking) | 400 mA | 1700 mA (both stalling) |
| Audio and LEDs | ~100 mA | ~400 mA |
| **Total** | **~700 mA** | **~2.1 A** |

The MT3608 is rated around 2 A, so normal walking is fine. A double stall goes over budget, which is why I torque limit the servos and added a capacitor to cover the dips.

Battery life is roughly 50 to 60 minutes of active play on an 800 to 1200 mAh cell.

## Software

The setup and calibration software is in [`setup/`](setup/). The learning agent and training code are still in development (V1).
