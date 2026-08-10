# GrowBot phone↔body protocol

How the phone (the brain) talks to a microcontroller (the body). The app is
**board-agnostic by design** — it only speaks this protocol over Wi-Fi. Any board
that joins Wi-Fi and answers these endpoints works. **The Pico 2 W is the reference
board**; its firmware is the canonical implementation.

- **Reference firmware:** [`robot-server.py`](robot-server.py) (HTTP + WebSocket server) + [`act_engine.py`](act_engine.py) (the 50 Hz keyframe glide engine). Flash `robot-server.py` as `main.py`.
- **Reference brain:** the `bodyDo()` / walk-lane code in [`vercel-app/v2/index.html`](vercel-app/v2/index.html).
- **Conformance test:** open [`conformance.html`](conformance.html), point it at your board, get PASS/FAIL per message.

---

## ⚠️ Read this first — what is REAL vs aspirational

This doc describes **what the code actually does today**, not the someday design. Two
common assumptions are *not* implemented yet — porters should not build to them:

1. **The walk policy runs on the PHONE, not the chip.** The browser loads the learned
   gait (`growbot_policy.js` + `policy_85mm.json`), runs it at ~30 Hz against the
   **phone's** IMU, and streams the resulting leg poses to the chip as `"l,r"` text over
   the `/ws` WebSocket (`walkTick()` → `walkWS.send(...)`). The chip just applies the
   latest pose. So today the chip does **not** store or run any policy.
2. **There is no `/policy` endpoint and no on-chip policy/flash storage.** An older note
   (`growbot-legs-integration.md`) describes a `POST /policy {name,ms}` scaffold "added to
   robot-server.py" — **it is not in the firmware on disk.** Treat the chip-owns-the-gait
   design as a TODO, not the contract.

So there are really **two motion paths with two transports**:
- **Path A — gestures (HTTP):** phone POSTs a short keyframe plan to `/act`; the chip
  glides between poses locally at 50 Hz. This is true intent-not-per-tick. ✅
- **Path B — walk (WebSocket):** phone streams per-pose `"l,r"` to `/ws` at ~30 Hz. This
  is closer to remote-control than intent. The chip is "dumb" on this path. ⚠️

Other gaps to know: **no auth/pairing** — motor endpoints are open (CORS `*`); anyone with
the URL can move the body (accepted risk for now). **No IMU or telemetry flows chip→phone**
beyond `/stats`; the IMU used for walking is the phone's. The **duty-cycle safety budget
(20 s motion / 60 s) is enforced on the phone, not in firmware** — a porter's firmware
should add its own stall/thermal bound (it currently has none beyond per-step/queue caps).

---

## 1. Transport

| | |
|---|---|
| **Link** | Wi-Fi. The chip joins the **home network as a station** (not an AP in normal use). |
| **Server** | Plain **HTTP/1.1 on port 80**, plus a **WebSocket** upgrade at `/ws`. Single-threaded, non-blocking poll loop (`select.poll`, 20 ms). |
| **CORS** | Every response sends `Access-Control-Allow-Origin: *`; `OPTIONS` preflight → `204`. Required because the brain is an HTTPS web page on another origin. |
| **Address the phone uses** | A public **HTTPS** URL, because the browser brain is served over HTTPS and can't fetch `http://<lan-ip>` (mixed content). Today that's a `cloudflared` tunnel → `https://<random>.trycloudflare.com`. A native wrapper could instead hit the LAN `http://<ip>` directly. |

**Discovery / pairing (there is no on-chip handshake):**
- The current tunnel URL is published to the app's server: `POST /api/body?key=<KEY>&url=https://…`
  (stored in a blob). The phone reads it with `GET /api/body` → `{ "url": "...", "updatedAt": <ms> }`.
- The phone also accepts a **manually typed** body URL (persisted in `localStorage.pb2_body`).
- **Self-heal / reconnect:** on any fetch failure the phone calls `relookupBody()`, which
  re-reads `GET /api/body` (throttled to once / 30 s) and switches to the new URL. The
  WebSocket is reconnected lazily by `walkConnect()` whenever a walk starts.

**First-boot provisioning (reference firmware):** with no Wi-Fi credentials the Pico
becomes an open AP **`GrowBot-Setup`** serving a join form at `http://192.168.4.1`; you pick
your network there, it saves `wifi.json` and reboots onto the LAN. (Credential sources, in
order: `wifi.json` → `secrets.py` → setup AP.)

---

## 2. Message schema

### Phone → chip

