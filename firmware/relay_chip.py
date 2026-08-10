# GrowBot relay client — the Pico dials OUT to the relay as a WebSocket client.
# Runs as main.py on boot (battery, untethered) OR via `mpremote run`.
# Speaks BOTH body lanes over the relay, reusing the motor driver + act_engine
# (so gestures glide exactly like the LAN firmware).
#
# ===== CANONICAL WIRE PROTOCOL (keep identical to relay-transport.js) =====
#   phone -> chip:
#     {"t":"attach","id","code"}                      handshake (sent by the app/tester)
#     {"t":"pose","lr":"L,R"}                          WALK lane: latest-wins ~30Hz, L,R int deg 0..180
#     {"t":"act","rid","steps":[{l,r,ms}],"mode"}      GESTURE lane: keyframes; mode "replace"|"append"
#     {"t":"routine","rid","name"}                     canned gesture (e.g. "wiggle")
#     {"t":"stop","rid"}                               halt gesture + limp
#   chip -> phone:
#     {"t":"hello","id"}                               chip handshake to the relay
#     {"t":"ack","rid","ok","queued_ms"}               reply to act/routine/stop
#     {"t":"status","awake"}                           emitted by the RELAY (chip presence), not the chip
#   (a pose carrying "seq"/"ts" gets a {"t":"ack","seq","ts"} echo — latency tools only.)
#
# ===== LINK SELF-HEAL =====
# Field failure: a servo-current brownout can kill the WiFi/relay link while the Pico
# keeps running — LED lit, robot deaf, only a power cycle brought it back. The link now
# heals itself, in escalating layers:
#   1. every socket op carries a timeout — no connect/read/write can block forever
#   2. link heartbeat: once the socket goes quiet the chip PINGs the relay (Cloudflare's
#      edge pongs back on its own; the traffic also keeps home-router NAT entries alive);
#      nothing received for LINK_DEAD_MS -> tear down and re-dial
#   3. wifi watch: WLAN drop -> reassociate + re-dial, exponential backoff between tries
#   4. escalation: every WIFI_RESET_EVERY straight failures power-cycle the radio
#      (active False/True); after HARD_RESET_AFTER failures, machine.reset() = an
#      automatic power cycle (boot skips the calibration stretch on self-heal resets)
#   5. a hardware watchdog — armed at the FIRST relay connect, unarmed before that so a
#      no-wifi boot idles calmly — reboots the chip if the firmware itself ever freezes
# The walk dead-man below is a FEATURE (limp on pose silence) and is separate from this.
import network, socket, ssl, os, json, time, binascii, select, machine
import PicoRobotics
from act_engine import ActEngine

HOST = "growbot-relay.growbot.workers.dev"
# Each board self-assigns a stable, unique pairing code from its hardware id, so two
# robots never collide on the relay. To pin a custom code, set DEVID = "yourcode" instead.
DEVID = "gb-" + binascii.hexlify(machine.unique_id()).decode()[-6:]
PATH = "/d/" + DEVID

print("\n========================================")
print("  PAIRING CODE:  " + DEVID)
print("  Enter this code in the GrowBot app.")
print("========================================\n")

board = PicoRobotics.KitronikPicoRobotics()
L_PORT, R_PORT = 1, 3
DEADMAN_MS = 500          # limp the WALK legs if no pose arrives for this long (matches the firmware)
POLL_MS = 20              # main-loop cadence: ticks the act engine ~50Hz and polls for frames

NET_TIMEOUT_S = 6         # bound on every socket op; must stay well under WDT_MS
PING_MS = 10000           # heartbeat cadence once the link has been quiet this long
LINK_DEAD_MS = 25000      # quiet this long (= 2 unanswered pings) -> wedged, re-dial
WIFI_RESET_EVERY = 3      # straight failures between radio power-cycles
HARD_RESET_AFTER = 10     # straight failures before machine.reset() (~3-5 min of trying)
WDT_MS = 8000             # hardware watchdog period (rp2 hardware caps near 8.3s)

wlan = network.WLAN(network.STA_IF)

_wdt = None               # armed once in serve(); machine.WDT can NEVER be disarmed after
                          # that, so every path below must keep the feed()s flowing

def feed():
    if _wdt:
        _wdt.feed()

