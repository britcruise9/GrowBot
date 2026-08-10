# Template for secrets.py — your robot's Wi-Fi, used by relay_chip.py (main.py).
# Copy this file to  secrets.py , fill in your real network, then flash it next
# to the other files. The browser flasher on growbot.dev/build writes this for
# you — only fill this in by hand if you're using Thonny or mpremote.
#
#   mpremote cp secrets.py :secrets.py
#
# Note: the Pico 2 W joins 2.4 GHz Wi-Fi only (not 5 GHz).

WIFI_SSID = "your-wifi-network-name"
WIFI_PASSWORD = "your-wifi-password"
