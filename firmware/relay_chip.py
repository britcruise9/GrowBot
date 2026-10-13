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
#     {"t":"hello","id","boot","caps"}                 chip handshake to the relay (boot = reset cause,
#                                                      uptime, build; caps ["hb"] = I send heartbeats)
#     '{"t":"hb"}' every HB_MS, exactly this text       the relay's edge answers '{"t":"hb_ack"}' itself
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

try:
    board = PicoRobotics.KitronikPicoRobotics()
except Exception:
    board = None
    print("motor driver unavailable; motion disabled")  # recovery must still be reachable
L_PORT, R_PORT = 1, 3
DEADMAN_MS = 500          # limp the WALK legs if no pose arrives for this long (matches the firmware)
POLL_MS = 20              # main-loop cadence: ticks the act engine ~50Hz and polls for frames

NET_TIMEOUT_S = 6         # bound on every socket op; must stay well under WDT_MS
PING_MS = 10000           # heartbeat cadence once the link has been quiet this long
# 0923 RELAY GHOST: a robot that lost power kept "connected" on the relay for 14-17 minutes, because
# nothing tells a relay that a socket died without a close. The hello now promises a heartbeat and
# says why this boot happened; the relay drops a chip that goes 45 s without one (relay/worker.js).
HB_MS = 15000
HB = '{"t":"hb"}'         # byte-exact: the relay's edge auto-answers only this exact text
FW_TAG = "travel-0929"
LINK_DEAD_MS = 25000      # quiet this long (= 2 unanswered pings) -> wedged, re-dial
WIFI_RESET_EVERY = 3      # straight failures between radio power-cycles
HARD_RESET_AFTER = 10     # straight failures before machine.reset() (~3-5 min of trying)
WDT_MS = 8000             # hardware watchdog period (rp2 hardware caps near 8.3s)
# 0923 HANG A/B. The radio's default power-saving can let an idle link miss frames while it still
# reports itself associated. Build A leaves the radio at its DEFAULT (what shipped before this);
# build B sets this False and turns power-saving off. It is the only line the two builds differ
# by, so a change in hangs between them can be put on this and nothing else. Not a fix until the
# two builds have been compared on the same robot, network and spot.
WIFI_POWERSAVE = True

wlan = network.WLAN(network.STA_IF)

try:
    _RESET_CAUSE = machine.reset_cause()
except Exception:
    _RESET_CAUSE = -1
# Counted since boot and reported in wifi_status. up_ms going DOWN between two replies means the
# chip rebooted; these tell a watcher what happened in between without a USB cable.
_link = {"joins": 0, "wifi_drops": 0, "link_dead": 0, "redials": 0}

def radio_pm():
    # Config does not survive the radio powering off, so this runs after EVERY start and every
    # join. Every relay session is preceded by ensure_wifi(), which calls it, so no session can
    # open with the setting unapplied. Build A (WIFI_POWERSAVE True) changes nothing at all.
    if WIFI_POWERSAVE:
        return
    try:
        wlan.config(pm=network.WLAN.PM_NONE)
    except Exception as e:
        print("pm config err:", e)

_wdt = None               # armed once in serve(); machine.WDT can NEVER be disarmed after
                          # that, so every path below must keep the feed()s flowing

def feed():
    if _wdt:
        _wdt.feed()

def sleep_fed(ms):        # sleep that keeps the hardware watchdog fed
    while ms > 0:
        feed(); time.sleep_ms(min(ms, 200)); ms -= 200