def sleep_fed(ms):        # sleep that keeps the hardware watchdog fed
    while ms > 0:
        feed(); time.sleep_ms(min(ms, 200)); ms -= 200

def ensure_wifi():
    wlan.active(True)
    if not wlan.isconnected():
        try:
            import secrets
            # field secrets.py (written by the build page + all existing robots) says WIFI_PASS;
            # newer secrets.example.py says WIFI_PASSWORD — accept both, or cold boots crash here.
            _pw = getattr(secrets, 'WIFI_PASSWORD', None) or getattr(secrets, 'WIFI_PASS', '')
            wlan.connect(secrets.WIFI_SSID, _pw)
        except Exception as e:
            print("wifi err", e)
        for _ in range(150):                            # up to ~15s (cold-boot radio is slow)
            if wlan.isconnected():
                break
            feed(); time.sleep_ms(100)
    ok = wlan.isconnected()
    # distinct one-line tokens the build-page flasher scans for, so "flashed OK" never masks "Wi-Fi didn't join"
    if ok:
        print("WIFI_OK", wlan.ifconfig()[0])
    else:
        print("WIFI_FAIL")
    print("wifi:", ok, wlan.ifconfig()[0] if ok else "-")
    return ok

def wifi_reset():
    # power the radio down and back up — recovers a brownout-wedged CYW43 that still
    # CLAIMS to be associated (or won't reassociate) without a full chip reset
    print("wifi: bouncing the radio")
    try:
        wlan.disconnect()
    except Exception:
        pass
    try:
        wlan.active(False)
    except Exception:
        pass
    sleep_fed(1000)
    wlan.active(True)

