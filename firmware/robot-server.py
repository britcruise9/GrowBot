"""Robot body server v3 (chunked keyframes) — Pico 2 W + Kitronik 5329.

New in v3 (2026-06-11): ACTION CHUNKING. The brain ships a short plan of
pose keyframes; the chip plays it locally at ~50Hz with smooth easing
(act_engine.py). Chunks can be appended while one plays = gestures chain
with no dead air, and Wi-Fi carries intent, never per-tick servo commands
(the CONTEXT.md cortex/cerebellum split).

  /act            POST {"steps":[{"l":0-180,"r":0-180,"ms":N},...],
                        "mode":"replace"|"append"}   (default replace)
                  Keyframes in absolute degrees, 90 = neutral. ms = glide
                  time to that pose (0 = snap); omit l or r to leave that
                  leg; repeat a pose to hold it. Returns AT ONCE with JSON
                  {"ok":1,"queued_ms":N}. "append" while moving = pipelining;
                  if the queue is full it returns 409 — back off and resend.
                  Queue drains -> hold 300ms -> servos release (limp).
  /seq, /routine  now translate the old ±1 speed steps into keyframes
                  (angle = 90 - speed*35) and return IMMEDIATELY with
                  "queued Nms" — they no longer block the server, so /stop
                  lands instantly even mid-dance.
  /stop           instant: clears the chunk queue + goes limp.

Kept from v2: /set?l=&r= (instant speeds, 500ms dead-man), /pose?l=&r=
(absolute angles), /ws (persistent "l,r" pose stream, latest-wins),
/servo?p=&deg=, /stats (+ act queue state), CORS, / control page (LLM box
now speaks keyframes). Manual control (/set /pose /ws) always wins: it
clears any queued chunks the moment it arrives.

Hardware: left leg = port 1, right leg = port 3. PORT 2 SOCKET IS DEAD.
Legs verified POSITIONAL (SG90) 2026-06-11 via 10s hold test.
Requires PicoRobotics.py and act_engine.py on the board. secrets.py is OPTIONAL.

Wi-Fi — three sources, tried in order (shipped chips carry NO secrets):
  1. wifi.json on the chip   <- written by the out-of-box setup hotspot (below)
  2. secrets.py on the chip  <- dev-bench convenience (gitignored file)
  3. neither / can't join    -> SETUP MODE: the Pico becomes an open hotspot
     "GrowBot-Setup"; join it with any phone, open http://192.168.4.1, pick your
     home Wi-Fi + enter its password — the chip saves wifi.json and reboots onto
     your network. A wrong password just lands it back in setup mode.

The Anthropic key (the page's ask-Claude box) is also OPTIONAL: without it the
box is hidden and everything else works — the creature drives /act /seq /set
with no key on the chip. (./finish-key-rotation.sh still refreshes secrets.py.)

FLASHING (plug the Pico into the Mac by USB first):
  1. open Terminal, then:  cd ~/Desktop/phone-body
  2. mpremote cp act_engine.py :act_engine.py   <- the motion engine
  3. mpremote cp robot-server.py :main.py    <- the firmware; runs at every power-on
  4. (dev bench only, optional) mpremote cp secrets.py :secrets.py
  5. mpremote reset                          <- reboots; prints IP, or enters setup mode
  If mpremote can't find the board, name the port explicitly, e.g.:
     mpremote connect /dev/cu.usbmodem11101 cp robot-server.py :main.py
PRE-FLASH FOR SHIPPING = steps 2+3 (+ PicoRobotics.py) only — zero secrets on the chip.
"""
import network, socket, time, json, select
from machine import Pin
import PicoRobotics
from act_engine import ActEngine

try:
    from secrets import ANTHROPIC_KEY
except Exception:
    ANTHROPIC_KEY = ""   # optional — the page hides the ask-Claude box without it
# SECURITY (external review H3, 2026-07-13): this server is served over an unauthenticated
# public tunnel, so anything substituted into the HTML is world-readable via view-source.
# We therefore NEVER embed the real key in the page — the ask-Claude box stays hidden.
# If you want on-device "ask Claude", proxy it server-side (add a /ask route that keeps the
# key on the Pico) instead of shipping the key to the browser.
SERVED_KEY = ""

