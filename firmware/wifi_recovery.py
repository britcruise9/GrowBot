"""Protected offline Wi-Fi recovery for the explicit Pico firmware upgrade.

ENABLED (the validation flag below is on) for the Pico 2 W + MicroPython 1.28.0 that /build admits
(setup AP, captive DNS, join, and a real cafe join + rejoin proven on hardware 0920-0929).
No cloud dependency, open-AP fallback, credential query strings or motor API.
"""
import json
import os
import time
import binascii
from wifi_store import Store, JoinAttempt, WiFiError, _identifier, validate_network

# 0922: TRUE AT REST. With this False the served bytes give a robot NO recovery AP at all
# (for_firmware returns None), so a one-session install would have silently shipped a robot
# that can never raise its setup network. The flag now ships as it is tested.
HARDWARE_VALIDATED = True
# 0923 SIMPLE PASS (Brit's cafe test: "lots of buttons and panicking"). He used 8.5 of the 10
# minutes and the 2-minute session timed out while he typed. The window is now 30 minutes; the
# background retry below stops a longer window from stranding a robot that merely missed its
# home router at power-on (seen 0923 18:54: 75 s miss -> 13 min offline at home).
WINDOW_MS = 1800000
SESSION_MS = 600000
RETRY_MS = 180000         # with nobody on the setup network, re-try the saved networks this often
RETRY_HOME_MS = 60000     # ...and this often when the power-on scan SAW a saved network (0923 21:54:
                          # a battery swap missed home for 75 s, then sat 10 min in setup; home was right there)
RETRY_JOIN_MS = 15000     # AP is down for at most this long per retry
NEARBY_MAX = 15
AUTH_LOCK_MS = 30000
# MUST stay 192.168.4.1 on stock MicroPython. The cyw43 driver sets the AP address AND starts its
# DHCP server from the compile-time CYW43_DEFAULT_IP_AP_ADDRESS every time the AP is switched on
# (cyw43_lwip.c cyw43_cb_tcpip_init -> dhcp_server_init); an ifconfig() before active(True) is
# overwritten, and one after it leaves DHCP handing out 192.168.4.x with 192.168.4.1 as gateway and
# DNS. 0925: 4.3.2.1 (tried so Android would stop skipping its captive-portal probe for a private
# answer) made the setup network fail to start at all. Android's pop-up needs a custom build.
AP_ADDRESS = "192.168.4.1"
MAX_BODY = 1024
MAX_HEADERS = 2048
MAX_REQUEST_MS = 2000
ENROLLMENT = ".growbot-setup.json"
WINDOW_FILE = ".growbot-setup-window.json"


def _token(random_bytes):
    data = random_bytes(20)
    if not isinstance(data, bytes) or len(data) != 20 or data == b"\x00" * 20:
        raise WiFiError("RANDOM_UNAVAILABLE")
    return binascii.hexlify(data).decode()


def _same(left, right):
    if not isinstance(left, str) or not isinstance(right, str) or len(left) != len(right):
        return False
    difference = 0
    for a, b in zip(left.encode(), right.encode()):
        difference |= a ^ b
    return difference == 0


SETUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _setup_password(random_bytes):
    data = random_bytes(20)
    if not isinstance(data, bytes) or len(data) != 20 or data == b"\x00" * 20:
        raise WiFiError("RANDOM_UNAVAILABLE")
    # Twelve independent 5-bit symbols = 60 random bits. Hyphens are literal.
    text = "".join(SETUP_ALPHABET[b & 31] for b in data[:12])
    return text[:4] + "-" + text[4:8] + "-" + text[8:]


def enroll_usb(store, body_id, rotate=False, random_bytes=None):
    """Trusted USB only (the /build installer). Returns the setup card once, for the phone QR;
    nothing sends it over HTTP or the relay (the 0929 relay hand-over was removed in review)."""
    if not store.validated or not _identifier(body_id):
        raise WiFiError("HARDWARE_GATE")
    exists = False
    try:
        store.read(ENROLLMENT)
        exists = True
    except WiFiError as error:
        if error.code != "CONFIG_MISSING":
            raise
    if exists and rotate is not True:
        raise WiFiError("ALREADY_ENROLLED")
    secret = _setup_password(random_bytes or os.urandom)
    value = {"version": 2, "body_id": body_id, "secret": secret}
    store._replace(ENROLLMENT, json.dumps(value))
    return {"ssid": "GrowBot-Setup-" + body_id[-6:], "address": "http://" + AP_ADDRESS,
            "setup_key": secret, "body_id": body_id}


