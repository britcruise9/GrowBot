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

# NEW (0830): your robot can know SEVERAL networks — home, phone hotspot, workshop.
# It scans and joins the strongest one it recognizes. List them in order of preference:
#
# WIFI_NETWORKS = [
#     ("home-wifi-name", "home-password"),
#     ("my-phone-hotspot", "hotspot-password"),
# ]
#
# (The single WIFI_SSID/WIFI_PASSWORD above still works and is tried too.)