def _load_wifi():
    try:                       # 1) provisioned by the setup hotspot
        with open("wifi.json") as f:
            w = json.load(f)
        if w.get("ssid"):
            return w["ssid"], w.get("password", "")
    except Exception:
        pass
    try:                       # 2) dev bench
        import secrets
        return secrets.WIFI_SSID, secrets.WIFI_PASSWORD
    except Exception:
        return None, None      # 3) -> setup mode

def _unquote(s):               # minimal form-urlencoded decoder
    s = s.replace("+", " ")
    out = ""
    i = 0
    while i < len(s):
        if s[i] == "%" and i + 3 <= len(s):
            try:
                out += chr(int(s[i + 1:i + 3], 16))
                i += 3
                continue
            except ValueError:
                pass
        out += s[i]
        i += 1
    return out

L_PORT, R_PORT = 1, 3          # port 2 socket is dead
DEAD_PORTS = (2,)
MAX_STEP_MS, MAX_QUEUE_MS = 3000, 15000
DEADMAN_MS = 500               # /set motion auto-stops after this much silence
DT_KEEP = 120                  # ring buffer of /set arrival deltas

board = PicoRobotics.KitronikPicoRobotics()
led = Pin("LED", Pin.OUT)

def _release(port):
    board.i2c.writeto_mem(108, 0x08 + (port - 1) * 4 + 3, bytes([0x10]))

def _speed(port, s):           # s: -1.0..1.0 -> angle 90 +/- 35
    s = max(-1.0, min(1.0, s))
    board.servoWrite(port, int(90 - s * 35))

def quick_stop():              # immediate zero + release (for /set 0,0 and dead-man)
    _speed(L_PORT, 0); _speed(R_PORT, 0)
    _release(L_PORT); _release(R_PORT)
    led.off()

def quick_release():           # limp stop for pose mode (no recenter snap)
    _release(L_PORT); _release(R_PORT)
    led.off()

def stop_all():                # settled stop for /stop and sequence end
    _speed(L_PORT, 0); _speed(R_PORT, 0)
    time.sleep_ms(300)
    _release(L_PORT); _release(R_PORT)
    led.off()

state = {"moving_set": False, "last_set": 0, "last_arr": None,
         "set_n": 0, "deadman": 0, "pose_mode": False}
dts = []                       # last DT_KEEP arrival deltas (ms) between /set+/pose calls

def _parse_lr(query):
    l = r = None
    for kv in query.split("&"):
        k, _, v = kv.partition("=")
        try:
            if k == "l": l = float(v)
            elif k == "r": r = float(v)
        except ValueError:
            pass
    return l, r

def _mark_arrival():
    now = time.ticks_ms()
    if state["last_arr"] is not None:
        d = time.ticks_diff(now, state["last_arr"])
        dts.append(d)
        if len(dts) > DT_KEEP:
            dts.pop(0)
    state["last_arr"] = now
    state["last_set"] = now
    state["set_n"] += 1

def apply_set(query):
    l, r = _parse_lr(query)
    l = l or 0.0; r = r or 0.0
    _mark_arrival()
    eng.clear()                # manual control wins: drop queued chunks
    state["pose_mode"] = False
    if state["set_n"] % 50 == 0:
        print("set#%d l=%.2f r=%.2f dt=%sms" % (state["set_n"], l, r, dts[-1] if dts else "?"))
    if l == 0 and r == 0:
        quick_stop()
        state["moving_set"] = False
    else:
        _speed(L_PORT, l); _speed(R_PORT, r)
        led.on()
        state["moving_set"] = True

def apply_pose_vals(l, r):
    _mark_arrival()
    eng.clear()                # manual control wins: drop queued chunks
    state["pose_mode"] = True
    if state["set_n"] % 50 == 0:
        print("pose#%d l=%s r=%s dt=%sms" % (state["set_n"], l, r, dts[-1] if dts else "?"))
    if l is not None:
        board.servoWrite(L_PORT, int(max(0, min(180, l))))
    if r is not None:
        board.servoWrite(R_PORT, int(max(0, min(180, r))))
    led.on()
    state["moving_set"] = True