| Endpoint | Method | Body / query | Returns | Meaning |
|---|---|---|---|---|
| `/act` | POST | `{"steps":[{"l":0-180,"r":0-180,"ms":N}], "mode":"replace"\|"append"}` | `{"ok":1,"queued_ms":N}` · `409 {"err":"queue full","queued_ms":N}` · `400 {"err":...}` | **Path A.** Keyframe plan; chip glides between poses. `l`/`r` = absolute degrees (90 = neutral). `ms` = glide time to that pose (0 = snap). Omit `l` or `r` to hold that leg; repeat a pose to dwell. `replace` (default) takes over mid-glide; `append` pipelines. |
| `/ws` | WebSocket | text frames `"<l>,<r>"` e.g. `"70,110"` | (no per-frame reply) | **Path B.** Persistent pose stream, **latest-wins**. Phone sends ~30 Hz. Stop sending → 500 ms dead-man → legs limp. |
| `/stop` | GET | — | `stopped` | Instant: clear the queue + go limp. Brain treats this as a hard latch. |
| `/pose` | GET | `?l=<0-180>&r=<0-180>` | `ok` | One absolute pose now. 500 ms dead-man. |
| `/set` | GET | `?l=<-1..1>&r=<-1..1>` | `ok` | **Legacy** speed/lean (mapped to `90 - s*35`). 500 ms dead-man. |
| `/seq` | POST | `{"steps":[{"l":-1..1,"r":-1..1,"ms":N}]}` | `queued <N>ms (<k> steps)` · `409` | **Legacy** speed dialect → keyframes, non-blocking. |
| `/routine` | GET | `?name=wiggle\|dance\|shimmy\|march\|bow\|stretch` | `routine <name> queued (<N>ms)` · `404` | Canned keyframe gestures (great for demos/conformance). |
| `/servo` | GET | `?p=<1-8>&deg=<0-180>` or `?p=<n>&off=1` | `servo <p> -> <deg>` / `servo <p> released` · `400` | Single-channel direct write / release. (Reference board: port 2 socket is dead.) |
| `/stats` | GET | `?reset` optional | JSON (below) | Telemetry + health. |
| `/` | GET | — | HTML | Human control page (buttons + LLM box). Not needed by the brain. |
| any | OPTIONS | — | `204` + CORS | Preflight. |

**Units & clamps.** Degrees are absolute, `90` = neutral stance; firmware clamps `0–180`,
the brain self-limits to the expressive band `50–130`. `ms` per step is capped at `3000`
(firmware) and the brain keeps a plan ≤ 8 steps / ≤ 12000 ms; total queue cap `15000 ms`.

### Chip → phone

There is **no streaming telemetry channel**. Replies are per-request:
- Small text (`ok`, `stopped`, `routine … queued`) or JSON for `/act` (`{"ok":1,"queued_ms":N}`).
- Errors as HTTP status + short body: `409` (queue full / busy — **back off and resend**),
  `400` (bad JSON / params), `404` (unknown routine).
- **`/stats` JSON** (the only "telemetry"):
  ```json
  {"set_n":N,"deadman":N,"ws_rx":N,"moving":bool,
   "act":{"active":bool,"queued_ms":N},
   "up_s":N,"dt_ms":{"n":N,"min":N,"p50":N,"p90":N,"p99":N,"max":N}}
  ```
  `act.active`/`queued_ms` = is a glide playing and how much motion is queued. `ws_rx` =
  WebSocket poses received. `dt_ms` = arrival-interval percentiles for `/set`+`/pose`.

---

## 3. Behavior contract (what firmware MUST honor)

A conforming body has to do these — they are the hard-won rules, derived from the
reference firmware:

1. **Local 50 Hz motion.** Don't expect per-tick commands for gestures. On `/act` you
   receive a *plan* and must play it yourself at ~50 Hz with smooth easing (smoothstep),
   chaining appended chunks with no dead air. Reply to `/act` **immediately** (< ~200 ms) —
   never block the socket for the duration of the motion.
2. **Positional servos, 90 = neutral.** `l`/`r` are angles, not speeds. Expressive band
   `50–130`; full `0–180` allowed but wide/fast extremes can tip a small body.
3. **Servos on the battery rail, common ground.** Power servos from the battery, **not**
   from a logic/3V3 pin. Tie the servo ground to the board ground. (SG90/MG90 run fine on a
   raw ~4 V 1S LiPo — no 5 V boost required.)
4. **Dead-man on streamed/instant control.** `/set`, `/pose`, and `/ws` motion must
   auto-limp after **500 ms** of silence. `/act` motion ends by holding the last pose
   ~300 ms, then releasing.