def ws_open():
    feed()
    ai = socket.getaddrinfo(HOST, 443)[0][-1]
    raw = socket.socket()
    raw.settimeout(NET_TIMEOUT_S)   # lwIP timeout rides under the SSL layer too: every later
    feed()                          # read/write errors out instead of blocking forever
    try:
        raw.connect(ai)
        feed()
        s = ssl.wrap_socket(raw, server_hostname=HOST)  # SNI required by Cloudflare
    except Exception:
        raw.close()
        raise
    # keep `raw` so serve() can select.poll() it — MicroPython's SSLSocket has no .settimeout()
    key = binascii.b2a_base64(os.urandom(16)).strip().decode()
    req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n") % (PATH, HOST, key)
    s.write(req.encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        feed()
        c = s.read(1)
        if not c:
            break
        resp += c
    ok = b" 101 " in resp
    print("handshake:", "OK" if ok else "FAIL", resp.split(b"\r\n")[0])
    if not ok:
        for x in (s, raw):
            try:
                x.close()
            except Exception:
                pass
        return (None, None)
    return (s, raw)

def send_text(s, txt):
    p = txt.encode()
    n = len(p)
    mask = os.urandom(4)
    if n < 126:
        hdr = bytes([0x81, 0x80 | n])
    else:
        hdr = bytes([0x81, 0x80 | 126, (n >> 8) & 0xFF, n & 0xFF])
    mp = bytearray(n)
    for i in range(n):
        mp[i] = p[i] ^ mask[i & 3]
    s.write(hdr + mask + bytes(mp))

def recvn(s, n):
    b = b""
    while len(b) < n:
        feed()
        c = s.read(n - len(b))
        if not c:
            return None
        b += c
    return b

def _frame_after(s, b0):                # read the rest of a frame given its already-read first byte (blocking)
    b1 = recvn(s, 1)
    if not b1:
        return (None, None)
    op = b0[0] & 0x0F
    ln = b1[0] & 0x7F
    if ln == 126:
        e = recvn(s, 2); ln = (e[0] << 8) | e[1]
    elif ln == 127:
        e = recvn(s, 8); ln = 0
        for b in e:
            ln = (ln << 8) | b
    masked = b1[0] & 0x80
    mask = recvn(s, 4) if masked else None
    pl = recvn(s, ln) if ln else b""
    if masked and pl:
        pl = bytes(pl[i] ^ mask[i & 3] for i in range(ln))
    return (op, pl)

# ---- motor lanes ----
def apply_pose(l, r):                   # WALK lane: direct latest-wins write
    board.servoWrite(L_PORT, int(max(0, min(180, l))))
    board.servoWrite(R_PORT, int(max(0, min(180, r))))

def _act_write(l, r):                   # GESTURE lane: act_engine's hands
    board.servoWrite(L_PORT, l); board.servoWrite(R_PORT, r)
def _act_release():
    board.release(L_PORT); board.release(R_PORT)
eng = ActEngine(_act_write, _act_release, time.ticks_ms, time.ticks_diff)
ROUTINES = {"wiggle": [{"l": 60, "r": 120, "ms": 400}, {"l": 120, "r": 60, "ms": 400},
                       {"l": 60, "r": 120, "ms": 400}, {"l": 120, "r": 60, "ms": 400},
                       {"l": 90, "r": 90, "ms": 300}]}

def _handle(s, pl):
    """Dispatch one text frame. Returns the lane kind so serve() can manage the dead-man."""
    try:
        m = json.loads(pl)
    except Exception:
        return None
    t = m.get("t")
    if t == "pose":
        eng.clear()                                     # walk owns the legs; next gesture cold-starts
        try:
            ls, rs = m.get("lr", "90,90").split(",")
            apply_pose(float(ls), float(rs))
        except Exception:
            pass
        if "seq" in m:                                  # latency-probe echo (tools only)
            send_text(s, json.dumps({"t": "ack", "seq": m["seq"], "ts": m.get("ts", 0)}))
        return "pose"
    if t == "act":
        ok, q = eng.enqueue(m.get("steps", []), m.get("mode", "replace"))
        send_text(s, json.dumps({"t": "ack", "rid": m.get("rid"), "ok": 1 if ok else 0,
                                 "queued_ms": (q if ok else 0)}))
        return "act"
    if t == "routine":
        ok, q = eng.enqueue(ROUTINES.get(m.get("name", ""), []), "replace")
        send_text(s, json.dumps({"t": "ack", "rid": m.get("rid"), "ok": 1 if ok else 0,
                                 "queued_ms": (q if ok else 0)}))
        return "act"
    if t == "stop":
        eng.clear(); _act_release()
        send_text(s, json.dumps({"t": "ack", "rid": m.get("rid"), "ok": 1, "queued_ms": 0}))
        return "stop"
    return None

def serve(s, raw):
    global _wdt
    poll = select.poll(); poll.register(raw, select.POLLIN)   # poll the RAW fd; SSL reads stay blocking
    send_text(s, json.dumps({"t": "hello", "id": DEVID}))
    print("hello sent; walk + gesture lanes ready (dead-man %dms)" % DEADMAN_MS)
    if _wdt is None:
        _wdt = machine.WDT(timeout=WDT_MS)              # last-resort self-heal: reboots a truly frozen
        print("hw watchdog armed (%dms)" % WDT_MS)      # chip; from here on every path must feed()
    eng.clear()
    walk_on = False
    now = time.ticks_ms()
    last_pose = now; last_rx = now; last_ping = now
    n = 0; nlast = 0; last = now
    while True:
        feed()
        # wait up to POLL_MS for a frame to START (so the act engine keeps ticking between frames).
        # MicroPython's SSLSocket has NO .settimeout(); poll the RAW fd for readability instead and keep
        # every SSL read blocking — once poll says readable, the bytes are already here so reads return at once.
        b0 = None
        try:
            if poll.poll(POLL_MS):
                b0 = s.read(1)
        except OSError as e:                            # a real socket/ssl error → drop & let main() re-dial
            print("read err:", e); return
        if b0 == b"":                                   # empty read = relay closed the socket
            print("conn closed by relay"); return
        if b0:
            op, pl = _frame_after(s, b0)                # rest of the frame: blocking (s is always blocking now)
            if op is None or op == 0x8:
                print("conn closed by relay"); return
            last_rx = time.ticks_ms()                   # any frame (incl. pongs) proves the link is alive
            if op == 0x9:                               # ping -> pong
                s.write(bytes([0x8A, 0x80]) + os.urandom(4))
            elif op == 0x1:
                kind = _handle(s, pl)
                if kind == "pose":
                    walk_on = True; last_pose = time.ticks_ms()
                    n += 1
                    now = time.ticks_ms()
                    if time.ticks_diff(now, last) >= 1000:
                        print("poses", n, "rate", n - nlast, "Hz"); nlast = n; last = now
                elif kind in ("act", "stop"):
                    walk_on = False                     # the gesture lane owns the legs now
        else:
            # quiet tick: watch the LINK (the dead-man below guards the LEGS; this guards the SOCKET).
            # a brownout can drop WiFi with no FIN/RST — without this, serve() would spin forever deaf.
            now = time.ticks_ms()
            if not wlan.isconnected():
                print("wifi dropped"); return
            if time.ticks_diff(now, last_rx) > LINK_DEAD_MS:
                print("link dead: nothing heard for %ds, re-dialing" % (LINK_DEAD_MS // 1000)); return
            if time.ticks_diff(now, last_rx) > PING_MS and time.ticks_diff(now, last_ping) > PING_MS:
                s.write(bytes([0x89, 0x80]) + os.urandom(4))    # ping; the pong refreshes last_rx
                last_ping = now
        eng.tick()                                      # glide any queued gesture (~50Hz)
        if walk_on and not eng.active and time.ticks_diff(time.ticks_ms(), last_pose) > DEADMAN_MS:
            _act_release(); walk_on = False             # WALK dead-man: relax on silence
            print("dead-man: walk limp (silence)")

def main():
    sleep_fed(2000)                                     # let the WiFi radio settle on cold boot
    fails = 0
    while True:                                         # never give up: re-ensure wifi, re-dial the relay
        s = raw = None
        t0 = time.ticks_ms()
        try:
            if ensure_wifi():
                s, raw = ws_open()
                if s:
                    serve(s, raw)                       # only returns when the link died
                    if time.ticks_diff(time.ticks_ms(), t0) > 30000:
                        fails = 0                       # a session that lived a while = healthy link
        except Exception as e:
            print("loop err:", e)
        for x in (s, raw):                              # re-dialing is routine now — never leak sockets
            try:
                if x:
                    x.close()
            except Exception:
                pass
        eng.clear()
        try:
            _act_release()                              # offline = limp: no held torque on a stale pose
        except Exception:
            pass
        fails += 1
        if fails >= HARD_RESET_AFTER:
            print("self-heal: machine.reset()")         # = the power cycle users did by hand
            sleep_fed(200)
            machine.reset()
        if fails % WIFI_RESET_EVERY == 0:
            try:
                wifi_reset()
            except Exception as e:
                print("wifi reset err:", e)
        wait = min(30000, 1000 << min(fails, 5))        # backoff 2s,4s,8s,16s,30s cap
        print("re-dial in %ds (fail %d)" % (wait // 1000, fails))
        sleep_fed(wait)

def boot_calibration():
    # One-firmware build aid: a quick leg-check that ENDS with both legs at 90 (straight),
    # so on a first build you can glue the legs on straight. Confirms both legs move + the
    # L/R mapping, then leaves them at 90. Runs once on boot, before we dial the relay
    # (~8s; harmless on an already-built robot — it just stretches on power-up).
    board.servoWrite(L_PORT, 90); board.servoWrite(R_PORT, 90); sleep_fed(500)           # center
    for _ in range(2):                                                                   # RIGHT leg only
        board.servoWrite(R_PORT, 60); sleep_fed(220); board.servoWrite(R_PORT, 120); sleep_fed(220)
    board.servoWrite(R_PORT, 90)
    for _ in range(2):                                                                   # LEFT leg only
        board.servoWrite(L_PORT, 60); sleep_fed(220); board.servoWrite(L_PORT, 120); sleep_fed(220)
    board.servoWrite(L_PORT, 90)
    for _ in range(2):                                                                   # BOTH at once
        board.servoWrite(L_PORT, 55); board.servoWrite(R_PORT, 55); sleep_fed(260)
        board.servoWrite(L_PORT, 125); board.servoWrite(R_PORT, 125); sleep_fed(260)
    board.servoWrite(L_PORT, 90); board.servoWrite(R_PORT, 90); sleep_fed(2000)          # show straight (2s glue window on a first build)
    board.release(L_PORT); board.release(R_PORT)                                          # then LIMP — no held torque = no idle battery drain while it dials the relay

def _cold_boot():
    # machine.reset() and the hardware watchdog BOTH report WDT_RESET on rp2, so this
    # skips the calibration stretch on self-heal reboots and keeps it for real power-ups.
    try:
        return machine.reset_cause() != machine.WDT_RESET
    except Exception:
        return True

if _cold_boot():
    boot_calibration()
main()