def apply_pose(query):
    l, r = _parse_lr(query)
    apply_pose_vals(l, r)

def stats_json(reset):
    d = sorted(dts)
    def pct(f):
        return d[min(len(d) - 1, int(f * (len(d) - 1) + 0.5))] if d else None
    out = json.dumps({"set_n": state["set_n"], "deadman": state["deadman"],
                      "ws_rx": ws["n"], "moving": state["moving_set"],
                      "act": {"active": eng.active, "queued_ms": eng.queued_ms()},
                      "up_s": time.ticks_diff(time.ticks_ms(), UP0) // 1000,
                      "dt_ms": {"n": len(d),
                                "min": d[0] if d else None, "p50": pct(0.5),
                                "p90": pct(0.9), "p99": pct(0.99),
                                "max": d[-1] if d else None}})
    if reset:
        del dts[:]
        state["set_n"] = 0
        state["last_arr"] = None
        state["deadman"] = 0
    return out

# Routines are ABSOLUTE-DEGREE keyframes now (legs are positional, full 0-180).
# 90 = straight down / neutral. These use the wide range to show off real poses.
ROUTINES = {
    "wiggle": [{"l":60,"r":120,"ms":400},{"l":120,"r":60,"ms":400}]*2 + [{"l":90,"r":90,"ms":300}],
    "dance":  [{"l":50,"r":50,"ms":700},{"l":130,"r":130,"ms":700},
               {"l":55,"r":125,"ms":260},{"l":125,"r":55,"ms":260},
               {"l":55,"r":125,"ms":260},{"l":125,"r":55,"ms":260},
               {"l":150,"r":150,"ms":700},{"l":90,"r":90,"ms":250},{"l":40,"r":40,"ms":500}],
    "shimmy": [{"l":75,"r":105,"ms":180},{"l":105,"r":75,"ms":180}]*4 + [{"l":90,"r":90,"ms":250}],
    "march":  [{"l":45,"r":135,"ms":340},{"l":135,"r":45,"ms":340}]*3 + [{"l":90,"r":90,"ms":300}],
    "bow":    [{"l":150,"r":150,"ms":600},{"l":150,"r":150,"ms":450},{"l":90,"r":90,"ms":600}],
    "stretch":[{"l":30,"r":30,"ms":700},{"l":30,"r":30,"ms":500},{"l":90,"r":90,"ms":700}],
}

def speed_to_keyframes(steps):
    """/seq compatibility shim: the v2 creature app still POSTs ±1 'speed' steps.
    Map them to lean angles (90 - s*35) so old clients keep working. New code
    (routines, LLM, /act, /pose) speaks absolute 0-180 degrees directly."""
    out = []
    for st in steps:
        try:
            out.append({"l": 90 - max(-1.0, min(1.0, float(st.get("l", 0)))) * 35,
                        "r": 90 - max(-1.0, min(1.0, float(st.get("r", 0)))) * 35,
                        "ms": int(st.get("ms", 400))})
        except (ValueError, TypeError, AttributeError):
            continue
    return out

def _act_write(l, r):          # the engine's hands: both legs + the LED heartbeat
    board.servoWrite(L_PORT, l)
    board.servoWrite(R_PORT, r)
    led.on()

eng = ActEngine(_act_write, quick_release, time.ticks_ms, time.ticks_diff,
                max_step_ms=MAX_STEP_MS, max_queue_ms=MAX_QUEUE_MS)

stop_all()

# ---------- Wi-Fi (ladder: wifi.json -> secrets.py -> setup hotspot) ----------
wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.config(pm=0xa11140)