def read_enrollment(store, body_id):
    try:
        value = json.loads(store.read(ENROLLMENT))
        secret = value.get("secret", "")
        legacy = value.get("version") == 1 and isinstance(secret, str) and len(secret) == 40 and all(c in "0123456789abcdef" for c in secret)
        short = value.get("version") == 2 and isinstance(secret, str) and len(secret) == 14 and secret[4] == "-" and secret[9] == "-" and all(c in SETUP_ALPHABET for c in secret[:4] + secret[5:9] + secret[10:])
        if value.get("body_id") != body_id or not (legacy or short):
            return None
        return value
    except Exception:
        return None


REDIRECT = "REDIRECT"


def dns_answer(packet):
    """Captive DNS: every A question is answered with the setup address, so the phone's own
    connectivity check lands here and it opens this page by itself. None = drop the packet."""
    if not isinstance(packet, (bytes, bytearray)) or len(packet) < 12 or len(packet) > 512:
        return None
    flags = packet[2]
    if flags & 0x80 or (flags >> 3) & 0x0F:
        return None  # a response, or not a standard query
    if packet[4] != 0 or packet[5] != 1:
        return None  # exactly one question
    i = 12
    while True:
        if i >= len(packet):
            return None
        n = packet[i]
        if n == 0:
            break
        if n & 0xC0 or i + n + 1 > 12 + 255:
            return None
        i += n + 1
    end = i + 5
    if end > len(packet):
        return None
    qtype = (packet[i + 1] << 8) | packet[i + 2]
    qclass = (packet[i + 3] << 8) | packet[i + 4]
    answer = qtype == 1 and qclass == 1
    head = bytes(packet[0:2]) + bytes([0x84 | (flags & 0x01), 0x80, 0, 1, 0, 1 if answer else 0, 0, 0, 0, 0])
    body = bytes(packet[12:end])
    if answer:
        body += b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x0a\x00\x04" + bytes([int(x) for x in AP_ADDRESS.split(".")])
    return head + body


def parse_request(raw):
    """Strict bounded HTTP/1 request parser; no chunking, duplicate headers or URLs."""
    if not isinstance(raw, bytes) or len(raw) > MAX_HEADERS + MAX_BODY + 4:
        raise WiFiError("BAD_REQUEST")
    parts = raw.split(b"\r\n\r\n", 1)
    if len(parts) != 2 or len(parts[0]) > MAX_HEADERS:
        raise WiFiError("BAD_REQUEST")
    try:
        head = parts[0].decode("ascii").split("\r\n")
    except Exception:
        raise WiFiError("BAD_REQUEST")
    fields = head[0].split(" ")
    if len(fields) != 3 or fields[0] not in ("GET", "POST") or fields[2] not in ("HTTP/1.0", "HTTP/1.1"):
        raise WiFiError("BAD_REQUEST")
    method, target, _ = fields
    headers = {}
    for line in head[1:]:
        if ":" not in line or line[0:1] in (" ", "\t") or any(ord(c) < 32 and c != "\t" for c in line):
            raise WiFiError("BAD_REQUEST")
        name, value = line.split(":", 1)
        name = name.lower()
        if not name or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in name) or name in headers:
            raise WiFiError("BAD_REQUEST")
        headers[name] = value.strip()
    # A phone's connectivity check (connectivitycheck.gstatic.com, captive.apple.com, ...) is a
    # GET for another host. Redirecting it here is what makes the phone open this page by itself.
    # Only GETs: a POST for another host is still refused below.
    if method == "GET" and headers.get("host") not in (AP_ADDRESS, AP_ADDRESS + ":80"):
        raise WiFiError(REDIRECT)
    if target not in ("/", "/auth", "/networks", "/connect", "/result", "/cancel"):
        raise WiFiError("NOT_FOUND")
    if "transfer-encoding" in headers or headers.get("host") not in (AP_ADDRESS, AP_ADDRESS + ":80"):
        raise WiFiError("BAD_ORIGIN")
    if headers.get("origin", "http://" + AP_ADDRESS) != "http://" + AP_ADDRESS:
        raise WiFiError("BAD_ORIGIN")
    length = headers.get("content-length", "0")
    if not length.isdigit() or int(length) > MAX_BODY or len(parts[1]) != int(length):
        raise WiFiError("BAD_REQUEST")
    payload = {}
    if method == "POST":
        if headers.get("origin") != "http://" + AP_ADDRESS or headers.get("content-type", "").split(";")[0].strip() != "application/json":
            raise WiFiError("BAD_ORIGIN")
        try:
            payload = json.loads(parts[1])
        except Exception:
            raise WiFiError("BAD_REQUEST")
        if not isinstance(payload, dict):
            raise WiFiError("BAD_REQUEST")
    elif parts[1]:
        raise WiFiError("BAD_REQUEST")
    return method, target, headers, payload


