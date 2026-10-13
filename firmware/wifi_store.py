"""GrowBot Wi-Fi configuration and ephemeral USB helper, protocol GB_WIFI1.

Hardware validation is declared in this file (USB_HARDWARE_VALIDATED), never patched in transit.
No import of main.py, no code-file writes, no secret-bearing response or error.
The same Store/JoinAttempt runs in USB RAM and the separate recovery firmware.
"""
import json
import os
import sys
import time
import hashlib
import binascii

# 0922: TRUE AT REST, on purpose. This was False here and flipped by the installer in the
# bytes it downloaded, which meant the firmware a tester ran was not the firmware anyone
# reviewed. The flag is now part of the reviewed artifact; hardware evidence is tracked in the
# release notes, not by patching a file on its way to the board.
USB_HARDWARE_VALIDATED = True
PROTOCOL = "GB_WIFI1"
MAX_CONFIG = 16384
MAX_NETWORKS = 8
JOIN_MS = 15000
# 0925 (Brit's desk tests): a home router refused the association with the RIGHT password, twice,
# three quick tries each time, and nothing was saved. The same router always joins from ensure_wifi,
# which ignores a failed status, waits the full time on each try and power-cycles the radio between
# tries. The phone path now does the same: a failed status only ends a try once it has lasted
# JOIN_BAD_MS (a transient one at the start does not), then the radio is bounced for JOIN_BOUNCE_MS
# and the network is tried again, JOIN_TRIES times in all. A wrong password (BAD_AUTH) ends it at once.
JOIN_TRIES = 4
# ...and when the router still refuses the association (-1, the network WAS seen and the password was
# never rejected), a NEW network is SAVED anyway and the robot keeps trying it from its normal loop.
# An already-saved name is never replaced on -1 (0929 review: some routers, seen 0920, report a
# WRONG password as -1, so a typo would overwrite a password that works); that try fails instead.
# Measured 0925: after a sudden power cut his router refuses the robot for about 12 minutes, and
# every desk test began with one, so a one-minute phone join could only fail. -2 (not found) and
# -3 (wrong password) are never saved.
JOIN_BAD_MS = 3000
JOIN_BOUNCE_MS = 1000
BEGIN = "# BEGIN GROWBOT WIFI V1"
END = "# END GROWBOT WIFI V1"


class WiFiError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _fail(code):
    raise WiFiError(code)


def _identifier(value, maximum=64):
    return isinstance(value, str) and 1 <= len(value) <= maximum and all(
        c in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in value)


def validate_network(ssid, password):
    if not isinstance(ssid, str) or not isinstance(password, str):
        _fail("INVALID_NETWORK")
    try:
        size = len(ssid.encode("utf-8"))
        key = password.encode("utf-8")
    except Exception:
        _fail("INVALID_ENCODING")
    if not 1 <= size <= 32 or "\x00" in ssid:
        _fail("INVALID_SSID")
    # Initial support: WPA/WPA2 personal passphrases only. No enterprise, open AP,
    # binary SSIDs or unvalidated raw 64-hex PSK path. Do not trim either value.
    if not 8 <= len(key) <= 63 or any(b < 32 or b > 126 for b in key):
        _fail("UNSUPPORTED_PASSWORD")
    return (ssid, password)