def _wifi_list():
    # 0830 MULTI-NETWORK (Brit, from the cafe where his robot sat wifi-homesick):
    # secrets.py may now carry  WIFI_NETWORKS = [("home-ssid","pw"), ("hotspot","pw"), ...]
    # Old single-network files (every flashed robot + the build-page writer) keep working:
    # WIFI_SSID + WIFI_PASSWORD/WIFI_PASS becomes a one-entry list. Order = preference.
    try:
        import secrets
    except Exception as e:
        print("wifi err", e); return []
    nets = []
    for pair in getattr(secrets, 'WIFI_NETWORKS', []) or []:
        try:
            nets.append((str(pair[0]), str(pair[1])))
        except Exception:
            pass
    _ss = getattr(secrets, 'WIFI_SSID', None)
    if _ss:
        _pw = getattr(secrets, 'WIFI_PASSWORD', None) or getattr(secrets, 'WIFI_PASS', '')
        if not any(n[0] == _ss for n in nets):
            nets.append((str(_ss), str(_pw)))
    return nets

def _visible_ssids():
    # one scan, watchdog-fed; returns {ssid: rssi}. A failed scan returns {} and the
    # caller just tries the list in order — scan is an optimization, never a gate.
    seen = {}
    try:
        feed()
        for ap in wlan.scan():
            try:
                name = ap[0].decode() if isinstance(ap[0], bytes) else str(ap[0])
                if name and (name not in seen or ap[3] > seen[name]):
                    seen[name] = ap[3]
            except Exception:
                pass
        feed()
    except Exception as e:
        print("scan err", e)
    return seen