SETUP_PAGE = ("<!DOCTYPE html><html><head><meta charset=utf-8><meta name=viewport "
  'content="width=device-width,initial-scale=1"><title>GrowBot setup</title><style>'
  "body{font-family:system-ui;background:#070a12;color:#e8f0fb;display:flex;flex-direction:column;"
  "align-items:center;gap:14px;padding:40px 24px}input,select,button{font-size:17px;padding:12px;"
  "box-sizing:border-box;border-radius:10px;border:1px solid #31466b;background:#101826;color:#e8f0fb;"
  "width:100%%;max-width:340px}button{background:#2bbfa8;color:#04110f;font-weight:700;border:0}"
  "p{color:#8fa3bb;font-size:13px;max-width:340px;text-align:center}</style></head><body>"
  "<h2>hi! tell me your wifi</h2><form method=POST action=/save>%s"
  '<input name=ssid2 placeholder="network name (if not in the list)">'
  '<input name=pw type=password placeholder="wifi password">'
  "<button>save &amp; wake my body</button></form>"
  "<p>I will reboot onto your wifi. The light blinks while I join; the creature page "
  "finds me from there.</p></body></html>")

def setup_mode():
    """No usable Wi-Fi: become the GrowBot-Setup hotspot and serve a join form at
    http://192.168.4.1 — the pre-flashed out-of-box path. Reboots after saving."""
    nets = []
    try:
        nets = sorted(set(n[0].decode() for n in wlan.scan() if n[0]), key=lambda s: s.lower())[:12]
    except Exception:
        pass
    wlan.active(False)
    ap = network.WLAN(network.AP_IF)
    try:
        ap.config(essid="GrowBot-Setup", security=0)   # open network
    except Exception:
        ap.config(essid="GrowBot-Setup")               # older ports: default is open
    ap.active(True)
    print("\n  SETUP MODE: join the 'GrowBot-Setup' wifi, then open http://192.168.4.1\n")
    opts = ""
    if nets:
        opts = ("<select name=ssid><option value=''>choose your network...</option>"
                + "".join("<option>%s</option>" % n for n in nets) + "</select>")
    page = SETUP_PAGE % opts
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(socket.getaddrinfo("0.0.0.0", 80)[0][-1])
    srv.listen(2)
    srv.settimeout(0.5)        # so the LED blinks while waiting = "I'm in setup mode"
    while True:
        led.toggle()
        try:
            cl, _ = srv.accept()
        except OSError:
            continue
        try:
            cl.settimeout(3)
            req = cl.recv(2048)
            while req and b"\r\n\r\n" not in req and len(req) < 8192:
                more = cl.recv(512)
                if not more: break
                req += more
            head, _, body = req.partition(b"\r\n\r\n")
            if head.split(b"\r\n")[0].startswith(b"POST /save"):
                clen = 0
                for h in head.split(b"\r\n"):
                    if h.lower().startswith(b"content-length"):
                        clen = int(h.split(b":")[1])
                while len(body) < clen:
                    more = cl.recv(512)
                    if not more: break
                    body += more
                form = {}
                for kv in body.decode().split("&"):
                    k, _, v = kv.partition("=")
                    form[k] = _unquote(v)
                ssid = (form.get("ssid") or form.get("ssid2") or "").strip()
                if ssid:
                    with open("wifi.json", "w") as f:
                        json.dump({"ssid": ssid, "password": form.get("pw", "")}, f)
                    cl.send(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n"
                            b"<body style='font-family:system-ui;background:#070a12;color:#e8f0fb;"
                            b"text-align:center;padding-top:80px'><h2>got it &mdash; waking up on your wifi...</h2>"
                            b"<p>rejoin your normal wifi; I'll be there in ~15 seconds.</p></body>")
                    try: cl.close()
                    except Exception: pass
                    time.sleep(1)
                    import machine
                    machine.reset()
            cl.send(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n")
            cl.send(page)
        except Exception as e:
            print("setup req error:", e)
        finally:
            try: cl.close()
            except Exception: pass

SSID, PASSWORD = _load_wifi()
joined = False
if SSID:
    wlan.connect(SSID, PASSWORD)
    print("connecting to", SSID, "...")
    for _ in range(40):
        if wlan.isconnected():
            joined = True
            break
        time.sleep(0.5)
if not joined:
    setup_mode()                      # never returns (reboots after save)
IP = wlan.ifconfig()[0]
print("\n  ROBOT SERVER v3 (keyframes):  http://%s/\n" % IP)

# ---------- the page ----------
PAGE = """<!DOCTYPE html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>robot legs</title><style>
body{margin:0;min-height:100vh;background:#05070d;color:#e8f6ff;font-family:system-ui;
display:flex;flex-direction:column;align-items:center;gap:14px;padding:22px;box-sizing:border-box}
h1{font-size:16px;color:#7f93ab;margin:2px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;width:100%;max-width:420px}
button{font-size:17px;padding:16px;border-radius:14px;border:0;font-weight:700;
background:#0e1622;color:#e8f6ff;border:1px solid rgba(120,160,200,.25)}
#stop{background:#8c1d2f;grid-column:1/3;font-size:20px}
textarea{width:100%;max-width:420px;box-sizing:border-box;background:#0e1622;color:#e8f6ff;
border:1px solid rgba(120,160,200,.25);border-radius:14px;padding:12px;font-size:16px;min-height:64px}
#ask{background:linear-gradient(160deg,#37e0c8,#5ab0ff);color:#04110f;width:100%;max-width:420px}
#mic{background:#1d2a3d;width:100%;max-width:420px}
#st{color:#7f93ab;font-size:14px;min-height:1.2em;text-align:center}
#say{color:#37e0c8;font-size:15px;min-height:1.2em;text-align:center;max-width:420px}
</style></head><body>
<h1>robot legs &middot; buttons + LLM &middot; v3 keyframes</h1>
<div class=grid>
<button id=stop onclick="go('stop')">STOP</button>
<button onclick="go('routine?name=wiggle')">wiggle</button>
<button onclick="go('routine?name=dance')">dance</button>
<button onclick="go('routine?name=shimmy')">shimmy</button>
<button onclick="go('routine?name=march')">march</button>
<button onclick="go('routine?name=bow')">bow</button>
<button onclick="go('routine?name=stretch')">stretch</button>
</div>
<textarea id=q placeholder="type here - or tap this box and use the keyboard mic to dictate, then hit ask"></textarea>
<button id=mic onclick="mic()">&#127908; tap to talk</button>
<button id=ask onclick="ask()">ask Claude to move the legs</button>
<div id=say></div>
<div id=st>ready</div>
<script>
var st=document.getElementById('st'),say=document.getElementById('say'),q=document.getElementById('q');
var KEY='%KEY%';
if(!KEY){ q.style.display='none'; document.getElementById('mic').style.display='none';
 document.getElementById('ask').style.display='none'; }
function go(p){st.textContent='moving...';
 fetch('/'+p).then(function(r){return r.text();}).then(function(t){st.textContent=t;})
 .catch(function(){st.textContent='! no link to robot';});}
var SYS='You choreograph a small 2-leg desk robot. Each leg is a positional servo with the FULL '+
'0-180 range (90 = straight-down neutral stance; 0 and 180 are the extreme fore/aft swings). '+
'You write animation KEYFRAMES: the body glides smoothly from pose to pose, each keyframe taking '+
'ms to arrive. Repeat a pose to hold it (a rest). Reply with ONLY raw JSON, no fences: '+
'{"say":"<one short fun sentence>","steps":[{"l":<0-180>,"r":<0-180>,"ms":<120..2000>}]} '+
'l=left leg, r=right leg. Use the whole range for big expressive moves; just know wide stances '+
'or fast extremes can tip a small desk robot, so land back near 90 to settle. Max 24 keyframes, '+
'total under 12000ms. Be expressive: deep bows, high marches, asymmetric struts, dramatic pauses.';
function ask(){
 var text=q.value.trim(); if(!text){st.textContent='type something first';return;}
 st.textContent='asking Claude...'; say.textContent='';
 fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{
  'content-type':'application/json','x-api-key':'%KEY%',
  'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
  body:JSON.stringify({model:'claude-opus-4-8',max_tokens:2000,
   output_config:{effort:'low'},system:SYS,messages:[{role:'user',content:text}]})})
 .then(function(r){return r.json();})
 .then(function(d){
  if(d.error){st.textContent='Claude error: '+d.error.message;return;}
  var txt=''; (d.content||[]).forEach(function(b){if(b.type==='text')txt+=b.text;});
  txt=txt.replace(/```json|```/g,'').trim();
  var plan=JSON.parse(txt);
  say.textContent='Claude: '+(plan.say||'');
  st.textContent='Claude sent '+plan.steps.length+' keyframes - playing...';
  return fetch('/act',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({steps:plan.steps,mode:'replace'})})
   .then(function(r){return r.json();})
   .then(function(d2){st.textContent=d2.ok?('playing '+d2.queued_ms+'ms of motion'):('! '+d2.err);});})
 .catch(function(e){st.textContent='! '+e.message;});}
var SR=window.SpeechRecognition||window.webkitSpeechRecognition,rec=null,micb=document.getElementById('mic');
function mic(){
 if(!SR||!window.isSecureContext){
  st.textContent='browser mic needs https - tap the text box and use the keyboard mic key instead';
  q.focus();return;}
 if(rec){rec.stop();return;}
 rec=new SR();rec.lang='en-US';rec.interimResults=true;
 micb.textContent='listening... (tap to stop)';st.textContent='speak now';
 rec.onresult=function(e){var t='';for(var i=0;i<e.results.length;i++)t+=e.results[i][0].transcript;q.value=t;};
 rec.onerror=function(e){st.textContent='mic error: '+e.error;};
 rec.onend=function(){micb.textContent='\\ud83c\\udfa4 tap to talk';rec=null;if(q.value.trim())ask();};
 rec.start();}
</script></body></html>""".replace("%KEY%", SERVED_KEY)

# ---------- WebSocket (persistent /pose stream) ----------
try:
    import hashlib, binascii
    WS_OK = hasattr(hashlib, "sha1")
except ImportError:
    WS_OK = False
WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
ws = {"sock": None, "buf": b"", "n": 0}

def _ws_frame(op, payload=b""):       # server->client frame (unmasked)
    ln = len(payload)
    if ln < 126:
        return bytes([0x80 | op, ln]) + payload
    return bytes([0x80 | op, 126, ln >> 8, ln & 0xFF]) + payload

def _ws_pop_frame():
    """Pop one complete frame off ws['buf']; None if incomplete."""
    buf = ws["buf"]
    if len(buf) < 2:
        return None
    op = buf[0] & 0x0F
    masked = buf[1] & 0x80
    ln = buf[1] & 0x7F
    i = 2
    if ln == 126:
        if len(buf) < 4:
            return None
        ln = (buf[2] << 8) | buf[3]
        i = 4
    elif ln == 127:                   # 64-bit length: never legit here
        ws["buf"] = b""
        return None
    mask = None
    if masked:
        if len(buf) < i + 4:
            return None
        mask = buf[i:i + 4]
        i += 4
    if len(buf) < i + ln:
        return None
    payload = bytearray(buf[i:i + ln])
    if mask:
        for j in range(ln):
            payload[j] ^= mask[j & 3]
    ws["buf"] = buf[i + ln:]
    return op, bytes(payload)

def ws_close(reason=""):
    s = ws["sock"]
    if not s:
        return
    try: poller.unregister(s)
    except Exception: pass
    try: s.close()
    except Exception: pass
    ws["sock"] = None
    ws["buf"] = b""
    if state["moving_set"]:           # stream died mid-motion -> go limp
        quick_release()
        state["moving_set"] = False
        state["pose_mode"] = False
    print("ws closed:", reason)

def ws_service():
    """Drain all pending frames, apply ONLY the newest pose (latest-wins)."""
    s = ws["sock"]
    try:
        while True:
            data = s.recv(512)
            if data == b"":
                ws_close("peer gone")
                return
            ws["buf"] += data
            if len(data) < 512:
                break
    except OSError:                   # EAGAIN: nothing more queued
        pass
    if len(ws["buf"]) > 4096:
        ws_close("buffer overflow")
        return
    latest = None
    while True:
        f = _ws_pop_frame()
        if f is None:
            break
        op, payload = f
        if op == 8:                   # close
            try: s.send(_ws_frame(8))
            except OSError: pass
            ws_close("client close")
            return
        if op == 9:                   # ping -> pong
            try: s.send(_ws_frame(10, payload))
            except OSError: pass
        elif op in (1, 2):
            latest = payload
            ws["n"] += 1
    if latest is not None:
        try:
            l, _, r = latest.decode().partition(",")
            apply_pose_vals(float(l), float(r))
        except ValueError:
            pass

# ---------- tiny HTTP server ----------
CORS = "Access-Control-Allow-Origin: *\r\n"

def send_all(c, data):
    if isinstance(data, str): data = data.encode()
    while data:
        n = c.send(data); data = data[n:]

def reply(cl, status, body_txt, ctype="text/plain"):
    send_all(cl, "HTTP/1.1 %s\r\n%sContent-Type: %s\r\nConnection: close\r\n\r\n"
                 % (status, CORS, ctype))
    send_all(cl, body_txt)

def read_request(cl, timeout=0.5):     # short: a stalled client must not freeze a glide
    cl.settimeout(timeout)
    req = cl.recv(2048)
    if not req:
        return None
    while b"\r\n\r\n" not in req and len(req) < 8192:
        more = cl.recv(512)
        if not more: break
        req += more
    head, _, body = req.partition(b"\r\n\r\n")
    first = head.split(b"\r\n")[0].split(b" ")
    method = first[0].decode() if first else "GET"
    full = first[1].decode() if len(first) > 1 else "/"
    path, _, query = full.partition("?")
    clen = 0
    for h in head.split(b"\r\n"):
        if h.lower().startswith(b"content-length"):
            clen = int(h.split(b":")[1])
    while len(body) < clen:
        more = cl.recv(512)
        if not more: break
        body += more
    return method, path, query, body, head

def handle(cl):
    """Serve one request. Nothing here blocks on motion: chunks go to the
    engine's queue and play from the main loop, so every request - above
    all /stop - is answered immediately."""
    parsed = read_request(cl)
    if not parsed:
        return None
    method, path, query, body, head = parsed

    if method == "OPTIONS":
        send_all(cl, "HTTP/1.1 204 No Content\r\n" + CORS +
                     "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                     "Access-Control-Allow-Headers: content-type\r\n"
                     "Access-Control-Max-Age: 86400\r\nConnection: close\r\n\r\n")
        return None

    if path == "/set":
        apply_set(query)
        reply(cl, "200 OK", "ok")
        return "set"

    if path == "/pose":
        apply_pose(query)
        reply(cl, "200 OK", "ok")
        return "set"

    if path == "/stop":
        was_pose = state["pose_mode"] or eng.active
        eng.clear()                             # drop queued chunks NOW
        if was_pose:
            quick_release()                     # limp, don't snap to center
        else:
            stop_all()                          # speed mode: zero, settle, release
        state["moving_set"] = False
        state["pose_mode"] = False
        reply(cl, "200 OK", "stopped")
        return "stop"

    if path == "/stats":
        reply(cl, "200 OK", stats_json("reset" in query), "application/json")
        return None

    if path == "/act" and method == "POST":
        try:
            plan = json.loads(body)
            steps = plan.get("steps", [])
            mode = plan.get("mode", "replace")
        except Exception:
            steps, mode = None, "replace"
        if not steps:
            reply(cl, "400 BR", '{"err":"bad act json"}', "application/json")
            return None
        state["moving_set"] = False             # chunked motion has no dead-man
        state["pose_mode"] = False
        ok, res = eng.enqueue(steps, "append" if mode == "append" else "replace")
        if ok:
            print("act: queued %dms (%s)" % (res, mode))
            reply(cl, "200 OK", '{"ok":1,"queued_ms":%d}' % res, "application/json")
        else:
            reply(cl, "409 Full" if res == "queue full" else "400 BR",
                  '{"err":"%s","queued_ms":%d}' % (res, eng.queued_ms()),
                  "application/json")
        return None

    if path == "/ws":
        if not WS_OK:
            reply(cl, "501 NI", "no sha1 in this firmware build")
            return None
        key = None
        for line in head.split(b"\r\n"):
            if line.lower().startswith(b"sec-websocket-key"):
                key = line.split(b":", 1)[1].strip()
        if not key:
            reply(cl, "400 BR", "not a websocket upgrade")
            return None
        accept = binascii.b2a_base64(hashlib.sha1(key + WS_GUID).digest()).strip()
        send_all(cl, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                     "Connection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n"
                     % accept.decode())
        ws_close("replaced by new client")
        cl.setblocking(False)
        ws["sock"] = cl
        ws["buf"] = b""
        poller.register(cl, select.POLLIN)
        print("ws connected")
        return "ws"

    if path == "/":
        send_all(cl, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n")
        send_all(cl, PAGE)
    elif path == "/routine":
        name = query.split("name=")[-1] if "name=" in query else ""
        if name in ROUTINES:
            state["moving_set"] = False
            state["pose_mode"] = False
            ok, res = eng.enqueue(ROUTINES[name])   # absolute-degree keyframes
            print("routine %s: queued %s" % (name, res))
            reply(cl, "200 OK", "routine %s queued (%sms)" % (name, res))
        else:
            reply(cl, "404 NF", "unknown routine")
    elif path == "/seq" and method == "POST":
        try:
            steps = json.loads(body).get("steps", [])
        except Exception:
            steps = None
        frames = speed_to_keyframes(steps) if steps else []
        if frames:
            state["moving_set"] = False
            state["pose_mode"] = False
            ok, res = eng.enqueue(frames)
            print("seq: %d steps -> %s" % (len(frames), res))
            if ok:
                reply(cl, "200 OK", "queued %dms (%d steps)" % (res, len(frames)))
            else:
                reply(cl, "409 Full", res)
        else:
            reply(cl, "400 BR", "bad steps json")
    elif path == "/servo":
        p = deg = None
        off = False
        for kv in query.split("&"):
            k, _, v = kv.partition("=")
            try:
                if k == "p": p = int(v)
                elif k == "deg": deg = int(v)
                elif k == "off": off = v not in ("0", "")
            except ValueError:
                pass
        if p is None or not 1 <= p <= 8 or p in DEAD_PORTS:
            reply(cl, "400 BR", "bad port (1-8, port 2 is dead)")
        elif off:
            _release(p)
            reply(cl, "200 OK", "servo %d released" % p)
        elif deg is not None:
            deg = max(0, min(180, deg))
            board.servoWrite(p, deg)
            reply(cl, "200 OK", "servo %d -> %d" % (p, deg))
        else:
            reply(cl, "400 BR", "need deg= or off=1")
    else:
        reply(cl, "404 NF", "nope")
    return None

srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(socket.getaddrinfo("0.0.0.0", 80)[0][-1])
srv.listen(4)
srv.settimeout(0)
poller = select.poll()
poller.register(srv, select.POLLIN)
UP0 = time.ticks_ms()
print("ready - v3: /act /set /pose /ws /stop /seq /routine /servo /stats")

while True:
    eng.tick()                 # play queued keyframes (~50Hz; poll below is 20ms)
    if state["moving_set"] and \
       time.ticks_diff(time.ticks_ms(), state["last_set"]) > DEADMAN_MS:
        if state["pose_mode"]:
            quick_release()
        else:
            quick_stop()
        state["moving_set"] = False
        state["pose_mode"] = False
        state["deadman"] += 1
        print("dead-man stop (#%d)" % state["deadman"])
    try:
        events = poller.poll(20)   # ms; also the dead-man check cadence
    except OSError:
        continue
    for obj, ev in events:
        if obj is srv:
            try:
                cl, _ = srv.accept()
            except OSError:
                continue
            a = None
            try:
                a = handle(cl)
            except Exception as e:
                print("request error:", e)
                try:
                    if not state["moving_set"] and not eng.active: stop_all()
                except Exception: pass
            finally:
                if a != "ws":      # the ws socket must stay open
                    try: cl.close()
                    except Exception: pass
        elif ws["sock"] is not None and obj is ws["sock"]:
            if ev & (select.POLLERR | select.POLLHUP):
                ws_close("socket error")
            else:
                try:
                    ws_service()
                except Exception as e:
                    print("ws error:", e)
                    ws_close("exception")
        else:                      # event for an already-closed socket
            try: poller.unregister(obj)
            except Exception: pass