class _Literals:
    """Restricted literals/assignments, not Python eval and not regex rewriting."""
    def __init__(self, source):
        self.s = source
        self.i = 0

    def space(self):
        while self.i < len(self.s):
            if self.s[self.i].isspace():
                self.i += 1
            elif self.s[self.i] == "#":
                while self.i < len(self.s) and self.s[self.i] != "\n":
                    self.i += 1
            else:
                break

    def word(self):
        start = self.i
        while self.i < len(self.s) and self.s[self.i] in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_":
            self.i += 1
        return self.s[start:self.i]

    def string(self):
        quote = self.s[self.i]
        self.i += 1
        out = []
        aliases = {"a": "\a", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v", "\\": "\\", "'": "'", '"': '"'}
        while self.i < len(self.s):
            char = self.s[self.i]
            self.i += 1
            if char == quote:
                return "".join(out)
            if char in "\r\n":
                _fail("CUSTOM_CONFIG")
            if char == "\\":
                if self.i >= len(self.s):
                    _fail("CUSTOM_CONFIG")
                char = self.s[self.i]
                self.i += 1
                if char in aliases:
                    char = aliases[char]
                elif char in "xuU":
                    count = {"x": 2, "u": 4, "U": 8}[char]
                    digits = self.s[self.i:self.i + count]
                    if len(digits) != count or any(c not in "0123456789abcdefABCDEF" for c in digits):
                        _fail("CUSTOM_CONFIG")
                    self.i += count
                    try:
                        point = int(digits, 16)
                        if 0xD800 <= point <= 0xDFFF:
                            _fail("INVALID_ENCODING")
                        char = chr(point)
                    except WiFiError:
                        raise
                    except Exception:
                        _fail("INVALID_ENCODING")
                else:
                    _fail("CUSTOM_CONFIG")
            out.append(char)
        _fail("CUSTOM_CONFIG")

    def value(self, depth=0):
        if depth > 6:
            _fail("CUSTOM_CONFIG")
        self.space()
        if self.i >= len(self.s):
            _fail("CUSTOM_CONFIG")
        char = self.s[self.i]
        if char in "\"'":
            return self.string()
        if char in "[(":
            end = "]" if char == "[" else ")"
            self.i += 1
            items = []
            self.space()
            while self.i < len(self.s) and self.s[self.i] != end:
                if len(items) >= 128:
                    _fail("CUSTOM_CONFIG")
                items.append(self.value(depth + 1))
                self.space()
                if self.i < len(self.s) and self.s[self.i] == ",":
                    self.i += 1
                    self.space()
                elif self.i >= len(self.s) or self.s[self.i] != end:
                    _fail("CUSTOM_CONFIG")
            if self.i >= len(self.s):
                _fail("CUSTOM_CONFIG")
            self.i += 1
            return items if char == "[" else tuple(items)
        start = self.i
        if char in "+-":
            self.i += 1
        token = self.word()
        if self.i == start:
            _fail("CUSTOM_CONFIG")
        full = self.s[start:self.i]
        if token in ("True", "False", "None") and full == token:
            return {"True": True, "False": False, "None": None}[token]
        if token.isdigit():
            try:
                return int(full)
            except Exception:
                pass
        _fail("CUSTOM_CONFIG")

    def module(self):
        values = {}
        while True:
            self.space()
            if self.i >= len(self.s):
                return values
            name = self.word()
            if not name or not (name[0].isalpha() or name[0] == "_") or any(ord(c) > 127 for c in name) or name.startswith("__"):
                _fail("CUSTOM_CONFIG")
            while self.i < len(self.s) and self.s[self.i] in " \t":
                self.i += 1
            if self.i >= len(self.s) or self.s[self.i] != "=":
                _fail("CUSTOM_CONFIG")
            self.i += 1
            values[name] = self.value()
            while self.i < len(self.s) and self.s[self.i] in " \t\r":
                self.i += 1
            if self.i < len(self.s) and self.s[self.i] not in "#\n":
                _fail("CUSTOM_CONFIG")


def parse_config(source):
    if not isinstance(source, str):
        _fail("CUSTOM_CONFIG")
    try:
        size = len(source.encode("utf-8"))
    except Exception:
        _fail("INVALID_ENCODING")
    if size > MAX_CONFIG:
        _fail("CONFIG_TOO_LARGE")
    values = _Literals(source).module()
    # The restricted parser never executes code. Also require real Python
    # syntax: indentation or a newline after '=' must not leave a file that the
    # installed firmware cannot import. Bounded literals have already passed.
    try:
        compile(source, "secrets.py", "exec")
    except Exception:
        _fail("CUSTOM_CONFIG")
    # Only a complete pair of exact whole-line markers is managed; never search
    # string literal contents, and never accept nested/duplicate blocks.
    starts = []
    ends = []
    offset = 0
    for line in source.splitlines(True):
        if line.rstrip("\r\n") == BEGIN:
            starts.append(offset)
        if line.rstrip("\r\n") == END:
            ends.append(offset + len(line))
        offset += len(line)
    if starts or ends:
        if len(starts) != 1 or len(ends) != 1 or starts[0] >= ends[0]:
            _fail("CUSTOM_CONFIG")
        managed = source[starts[0]:ends[0]]
        if set(_Literals(managed).module()) != {"WIFI_NETWORKS"}:
            _fail("CUSTOM_CONFIG")
        base = source[:starts[0]] + source[ends[0]:]
    else:
        base = source
    networks = []
    listed = values.get("WIFI_NETWORKS", []) or []
    if not isinstance(listed, (list, tuple)):
        _fail("CUSTOM_CONFIG")
    for pair in listed:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2 or not all(isinstance(x, str) for x in pair):
            _fail("CUSTOM_CONFIG")
        networks.append((pair[0], pair[1]))
    ssid = values.get("WIFI_SSID")
    if ssid:
        password = values.get("WIFI_PASSWORD") or values.get("WIFI_PASS", "")
        if not isinstance(ssid, str) or not isinstance(password, str):
            _fail("CUSTOM_CONFIG")
        if not any(pair[0] == ssid for pair in networks):
            networks.append((ssid, password))
    unique = []
    for pair in networks:
        same = [old for old in unique if old[0] == pair[0]]
        if same and same[0] != pair:
            _fail("AMBIGUOUS_SSID")
        if not same:
            unique.append(pair)
    return base, unique


def replacement(source, ssid, password, update=False):
    pair = validate_network(ssid, password)
    base, networks = parse_config(source)
    exists = any(old[0] == ssid for old in networks)
    if exists and update is not True:
        _fail("UPDATE_REQUIRED")
    merged = [pair if old[0] == ssid else old for old in networks]
    if not exists:
        merged.append(pair)
    if len(merged) > MAX_NETWORKS:
        _fail("CAPACITY")
    # Emit Python-compatible strings directly: JSON's escaped surrogate pairs
    # would change a non-BMP SSID when secrets.py is later imported as Python.
    def quoted(value):
        out = '"'
        for char in value:
            if char in ('"', "\\"):
                out += "\\" + char
            elif ord(char) < 32:
                out += "\\u%04x" % ord(char)
            else:
                out += char
        return out + '"'
    literal = "[" + ", ".join("[" + quoted(a) + ", " + quoted(b) + "]" for a, b in merged) + "]"
    contents = base + ("" if base.endswith("\n") else "\n") + BEGIN + "\nWIFI_NETWORKS = " + literal + "\n" + END + "\n"
    if parse_config(contents)[1] != merged:
        _fail("VALIDATION")
    return contents


class Store:
    def __init__(self, root=".", validated=False, filesystem=None):
        self.root = root.rstrip("/") or "/"
        self.validated = validated is True
        self.fs = filesystem or os
        self.open = getattr(filesystem, "open", open) if filesystem is not None else open

    def path(self, name):
        return self.root + ("" if self.root == "/" else "/") + name

    def read(self, name="secrets.py"):
        try:
            with self.open(self.path(name), "rb") as stream:
                raw = stream.read(MAX_CONFIG + 1)
            if len(raw) > MAX_CONFIG:
                _fail("CONFIG_TOO_LARGE")
        except WiFiError:
            raise
        except OSError as error:
            number = getattr(error, "errno", None) or (error.args[0] if error.args else None)
            _fail("CONFIG_MISSING" if number == 2 else "CONFIG_READ")
        except Exception:
            _fail("CONFIG_READ")
        try:
            return raw.decode("utf-8")
        except Exception:
            _fail("CONFIG_ENCODING")

    def networks(self):
        return parse_config(self.read())[1]

    def _replace(self, name, contents):
        if not self.validated:
            _fail("HARDWARE_GATE")
        target = self.path(name)
        temporary = target + ".tmp"
        data = contents.encode("utf-8")
        if len(data) > MAX_CONFIG:
            _fail("CONFIG_TOO_LARGE")
        renamed = False
        try:
            with self.open(temporary, "wb") as stream:
                written = stream.write(data)
                if written != len(data):
                    _fail("WRITE_FAILED")
                if hasattr(stream, "flush"):
                    stream.flush()
            with self.open(temporary, "rb") as stream:
                if stream.read(MAX_CONFIG + 1) != data:
                    _fail("READBACK_FAILED")
            if hasattr(self.fs, "sync"):
                self.fs.sync()
            # LittleFS rename-over-existing, gated on actual board verification.
            # Never remove or truncate the old destination to make rename work.
            self.fs.rename(temporary, target)
            renamed = True
            if name == "secrets.py":
                # Both USB resume and recovery must import the committed file,
                # even if a later durability/readback check is inconclusive.
                try:
                    del sys.modules["secrets"]
                except KeyError:
                    pass
            if hasattr(self.fs, "sync"):
                self.fs.sync()
            if self.read(name) != contents:
                _fail("COMMIT_UNCONFIRMED")
        except WiFiError:
            raise
        except Exception:
            _fail("COMMIT_UNCONFIRMED" if renamed else "WRITE_FAILED")

    def commit(self, contents, expected):
        parse_config(contents)
        if self.read() != expected:
            _fail("CONFIG_CHANGED")
        self._replace("secrets.py.previous", expected)
        self._replace("secrets.py", contents)
        return True

    def restore(self):
        previous = self.read("secrets.py.previous")
        parse_config(previous)
        self._replace("secrets.py", previous)
        return True

    def record_result(self, attempt_id, ssid, state, error=None):
        # Private integrity tag: never returned through USB/relay/HTTP or logged.
        # A later config edit/restore cannot keep certifying the earlier commit.
        tag = binascii.hexlify(hashlib.sha256(self.read().encode("utf-8")).digest()).decode() if state in ("remembered", "saved") else None
        self._replace(".growbot-wifi-result.json", json.dumps({"version": 1, "attempt_id": attempt_id,
                      "ssid": ssid, "state": state, "error": error, "config_tag": tag}))

    def result(self, wlan=None):
        try:
            value = json.loads(self.read(".growbot-wifi-result.json"))
            if value.get("version") != 1 or not _identifier(value.get("attempt_id")) or value.get("state") not in ("remembered", "saved", "failed", "cancelled"):
                return None
            match = False
            if wlan is not None and wlan.isconnected():
                current = wlan.config("ssid")
                if isinstance(current, bytes):
                    current = current.decode("utf-8")
                match = current == value.get("ssid")
            error = value.get("error")
            known = (None, "NOT_JOINED_YET", "BAD_AUTH", "ASSOCIATION_FAILED", "CONNECTION_TIMEOUT", "CANDIDATE_MISMATCH", "CANCELLED", "WRITE_FAILED", "READBACK_FAILED", "COMMIT_UNCONFIRMED", "CONFIG_CHANGED", "CONFIG_READ", "CONFIG_MISSING", "CONFIG_ENCODING", "HARDWARE_GATE")
            if error not in known:
                return None
            remembered = value["state"] in ("remembered", "saved")
            if remembered:
                tag = binascii.hexlify(hashlib.sha256(self.read().encode("utf-8")).digest()).decode()
                remembered = tag == value.get("config_tag")
            return {"attempt_id": value["attempt_id"], "state": value["state"],
                    "remembered": remembered, "candidate_match": match,
                    "relay": "unverified", "error": error}
        except Exception:
            return None


class JoinAttempt:
    """Poll-driven candidate association. No DNS, scan, relay or sleeps; a failed association or a
    timeout is tried again up to JOIN_TRIES times, a rejected password never."""
    def __init__(self, store, wlan, now=None, diff=None, feed=None, timeout_ms=JOIN_MS, restore_on_failure=True):
        self.store = store
        self.wlan = wlan
        self.now = now or time.ticks_ms
        self.diff = diff or time.ticks_diff
        self.feed = feed or (lambda: None)
        self.timeout_ms = timeout_ms
        self.restore_on_failure = restore_on_failure
        self.state = "idle"
        self.attempt_id = None
        self.ssid = None
        self.contents = None
        self.original = None
        self.error = None
        self.started = 0
        self.ip = None
        self.password = None
        self.tries = 0
        self.bad_since = None
        self.resume_at = None
        self.last_bad = None
        self.seen = []
        self.fallback = []
        self.fallback_started = 0
        self.fallback_index = -1

    def service(self):
        """Advance prior-network restoration without blocking or rewriting credentials."""
        self.feed()
        if not self.fallback:
            return
        try:
            if self.wlan.isconnected():
                self.fallback = []
                return
            if self.fallback_index < 0 or self.diff(self.now(), self.fallback_started) >= JOIN_MS:
                self.fallback_index += 1
                if self.fallback_index >= len(self.fallback):
                    self.fallback = []
                    return
                self.wlan.disconnect()
                ssid, password = self.fallback[self.fallback_index]
                self.wlan.connect(ssid, password)
                self.fallback_started = self.now()
        except Exception:
            self.fallback_started = self.now() - JOIN_MS

    def status(self):
        match = False
        remembered = False
        try:
            current = self.wlan.config("ssid") if self.wlan.isconnected() else None
            if isinstance(current, bytes):
                current = current.decode("utf-8")
            match = self.state == "remembered" and current == self.ssid
            receipt = self.store.result(self.wlan) if self.state == "remembered" else None
            remembered = bool(receipt and receipt["attempt_id"] == self.attempt_id and receipt["remembered"])
        except Exception:
            pass
        return {"state": self.state, "attempt_id": self.attempt_id,
                "candidate_match": match, "remembered": remembered,
                "relay": "unverified", "ip": self.ip, "error": self.error}

    def begin(self, request):
        if self.state == "checking":
            _fail("BUSY")
        if not self.store.validated:
            _fail("HARDWARE_GATE")
        if not _identifier(request.get("attempt_id")):
            _fail("INVALID_ATTEMPT")
        if request["attempt_id"] in self.seen or len(self.seen) >= 32:
            _fail("REUSED_ATTEMPT")
        previous = self.store.result()
        if previous and previous["attempt_id"] == request["attempt_id"]:
            _fail("REUSED_ATTEMPT")
        source = self.store.read()
        contents = replacement(source, request.get("ssid"), request.get("password"), request.get("update", False))
        self.attempt_id = request["attempt_id"]
        self.seen.append(self.attempt_id)
        self.fallback = []
        self.ssid = request["ssid"]
        self.original = source
        self.contents = contents
        self.error = None
        self.ip = None
        self.started = self.now()
        self.state = "checking"
        self.password = request["password"]
        self.tries = 1
        self.bad_since = self.resume_at = self.last_bad = None
        self.feed()
        try:
            self.wlan.active(True)
            self.wlan.disconnect()
            self.wlan.connect(self.ssid, request["password"])
        except Exception:
            self._failed("ASSOCIATION_FAILED")
        return self.status()

    def _again(self):
        """End this try: bounce the radio and schedule the next one. False once the tries are used up."""
        if self.tries >= JOIN_TRIES or self.password is None or self.ssid is None:
            return False
        self.tries += 1
        try:
            self.wlan.disconnect()
        except Exception:
            pass
        try:
            self.wlan.active(False)
        except Exception:
            pass
        self.bad_since = None
        self.resume_at = self.now()
        return True

    def _give_up(self):
        # 0929 review P2-C: -1 is also what a WRONG password reads as on some routers (seen 0920).
        # Save-on-refuse is only for a NEW name; a typo must never replace a password that works.
        if self.last_bad == -1 and not self._already_saved():
            self._keep()
        else:
            self._failed("ASSOCIATION_FAILED" if self.last_bad is not None else "CONNECTION_TIMEOUT")

    def _already_saved(self):
        try:
            return any(n == self.ssid for n, _ in parse_config(self.original)[1])
        except Exception:
            return True  # unreadable: fail closed, save nothing

    def _keep(self):
        """Seen but refused, password never rejected: save it; the normal loop keeps trying it."""
        try:
            self.store.commit(self.contents, self.original)
            self.store.record_result(self.attempt_id, self.ssid, "saved", "NOT_JOINED_YET")
        except WiFiError as error:
            self._failed(error.code)
            return
        except Exception:
            self._failed("WRITE_FAILED")
            return
        self.state = "saved"
        self.error = "NOT_JOINED_YET"
        self.contents = self.original = None
        self.password = None

    def _resume(self):
        """The bounced radio comes back up and the same network is tried again."""
        try:
            self.wlan.active(True)
            self.wlan.connect(self.ssid, self.password)
        except Exception:
            return False
        self.resume_at = None
        self.started = self.now()
        return True

    def _failed(self, code):
        self.state = "failed"
        self.error = code
        self.password = None
        try:
            self.fallback = parse_config(self.original)[1][:MAX_NETWORKS] if self.original is not None and self.restore_on_failure else []
        except Exception:
            self.fallback = []
        self.fallback_index = -1
        self.contents = None
        self.original = None
        self.ssid = None
        try:
            self.wlan.disconnect()
        except Exception:
            pass
        self.service()

    def poll(self, attempt_id):
        if attempt_id != self.attempt_id:
            _fail("STALE_ATTEMPT")
        self.service()
        if self.state != "checking":
            return self.status()
        if self.resume_at is not None:
            if self.diff(self.now(), self.resume_at) >= JOIN_BOUNCE_MS and not self._resume():
                self._failed("ASSOCIATION_FAILED")
            return self.status()
        if self.diff(self.now(), self.started) >= self.timeout_ms:
            if not self._again():
                self._give_up()
            return self.status()
        try:
            status = self.wlan.status()
            if status == -3:
                self._failed("BAD_AUTH")
            elif status in (-1, -2):
                # not final on sight: ensure_wifi joins this same router by waiting it out
                self.last_bad = status
                if self.bad_since is None:
                    self.bad_since = self.now()
                elif self.diff(self.now(), self.bad_since) >= JOIN_BAD_MS and not self._again():
                    self._give_up()
            elif not self.wlan.isconnected():
                self.bad_since = None
            elif self.wlan.isconnected():
                joined = self.wlan.config("ssid")
                if isinstance(joined, bytes):
                    joined = joined.decode("utf-8")
                ip = self.wlan.ifconfig()[0]
                if joined != self.ssid:
                    self._failed("CANDIDATE_MISMATCH")
                elif not ip or ip == "0.0.0.0":
                    return self.status()
                else:
                    self.store.commit(self.contents, self.original)
                    self.store.record_result(self.attempt_id, self.ssid, "remembered")
                    self.state = "remembered"
                    self.ip = ip
                    self.contents = self.original = None
                    self.password = None
        except WiFiError as error:
            self._failed(error.code)
        except Exception:
            self._failed("ASSOCIATION_FAILED")
        return self.status()

    def cancel(self, attempt_id):
        if self.attempt_id is not None and attempt_id != self.attempt_id:
            _fail("STALE_ATTEMPT")
        if self.state == "checking":
            self._failed("CANCELLED")
            self.state = "cancelled"
        return self.status()


class USBSetup:
    """Construct after raw-REPL interruption: USBSetup(the_installed_main_globals)."""
    def __init__(self, installed, store=None, now=None, diff=None, validated=None):
        self.installed = installed
        self.validated = USB_HARDWARE_VALIDATED if validated is None else validated is True
        self.store = store or Store(validated=self.validated)
        self.ready = all(key in installed for key in ("DEVID", "wlan", "feed", "_act_release", "eng", "main", "_wifi_list"))
        self.feed = installed.get("feed", lambda: None)
        self.join = JoinAttempt(self.store, installed.get("wlan"), now, diff, self.feed)
        self._resume_ready = False

    def _release(self):
        if not self.ready:
            _fail("UNSUPPORTED_FIRMWARE")
        self.feed()
        try:
            self.installed["eng"].clear()
            self.installed["_act_release"]()
        except Exception:
            _fail("MOTOR_RELEASE_FAILED")

    def call(self, request):
        self._release()
        self.join.service()
        if not isinstance(request, dict):
            _fail("INVALID_REQUEST")
        op = request.get("op")
        if op == "probe":
            networks = self.store.networks()
            import machine
            import binascii
            return {"protocol": PROTOCOL, "state": "ready", "body_id": self.installed["DEVID"],
                    "hardware_id": binascii.hexlify(machine.unique_id()).decode(),
                    "runtime": str(sys.implementation), "saved": [{"ssid": pair[0]} for pair in networks],
                    "hardware_gate": not self.store.validated, "scan": "manual_only", "max_networks": MAX_NETWORKS,
                    "result": self.store.result(self.installed["wlan"])}
        if op == "keepalive":
            return {"protocol": PROTOCOL, "state": "ready"}
        if op == "result":
            return {"result": self.store.result(self.installed["wlan"])}
        if op == "connect":
            self._resume_ready = False
            return self.join.begin(request)
        if op == "poll":
            return self.join.poll(request.get("attempt_id"))
        if op == "cancel":
            return self.join.cancel(request.get("attempt_id"))
        if op == "restore":
            if self.join.state == "checking":
                _fail("BUSY")
            self.store.restore()
            return {"state": "restored", "relay": "unverified"}
        if op == "resume":
            if self.join.state == "checking":
                _fail("BUSY")
            try:
                del sys.modules["secrets"]
            except KeyError:
                pass
            self._resume_ready = True
            result = self.join.status()
            result["state"] = "ready_to_resume"
            return result
        _fail("INVALID_OPERATION")

    def emit(self, request):
        try:
            result = self.call(request)
            result["ok"] = True
        except WiFiError as error:
            result = {"ok": False, "error": error.code}
        except Exception as error:
            result = {"ok": False, "error": "DEVICE_ERROR"}
            # Return only bounded exception metadata, never the exception message,
            # source text, filenames, network names or credentials.
            try:
                kind = type(error).__name__
                if kind in ("AssertionError", "NameError", "ImportError", "MemoryError", "OSError", "SyntaxError", "TypeError", "ValueError", "AttributeError", "NotImplementedError"):
                    result["error_kind"] = kind
                import io
                output = io.StringIO()
                sys.print_exception(error, output)
                for row in output.getvalue().split("\n"):
                    if 'File "<string>", line ' in row:
                        number = row.split('line ', 1)[1].split(',', 1)[0].strip()
                        if number.isdigit() and 0 < int(number) < 10000:
                            result["helper_line"] = int(number)
            except Exception:
                pass
        print(PROTOCOL + " " + json.dumps(result))

    def resume(self):
        self._release()
        if not self._resume_ready:
            _fail("RESUME_NOT_PREPARED")
        self.join.contents = self.join.original = self.join.ssid = None
        self.installed["main"]()