class Recovery:
    def __init__(self, store, wlan, ap, body_id, security, cold_boot,
                 feed=None, release=None, now=None, diff=None, random_bytes=None, validated=False, reset=None):
        self.store = store
        self.wlan = wlan
        self.ap = ap
        self.body_id = body_id
        self.security = security
        self.feed = feed or (lambda: None)
        self.release = release or (lambda: None)
        self.now = now or time.ticks_ms
        self.diff = diff or time.ticks_diff
        self.random = random_bytes or os.urandom
        self.reset = reset
        self._shutdown_failed = False
        self.enrollment = read_enrollment(store, body_id)
        self.allowed = validated is True and store.validated and cold_boot is True and self.enrollment is not None and security is not None
        self.state = "idle"
        self.started = 0
        self.session = None
        self.csrf = None
        self.session_t = 0
        self.auth_failures = 0
        self.locked_t = None
        self.queued = None
        self.join = JoinAttempt(store, wlan, self.now, self.diff, self.feed, restore_on_failure=False)
        self.server = None
        self.dns = None
        self.error = None
        # Set by the firmware just before run(): names the robot could see (None = no scan was
        # possible, the watchdog was armed) and a bounded join of the saved networks.
        self.nearby = None
        self.retry = None
        self.visited = False
        self.last_retry = 0
        self.minted = []          # attempt ids handed out in THIS window (see /result)
        self.home_seen = None
        # A damaged reset marker is never interpreted as permission to expose AP.
        try:
            mark = json.loads(store.read(WINDOW_FILE))
            if mark.get("version") != 1 or mark.get("used") is not True:
                self.allowed = False
        except WiFiError as error:
            if error.code != "CONFIG_MISSING":
                self.allowed = False
        except Exception:
            self.allowed = False

    def _tick(self):
        self.feed()
        self.release()

    def expired(self):
        return self.state != "idle" and self.diff(self.now(), self.started) >= WINDOW_MS

    def _close_ap(self):
        for name in ("server", "dns"):
            sock = getattr(self, name)
            if sock is not None:
                try:
                    sock.close()
                except Exception:
                    pass
                setattr(self, name, None)
        try:
            self.ap.active(False)
        except Exception:
            self.error = "AP_SHUTDOWN"
            if not self._shutdown_failed:
                self._shutdown_failed = True
                if self.reset is not None:
                    self.reset()  # WDT-class reset cannot reopen the consumed window
            raise WiFiError("AP_SHUTDOWN")
        self.session = self.csrf = None

    def _open_ap(self):
        self._tick()
        if self.expired():
            self.finish("expired")
            return False
        try:
            self.wlan.disconnect()
            self.wlan.active(False)
            self.ap.active(False)
            self.ap.config(ssid="GrowBot-Setup-" + self.body_id[-6:], security=self.security, password=self.enrollment["secret"])
            if self.ap.config("security") != self.security:
                raise WiFiError("AP_SECURITY")
            self.ap.ifconfig((AP_ADDRESS, "255.255.255.0", AP_ADDRESS, AP_ADDRESS))
            self.ap.active(True)
            if not self.ap.active() or self.ap.config("security") != self.security or self.ap.ifconfig()[0] != AP_ADDRESS:
                raise WiFiError("AP_SECURITY")
            self.state = "setup"
            return True
        except Exception:
            self.error = "AP_SECURITY"
            self.finish("failed")
            return False

    def start(self):
        if not self.allowed or self.state != "idle" or self.wlan.isconnected():
            return False
        self.allowed = False  # one window per actual cold boot; no same-boot rearm
        self.started = self.now()
        self.state = "opening"
        try:
            # Persist consumption BEFORE AP activation. WDT/software reset must
            # never turn a half-completed activation into a fresh setup window.
            self.store._replace(WINDOW_FILE, json.dumps({"version": 1, "used": True}))
        except Exception:
            self.error = "WINDOW_STORAGE"
            self.finish("failed")
            return False
        return self._open_ap()

    def finish(self, state):
        self._close_ap()
        if self.join.state == "checking":
            self.join.cancel(self.join.attempt_id)
        self.queued = None
        self.session = self.csrf = None
        self.state = state
        self._tick()

    def _authenticated(self, headers, mutate=False):
        if self.session is None or self.diff(self.now(), self.session_t) >= SESSION_MS:
            self.session = self.csrf = None
            return False
        if not _same(headers.get("x-setup-session"), self.session):
            return False
        if mutate and not _same(headers.get("x-setup-csrf"), self.csrf):
            return False
        self.session_t = self.now()
        return True

    def request(self, raw):
        """Returns (status, JSON object or None for local HTML); no raw exceptions."""
        self._tick()
        if self.expired():
            self.finish("expired")
        if self.state != "setup":
            return 410, {"error": "SETUP_CLOSED"}
        try:
            method, target, headers, body = parse_request(raw)
            if method == "GET" and target == "/":
                return 200, None
            if method == "POST" and target == "/auth":
                if self.locked_t is not None and self.diff(self.now(), self.locked_t) < AUTH_LOCK_MS:
                    return 429, {"error": "TRY_LATER"}
                # New enrollment: possession of the protected AP password is the
                # first factor. AP-only operation plus strict Host/Origin/JSON
                # checks admit the local page; session and CSRF stay required.
                wifi_access = self.enrollment.get("version") == 2 and body.get("use_wifi_access") is True
                if not wifi_access and not _same(body.get("setup_key"), self.enrollment["secret"]):
                    self.auth_failures += 1
                    if self.auth_failures >= 5:
                        self.locked_t = self.now()
                        self.auth_failures = 0
                    return 401, {"error": "AUTH_REQUIRED"}
                session = _token(self.random)
                csrf = _token(self.random)
                attempt = _token(self.random)
                if len(set((session, csrf, attempt))) != 3:
                    raise WiFiError("RANDOM_UNAVAILABLE")
                self.session = session
                self.csrf = csrf
                self.session_t = self.now()
                self.minted = (self.minted + [attempt])[-32:]
                self.auth_failures = 0
                return 200, {"session": self.session, "csrf": self.csrf, "body_id": self.body_id,
                             "attempt_id": attempt,
                             "remaining_ms": max(0, WINDOW_MS - self.diff(self.now(), self.started)), "scan": self._scan_kind()}
            if not self._authenticated(headers, method == "POST"):
                return 401, {"error": "AUTH_REQUIRED"}
            if method == "GET" and target == "/networks":
                return 200, {"saved": [{"ssid": item[0]} for item in self.store.networks()],
                             "nearby": list(self.nearby or []), "scan": self._scan_kind()}
            if method == "GET" and target == "/result":
                # 0925: only a result from THIS setup window. The file outlives reboots, so a fresh page
                # greeted Brit with "Wrong password" from a try made an hour and a reboot earlier.
                result = self.store.result(self.wlan)
                if not result or result.get("attempt_id") not in self.minted:
                    result = None
                return 200, {"result": result}
            if method == "POST" and target == "/cancel":
                self.queued = {"cancel": True}
                return 200, {"state": "closing"}
            if method == "POST" and target == "/connect":
                if self.queued is not None:
                    return 409, {"error": "BUSY"}
                validate_network(body.get("ssid"), body.get("password"))
                if not _identifier(body.get("attempt_id")) or body["attempt_id"] in self.join.seen:
                    raise WiFiError("INVALID_ATTEMPT")
                # Validate format/merge/capacity BEFORE radio handoff or acknowledgement.
                from wifi_store import replacement
                replacement(self.store.read(), body["ssid"], body["password"], body.get("update", False))
                self.queued = {"ssid": body["ssid"], "password": body["password"],
                               "attempt_id": body["attempt_id"], "update": body.get("update", False)}
                return 202, {"state": "accepted", "attempt_id": body["attempt_id"]}
            return 404, {"error": "NOT_FOUND"}
        except WiFiError as error:
            if error.code == REDIRECT:
                return 302, REDIRECT
            if error.code == "RANDOM_UNAVAILABLE":
                self.error = error.code
                self.finish("failed")
            return 400, {"error": error.code}
        except Exception:
            return 400, {"error": "BAD_REQUEST"}

    def _scan_kind(self):
        return "manual_only" if self.nearby is None else "nearby"

    def _home_nearby(self):
        """None = unknown (no scan), else whether any saved network was seen at power-on."""
        if self.nearby is None:
            return None
        try:
            return any(item[0] in self.nearby for item in self.store.networks())
        except Exception:
            return None

    def _retry_due(self):
        # Never while a person is on the setup network, and never when the power-on scan saw
        # none of the saved networks (a cafe: retrying would only drop the phone mid-setup).
        if self.retry is None or self.visited or self.state != "setup" or self.home_seen is False:
            return False
        every = RETRY_HOME_MS if self.home_seen is True else RETRY_MS
        return self.diff(self.now(), self.last_retry or self.started) >= every

    def _retry_saved(self):
        self._close_ap()
        self.state = "retrying"
        joined = False
        try:
            joined = self.retry(RETRY_JOIN_MS) is True and self.wlan.isconnected()
        except Exception:
            joined = False
        self.last_retry = self.now()
        if joined:
            self.finish("rejoined")
        else:
            self._open_ap()

    def _serve_dns(self):
        if self.dns is None:
            return
        for _ in range(4):
            try:
                packet, peer = self.dns.recvfrom(512)
            except Exception:
                return
            self.visited = True
            reply = dns_answer(packet)
            if reply is not None:
                try:
                    self.dns.sendto(reply, peer)
                except Exception:
                    return

    def step(self):
        self._tick()
        if self.expired():
            self.finish("expired")
            return
        if self.queued is not None:
            work = self.queued
            self.queued = None
            self._close_ap()  # called only AFTER the HTTP acknowledgement was sent
            if work.get("cancel"):
                self.finish("cancelled")
                return
            self.state = "checking"
            try:
                self.join.begin(work)
            except WiFiError as error:
                self.error = error.code
                self._open_ap()
            return
        if self.state == "checking":
            result = self.join.poll(self.join.attempt_id)
            if result["state"] == "remembered":
                self.finish("remembered")
            elif result["state"] == "saved":
                self.finish("saved")        # the main loop keeps trying it (see wifi_store JOIN_TRIES)
            elif result["state"] in ("failed", "cancelled"):
                try:
                    self.store.record_result(self.join.attempt_id, None, result["state"], result["error"])
                except Exception:
                    self.error = "RESULT_STORAGE"
                    self.finish("failed")
                    return
                self._open_ap()

    def _receive(self, client):
        data = b""
        started = self.now()
        target = None
        while self.diff(self.now(), started) < MAX_REQUEST_MS:
            self._tick()
            chunk = client.recv(256)
            if self.diff(self.now(), started) >= MAX_REQUEST_MS:
                raise WiFiError("REQUEST_TIMEOUT")
            if not chunk:
                raise WiFiError("BAD_REQUEST")
            data += chunk
            if len(data) > MAX_HEADERS + MAX_BODY + 4:
                raise WiFiError("BAD_REQUEST")
            if b"\r\n\r\n" in data and target is None:
                head, body = data.split(b"\r\n\r\n", 1)
                if len(head) > MAX_HEADERS:
                    raise WiFiError("BAD_REQUEST")
                length = 0
                for row in head.split(b"\r\n")[1:]:
                    if row.lower().startswith(b"content-length:"):
                        length = int(row.split(b":", 1)[1].strip())
                if not 0 <= length <= MAX_BODY:
                    raise WiFiError("BAD_REQUEST")
                target = len(head) + 4 + length
            if target is not None and len(data) >= target:
                return data
        raise WiFiError("REQUEST_TIMEOUT")

    def _send(self, client, status, body, html=None):
        if body == REDIRECT:
            data = ("HTTP/1.1 302 Found\r\nLocation: http://%s/\r\nContent-Length: 0\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n" % AP_ADDRESS).encode()
            return self._write(client, data)
        payload = html if body is None else json.dumps(body).encode()
        if payload is None:
            raise WiFiError("ASSET_MISSING")
        kind = "text/html; charset=utf-8" if body is None else "application/json"
        header = ("HTTP/1.1 %d Response\r\nContent-Type: %s\r\nContent-Length: %d\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'\r\n\r\n" % (status, kind, len(payload))).encode()
        return self._write(client, header + payload)

    def _write(self, client, data):
        started = self.now()
        offset = 0
        while offset < len(data):
            self._tick()
            if self.diff(self.now(), started) >= MAX_REQUEST_MS:
                raise WiFiError("REQUEST_TIMEOUT")
            count = client.send(data[offset:offset + 512])
            if self.diff(self.now(), started) >= MAX_REQUEST_MS:
                raise WiFiError("REQUEST_TIMEOUT")
            if not count:
                raise WiFiError("CONNECTION_CLOSED")
            offset += count

    def run(self, socket_module=None, sleep=None, html=None):
        try:
            return self._run(socket_module, sleep, html)
        except Exception:
            self.error = self.error or "RECOVERY_IO"
            self.state = "failed"
            return self.state
        finally:
            self.queued = None
            self.session = self.csrf = None
            self._close_ap()

    def _run(self, socket_module=None, sleep=None, html=None):
        if not self.start():
            return self.state
        self.home_seen = self._home_nearby()
        if socket_module is None:
            import socket as socket_module
        sleep = sleep or time.sleep_ms
        if html is None:
            try:
                with self.store.open(self.store.path("wifi-recovery.html"), "rb") as stream:
                    html = stream.read(16385)
                if len(html) > 16384 or b"<html" not in html.lower():
                    raise WiFiError("ASSET_MISSING")
            except Exception:
                self.error = "ASSET_MISSING"
                self.finish("failed")
        try:
            while self.state in ("setup", "checking"):
                self.step()
                if self.state != "setup":
                    sleep(100)
                    continue
                if self._retry_due():
                    self._retry_saved()
                    continue
                if self.server is None:
                    self.server = socket_module.socket()
                    self.server.setsockopt(socket_module.SOL_SOCKET, socket_module.SO_REUSEADDR, 1)
                    self.server.bind((AP_ADDRESS, 80))
                    self.server.listen(1)
                    self.server.settimeout(0.2)
                    try:
                        self.dns = socket_module.socket(socket_module.AF_INET, socket_module.SOCK_DGRAM)
                        self.dns.bind((AP_ADDRESS, 53))
                        self.dns.settimeout(0)
                    except Exception:
                        # No pop-up without it; http://192.168.4.1 still works by hand.
                        if self.dns is not None:
                            try:
                                self.dns.close()
                            except Exception:
                                pass
                        self.dns = None
                self._serve_dns()
                client = None
                try:
                    client, _ = self.server.accept()
                    self.visited = True
                    client.settimeout(0.4)
                    status, body = self.request(self._receive(client))
                    self._send(client, status, body, html)
                except Exception:
                    # A lost acknowledgement must not start a radio handoff.
                    self.queued = None
                finally:
                    if client is not None:
                        try:
                            client.close()
                        except Exception:
                            pass
        except Exception:
            self.error = "RECOVERY_IO"
            self.finish("failed")
        finally:
            self._close_ap()
        return self.state


def for_firmware(wlan, body_id, feed, release, validated=None):
    """Feature admission: no AP object or setup window on unvalidated firmware."""
    enabled = HARDWARE_VALIDATED if validated is None else validated is True
    if not enabled:
        return None
    import machine
    import network
    import sys
    board = str(getattr(sys.implementation, "_machine", "")).lower()
    if sys.platform != "rp2" or tuple(sys.implementation.version[:3]) != (1, 28, 0) or "pico 2 w" not in board:
        return None
    # Exactly PWRON, not merely "anything other than WDT". A software reset may
    # not reopen setup. Actual brownout-vs-intent cannot be inferred from PWRON.
    cold = machine.reset_cause() == machine.PWRON_RESET
    security = getattr(network.WLAN, "SEC_WPA_WPA2", None)
    return Recovery(Store(validated=True), wlan, network.WLAN(network.AP_IF), body_id, security,
                    cold, feed=feed, release=release, validated=True, reset=machine.reset)