def ensure_wifi(timeout_ms=None, scan_allowed=True, preferred=None):
    started = time.ticks_ms()
    wlan.active(True)
    radio_pm()
    if not wlan.isconnected():
        nets = _wifi_list()
        if nets:
            # CYW43 scan can block 10s, exceeding the armed 8s watchdog. Optional
            # scan only before arming; setup always permits exact manual SSIDs.
            vis = _visible_ssids() if scan_allowed and _wdt is None else {}
            # visible networks first (strongest first), invisible ones after (hidden SSIDs still get a shot)
            order = sorted([n for n in nets if n[0] in vis], key=lambda n: -vis[n[0]])                   + [n for n in nets if n[0] not in vis]
            if preferred is not None:
                order = [n for n in order if n[0] == preferred] + [n for n in order if n[0] != preferred]
            for index, (ssid, pw) in enumerate(order):
                if timeout_ms is not None and time.ticks_diff(time.ticks_ms(), started) >= timeout_ms:
                    break
                attempt_started = time.ticks_ms()
                budget = 15000 if timeout_ms is None else min(15000, max(100,
                    (timeout_ms - time.ticks_diff(attempt_started, started)) // (len(order) - index)))
                try:
                    wlan.connect(ssid, pw)
                except Exception as e:
                    print("wifi err", e); continue
                for _ in range(150):                    # up to ~15s each (cold-boot radio is slow)
                    if timeout_ms is not None and time.ticks_diff(time.ticks_ms(), started) >= timeout_ms:
                        break
                    if time.ticks_diff(time.ticks_ms(), attempt_started) >= budget:
                        break
                    if wlan.isconnected():
                        break
                    feed(); time.sleep_ms(100)
                if wlan.isconnected():
                    print("wifi: joined", ssid)
                    _link["joins"] += 1
                    radio_pm()
                    break
                try:
                    wlan.disconnect()                   # clean slate before the next candidate
                except Exception:
                    pass
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
    radio_pm()

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
    # keep `raw` so it can be closed; serve() polls the TLS object itself (see serve)
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
    if board is None:
        return
    board.servoWrite(L_PORT, int(max(0, min(180, l))))
    board.servoWrite(R_PORT, int(max(0, min(180, r))))

def _act_write(l, r):                   # GESTURE lane: act_engine's hands
    if board is None:
        return
    board.servoWrite(L_PORT, l); board.servoWrite(R_PORT, r)
def _act_release():
    if board is None:
        return
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
    if t == "wifi_status":
        rid = m.get("rid")
        if not isinstance(rid, int) or isinstance(rid, bool) or not 0 <= rid <= 2147483647:
            return None
        result = None
        try:
            from wifi_store import Store
            result = Store().result(wlan)
        except Exception:
            pass
        try:
            rssi = wlan.status("rssi")
        except Exception:
            rssi = None
        link = {"up_ms": time.ticks_ms(), "reset": _RESET_CAUSE, "pm": "default" if WIFI_POWERSAVE else "off", "rssi": rssi}
        link.update(_link)
        send_text(s, json.dumps({"t": "wifi_status", "rid": rid, "result": result, "link": link}))
        return None
    if board is None and t in ("pose", "act", "routine"):
        send_text(s, json.dumps({"t": "ack", "rid": m.get("rid"), "ok": 0, "error": "motor_unavailable"}))
        return None
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

def hello_msg():
    return json.dumps({"t": "hello", "id": DEVID, "caps": ["hb"],
                       "boot": {"reset": _RESET_CAUSE, "up_ms": time.ticks_ms(), "fw": FW_TAG}})

# 0923 TLS POLL (Codex review; MOTION BENCH read the v1.28.0 source). The RAW fd used to be polled and
# the TLS object read. A TLS record carrying TWO WebSocket frames leaves the second one decrypted inside
# mbedTLS while the raw fd reads empty, so it waited for the next packet, possibly forever. The TLS
# object's own poll counts that pending data (modtls_mbedtls.c, mbedtls_ssl_check_pending), so poll it.
# Once TLS has failed it answers NVAL on every poll: NVAL, ERR and HUP mean re-dial, never "readable".
POLL_DEAD = select.POLLERR | select.POLLHUP | getattr(select, "POLLNVAL", 0x20)

def serve(s, raw):
    global _wdt
    poll = select.poll(); poll.register(s, select.POLLIN)
    send_text(s, hello_msg())
    print("hello sent; walk + gesture lanes ready (dead-man %dms)" % DEADMAN_MS)
    if _wdt is None:
        _wdt = machine.WDT(timeout=WDT_MS)              # last-resort self-heal: reboots a truly frozen
        print("hw watchdog armed (%dms)" % WDT_MS)      # chip; from here on every path must feed()
    eng.clear()
    walk_on = False
    now = time.ticks_ms()
    last_pose = now; last_rx = now; last_ping = now; last_hb = now
    n = 0; nlast = 0; last = now
    while True:
        feed()
        # wait up to POLL_MS for a frame to START (so the act engine keeps ticking between frames).
        # Reads stay blocking under the raw socket's NET_TIMEOUT_S, so a half-arrived frame costs at
        # most that long and then errors into a re-dial.
        b0 = None
        try:
            ready = poll.poll(POLL_MS)
            if ready and ready[0][1] & POLL_DEAD:
                print("read err: poll", ready[0][1]); return
            if ready:
                b0 = s.read(1)
            if time.ticks_diff(time.ticks_ms(), last_hb) >= HB_MS:
                send_text(s, HB); last_hb = time.ticks_ms()
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
                _link["wifi_drops"] += 1
                print("wifi dropped"); return
            if time.ticks_diff(now, last_rx) > LINK_DEAD_MS:
                _link["link_dead"] += 1
                print("link dead: nothing heard for %ds, re-dialing" % (LINK_DEAD_MS // 1000)); return
            if time.ticks_diff(now, last_rx) > PING_MS and time.ticks_diff(now, last_ping) > PING_MS:
                s.write(bytes([0x89, 0x80]) + os.urandom(4))    # ping; the pong refreshes last_rx
                last_ping = now
        eng.tick()                                      # glide any queued gesture (~50Hz)
        if walk_on and not eng.active and time.ticks_diff(time.ticks_ms(), last_pose) > DEADMAN_MS:
            _act_release(); walk_on = False             # WALK dead-man: relax on silence
            print("dead-man: walk limp (silence)")

_recovery = None
_recovery_initialized = False
WIFI_RECOVERY_AFTER_MS = 75000

def _recovery_after_ms():
    # 0923: a robot installed with NO Wi-Fi (set it up from the phone) has nothing to wait 75 s
    # for, so its setup network opens straight away.
    return WIFI_RECOVERY_AFTER_MS if _wifi_list() else 0

def _prepare_recovery():
    # The setup page lists the names the robot can see, so nobody has to type one. The scan can
    # block ~10 s, longer than the watchdog allows, so it only runs while the watchdog is unarmed
    # (a power-on that never reached the relay: the cafe case). Armed = type the name, as before.
    _recovery.nearby = None
    if _wdt is None:
        try:
            wlan.active(True)
            radio_pm()
            seen = _visible_ssids()
            ranked = sorted(seen.items(), key=lambda kv: -kv[1])
            _recovery.nearby = [n for n, _ in ranked if not n.startswith("GrowBot-Setup-")][:15]
        except Exception as e:
            print("nearby scan err:", e)
    _recovery.retry = lambda ms: ensure_wifi(ms, scan_allowed=False)
    print("setup network opening; nearby names:", -1 if _recovery.nearby is None else len(_recovery.nearby))

def main():
    global _recovery, _recovery_initialized
    if not _recovery_initialized:
        _recovery_initialized = True
        try:
            from wifi_recovery import for_firmware
            _recovery = for_firmware(wlan, DEVID, feed, _act_release)
        except ImportError:
            pass  # legacy installation: no recovery module, existing retries remain
        except Exception:
            print("protected recovery unavailable")  # fail closed, no raw setup errors
    sleep_fed(2000)                                     # let the WiFi radio settle on cold boot
    fails = 0
    wifi_cycle = None
    route_fails = 0
    route_cursor = 0
    preferred = None
    while True:                                         # never give up: re-ensure wifi, re-dial the relay
        s = raw = None
        t0 = time.ticks_ms()
        try:
            eligible = _recovery is not None and _recovery.allowed
            if wlan.isconnected():
                wifi_cycle = None
            elif wifi_cycle is None:
                wifi_cycle = time.ticks_ms()
            after = _recovery_after_ms() if eligible else WIFI_RECOVERY_AFTER_MS
            remaining = None if not eligible else max(0, after - time.ticks_diff(time.ticks_ms(), wifi_cycle if wifi_cycle is not None else time.ticks_ms()))
            if remaining != 0 and ensure_wifi(remaining, scan_allowed=not eligible, preferred=preferred):
                preferred = None
                wifi_cycle = None
                s, raw = ws_open()
                if s:
                    serve(s, raw)                       # only returns when the link died
                    if time.ticks_diff(time.ticks_ms(), t0) > 30000:
                        fails = 0                       # a session that lived a while = healthy link
                        route_fails = -1
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
        if _recovery is not None and wlan.isconnected():
            # Stage-2 firmware: three failed relay attempts, with ordinary
            # backoff, earn one alternate saved route first on the next dial.
            # A healthy session resets this counter; relay loss alone never
            # opens the setup AP. Keep a working candidate saved throughout.
            route_fails += 1
            if route_fails >= 3:
                route_fails = 0
                try:
                    current = wlan.config("ssid")
                    if isinstance(current, bytes):
                        current = current.decode("utf-8")
                    alternatives = [n[0] for n in _wifi_list() if n[0] != current]
                    if alternatives:
                        preferred = alternatives[route_cursor % len(alternatives)]
                        route_cursor += 1
                        wlan.disconnect()
                except Exception:
                    pass
        if (_recovery is not None and _recovery.allowed and not wlan.isconnected()
                and wifi_cycle is not None and time.ticks_diff(time.ticks_ms(), wifi_cycle) >= _recovery_after_ms()):
            # This owns the radio, WDT and motor-limp interval. Ordinary bounce /
            # hard-reset escalation is suspended until the absolute window ends.
            _prepare_recovery()
            _recovery.run()
            fails = 0
            wifi_cycle = None
            continue
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
        _link["redials"] += 1
        print("re-dial in %ds (fail %d)" % (wait // 1000, fails))
        sleep_fed(wait)

def boot_calibration():
    if board is None:
        return
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
