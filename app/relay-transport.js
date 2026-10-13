// relay-transport.js — the ONE source of truth for the GrowBot relay wire protocol.
// Imported by every browser surface that drives a body (walk page, sandbox testers,
// the creature app). Do NOT re-implement the envelopes anywhere else — import this.
// Keep these shapes identical to relay_chip.py (the on-Pico client).
//
// ===== CANONICAL WIRE PROTOCOL =====
//   phone -> chip (what this module sends):
//     {t:'attach', id, code}                       handshake (sent automatically on connect)
//     {t:'pose',   lr:"L,R"}                        WALK lane: latest-wins ~30Hz, L,R int deg 0..180
//     {t:'act',    rid, steps:[{l,r,ms}], mode}     GESTURE lane: keyframes; mode 'replace'|'append'
//     {t:'routine',rid, name}                       canned gesture (e.g. 'wiggle')
//     {t:'stop',   rid}                             halt gesture + limp
//   chip -> phone (what this module receives):
//     {t:'status', awake:0|1}                       emitted by the RELAY (chip presence) -> onStatus
//     {t:'ack',    rid, ok, queued_ms}              reply to act/routine/stop      -> onAck
//     {t:'alive',  quiet_ms}                        RELAY proof of life, every 30 s, for a body that
//                                                   sends heartbeats (relay 0923)  -> onAlive
//
// Usage:
//   import { RelayBody } from './relay-transport.js';
//   const body = new RelayBody('bench', { onStatus:a=>..., onAck:m=>... });
//   body.connect();
//   body.pose(95, 85);                       // walk stream (call ~30Hz)
//   const rid = body.act([{l:60,r:120,ms:400},{l:90,r:90,ms:300}]);  // gesture; match m.rid in onAck
//   body.routine('wiggle');  body.stop();

export const RELAY_DEFAULT = 'wss://growbot-relay.growbot.workers.dev';

// LEG-IDENTITY swap (which servo is "left"). Stored per-device in the walk calibration
// (localStorage gb_walk_cal.SWAP) and applied HERE, at the single wire chokepoint, so the
// exact same swap reaches every surface: manual, policy, face, and the creature/LLM.
// Read fresh per send so a same-tab toggle takes effect immediately. Absent/false = no
// swap = byte-identical behavior to before.
function _lrSwap() {
  try { return !!JSON.parse(localStorage.getItem('gb_walk_cal') || '{}').SWAP; }
  catch (_) { return false; }
}

export class RelayBody {
  constructor(deviceId, opts = {}) {
    this.id = String(deviceId || 'bench');
    this.relay = opts.relay || RELAY_DEFAULT;
    this.onStatus = opts.onStatus || (() => {});   // (awake:0|1)
    this.onAck = opts.onAck || (() => {});          // ({rid, ok, queued_ms})
    this.onAlive = opts.onAlive || (() => {});      // ({quiet_ms}): still there, even while holding still
    this.onOpen = opts.onOpen || (() => {});
    this.autoReconnect = opts.autoReconnect !== false;
    this.reconnectMs = opts.reconnectMs || 1500;
    this.ws = null;
    this.awake = 0;
    this._rid = 0;
    this._want = false;
    this._t = null;
    this._gen = 0;
  }

  // 0909 RECONNECT GUARD (Codex's, trimmed to the guard; given to the Wi-Fi seat by Brit via ASTRA
  // DEV 0923). Every connect() is a new generation and closes the socket it replaces. Callbacks
  // from an older socket (a late close, status, open or message) are ignored, so they can never
  // change the connection that replaced it or start a second retry timer. Before this, a second
  // connect() left the first socket open with live callbacks, and its late close said "offline"
  // over a live connection.
  connect() {
    const gen = ++this._gen;
    this._want = true; clearTimeout(this._t); this._t = null;
    const old = this.ws; this.ws = null;
    if (old) { try { old.close(); } catch (_) {} }
    this.awake = 0;
    let ws;
    try { ws = new WebSocket(this.relay + '/d/' + encodeURIComponent(this.id)); }
    catch (e) { this._retry(gen); return; }
    this.ws = ws;
    const current = () => this._want && this._gen === gen && this.ws === ws;
    ws.onopen = () => {
      if (!current()) return;
      ws.send(JSON.stringify({ t: 'attach', id: this.id, code: this.id }));
      this.onOpen();
    };
    ws.onmessage = (e) => {
      if (!current()) return;
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'status' && (m.awake === 0 || m.awake === 1)) { this.awake = m.awake; this.onStatus(m.awake); }   // only a real 0/1 is presence
      else if (m.t === 'ack') { this.onAck(m); }
      else if (m.t === 'alive' && Number.isFinite(m.quiet_ms)) { this.onAlive(m); }
    };
    ws.onclose = () => {
      if (!current()) return;
      this.ws = null; this.awake = 0; this.onStatus(0);
      if (this.autoReconnect) this._retry(gen);
    };
    ws.onerror = () => {};
  }

  _retry(gen = this._gen) {
    clearTimeout(this._t);
    this._t = setTimeout(() => { if (this._want && gen === this._gen) this.connect(); }, this.reconnectMs);
  }

  get ready() { return !!this.ws && this.ws.readyState === 1; }

  // WALK lane — latest-wins, fire-and-forget. Call at your control rate (~30Hz).
  pose(l, r) {
    if (_lrSwap()) { const _t = l; l = r; r = _t; }   // per-device leg-identity swap (gb_walk_cal.SWAP)
    if (this.ready) this.ws.send(JSON.stringify({ t: 'pose', lr: Math.round(l) + ',' + Math.round(r) }));
  }

  // GESTURE lane — keyframes [{l,r,ms}]. Returns the rid to match in onAck (for queued_ms).
  act(steps, mode = 'replace') {
    const rid = ++this._rid;
    if (_lrSwap() && Array.isArray(steps)) steps = steps.map(s => ({ l: s.r, r: s.l, ms: s.ms }));   // per-device leg-identity swap
    if (this.ready) this.ws.send(JSON.stringify({ t: 'act', rid, steps, mode }));
    return rid;
  }

  routine(name) {
    const rid = ++this._rid;
    if (this.ready) this.ws.send(JSON.stringify({ t: 'routine', rid, name }));
    return rid;
  }

  stop() {
    const rid = ++this._rid;
    if (this.ready) this.ws.send(JSON.stringify({ t: 'stop', rid }));
    return rid;
  }

  close() {
    this._want = false; const gen = ++this._gen;
    clearTimeout(this._t); this._t = null;
    const ws = this.ws; this.ws = null; this.awake = 0;
    try { if (ws) ws.close(); } catch (_) {}
    // Exactly one offline report, as before, and still AFTER the caller has moved on: it used to
    // come from the socket's own close event. A synchronous one made tester/face.html say "Body
    // offline" on every robot switch. Skipped if this body was reconnected in the meantime.
    if (ws) Promise.resolve().then(() => { if (this._gen === gen) this.onStatus(0); });
  }
}