5. **Release means limp.** "Stop"/idle = cut the servo signal so the servo is limp (cool,
   quiet, low current) — not actively holding torque.
6. **Manual control wins.** A `/set`/`/pose`/`/ws` command clears any queued `/act` plan.
7. **`/stop` is instant + hard.** Clear the queue and go limp immediately, even mid-glide.
8. **Don't run away on disconnect.** Lost link / drained queue / closed WebSocket = limp,
   not "keep doing the last thing." Add your own stall/thermal bound — the phone's 20 s/60 s
   duty budget is advisory and **not** enforced on the chip.

---

## 4. Conformance test (does your board "speak GrowBot"?)

Run [`conformance.html`](conformance.html): open it locally, type your board's base URL
(e.g. `http://192.168.1.50` on the LAN, or your `https://…trycloudflare.com` tunnel), and
hit **Run**. It checks each message and shows PASS/FAIL + the raw response. To verify by eye,
watch the legs while it runs.

**Minimum viable body** (enough to be a GrowBot in the video) — all must PASS:
- `GET /stats` → `200` + JSON containing `act.active` / `act.queued_ms`. *(reachable + CORS)*
- `POST /act {"steps":[{"l":120,"r":60,"ms":400},{"l":60,"r":120,"ms":400},{"l":90,"r":90,"ms":300}]}`
  → `200 {"ok":1,"queued_ms":1100}`, reply arrives in < 200 ms, **legs wiggle then go limp**.
- `GET /stop` → `200 stopped`, legs limp instantly.

**Full conformance** (adds):
- `POST /act` oversized (`6 × {ms:3000}`) → `409` with `queue full`.
- `POST /act {"steps":"soup"}` → `400`.
- `GET /routine?name=wiggle` → `200 … queued`.
- WebSocket `/ws` connects; sending `"70,110"` then `"90,90"` moves the legs, and stopping
  the stream limps them within ~500 ms.

If `/act` + `/stop` pass and the legs move, you're in. Everything else is polish.

---

## 5. Per-board notes

The protocol is identical everywhere; only the firmware that implements it changes.
**Hard requirement, any board: a network path to the phone (Wi-Fi today).** Compute is not
a constraint — the brain runs the policy, the body just applies poses.

- **Raspberry Pi Pico 2 W** — the reference. MicroPython, drag-drop `.uf2` flashing.
  Carrier-board path talks to a PCA9685; bare-Pico drives GP0 / GP1.
- **ESP32** (and Wi-Fi Arduinos — Nano ESP32, RP2040 Connect) — a strong target. Drive
  servos straight off **LEDC hardware PWM** (no carrier board needed) and run an HTTP +
  WebSocket server on Wi-Fi. MicroPython or Arduino/ESP-IDF. **Different flashing** (esptool,
  not BOOTSEL drag-drop).
- **Carrier boards** (PCA9685 over I2C — Kitronik Robotics 5329, Waveshare Pico Servo
  Driver, generic PCA9685) — auto-detected by the reference `PicoRobotics.py`.
- **Raspberry Pi / Linux SBC** — runs a normal Python HTTP+WS server. **Don't** software-PWM
  servos off GPIO (Linux isn't real-time → jitter); use a **PCA9685** or hardware-PWM pins.
  (A Pi is powerful enough to run the *brain* itself, not just the body.)
- **Serial-bus servos** (Feetech SCS0009 / STS, Dynamixel, …) — ⚠️ **not PWM.** They need a
  half-duplex UART driver, not `servoWrite` PWM, so the reference firmware won't move them.
  Use standard PWM hobby servos (SG90 / MG90S), or write a serial driver.

---

## Appendix — reference body (mechanical)

**The body is up to you — the protocol doesn't care about the shell.** For reference, the demo rig:

- **Flat base plate** (≈ phone-sized, **114 × 69 mm**) carrying the phone + battery + Pico/board
  stacked in the middle.
- **2× SG90/MG90 servos mounted at the two ends** (left & right), output shafts pointing
  **outward**.
- A flat **leg/paddle on each servo horn** (`leg_round6mm_screwwall.stl`, ≈ **21 × 13 × 84 mm**;
  the servo **screws into** the leg's screw wall). The servo **sweeps the leg through its full
  180°** (90° = upright/neutral) — that sweep is the motion. Nothing hangs; the legs are arms
  on the servo outputs.
- **Files included:** `phone_plate_magnets_10mm.stl` (base, 114 × 69 × 4.5 mm, with 10 mm
  magnet mounts) + `leg_round6mm_screwwall.stl` (the paddle leg).

Bottom line: phone + 2 side-mounted servos with a paddle on each horn, on *any* rigid base.
