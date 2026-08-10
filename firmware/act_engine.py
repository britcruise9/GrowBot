"""Keyframe motion engine for the robot body - hardware-free, Mac-testable.

This is the hobby-scale version of "action chunking" from modern robotics
(ACT, Zhao et al. 2023): the brain (phone/LLM) ships a short PLAN of poses,
the body executes it locally at ~50Hz with smooth glides, and the next chunk
may arrive while this one plays - so gestures chain with no dead air, and the
Wi-Fi link only has to carry intent, never per-tick servo commands.

A keyframe: {"l": 0..180, "r": 0..180, "ms": glide-time}
  - l/r are absolute servo degrees (90 = neutral stance)
  - ms = how long the glide TO that pose takes (0 = snap). From a cold
    start (pose unknown) the first frame snaps into place, then holds out
    its ms - a chunk always lasts sum(ms), warm or cold
  - omit "l" or "r" to leave that leg at its current target
  - repeat the same pose to hold it (a musical rest)

Glides are eased with smoothstep (slow-in, slow-out) so motion reads as a
living thing, not a stepper. When the queue drains the engine holds the last
pose briefly, then releases the servos (limp = cool + silent + ~6mA).

No MicroPython imports here. The firmware injects the servo writer, the
release function, and the tick functions; the Mac test injects fakes.
Time follows time.ticks_ms semantics (ticks_ms / ticks_diff).
"""


class ActEngine:
    def __init__(self, write_pose, release, ticks_ms, ticks_diff,
                 max_step_ms=3000, max_queue_ms=15000, hold_ms=300):
        self.write_pose = write_pose    # fn(l_deg_int, r_deg_int)
        self.release = release          # fn() -> go limp
        self.ticks_ms = ticks_ms
        self.ticks_diff = ticks_diff
        self.max_step_ms = max_step_ms
        self.max_queue_ms = max_queue_ms
        self.hold_ms = hold_ms
        self.q = []                     # validated keyframes: (l, r, ms)
        self.cur = None                 # active glide: (fl, fr, tl, tr, ms, t0)
        self.pose = None                # last commanded (l, r); None = unknown
        self.hold_t0 = None             # queue drained at this tick (hold timer)
        self.active = False

    # ---------- feeding ----------

    def enqueue(self, steps, mode="replace"):
        """Validate + queue a chunk. Returns (ok, queued_ms_or_error_string).
        mode "replace": drop the queue AND the in-flight glide; the new chunk
        glides from wherever the legs are right now (smooth takeover).
        mode "append": play after everything already queued (pipelining)."""
        frames = []
        for st in steps:
            try:
                ms = min(int(st.get("ms", 400)), self.max_step_ms)
                l = st.get("l", None)
                r = st.get("r", None)
                l = None if l is None else max(0.0, min(180.0, float(l)))
                r = None if r is None else max(0.0, min(180.0, float(r)))
            except (ValueError, TypeError, AttributeError):
                continue
            if l is None and r is None:
                continue
            frames.append((l, r, max(0, ms)))
        if not frames:
            return False, "no valid keyframes"
        new_ms = sum(f[2] for f in frames)
        if mode == "replace":
            self.q = []
            self.cur = None
        if self.queued_ms() + new_ms > self.max_queue_ms:
            return False, "queue full"
        self.q.extend(frames)
        self.hold_t0 = None
        self.active = True
        return True, self.queued_ms()

    def queued_ms(self):
        total = sum(f[2] for f in self.q)
        if self.cur:
            left = self.cur[4] - self.ticks_diff(self.ticks_ms(), self.cur[5])
            total += max(0, left)
        return total

    def clear(self):
        """Drop all motion (for /stop and manual-control overrides). Does NOT
        release the servos - the caller decides. Pose is forgotten: whoever
        moves the legs next, the following chunk snaps rather than gliding
        from a stale guess."""
        self.q = []
        self.cur = None
        self.hold_t0 = None
        self.pose = None
        self.active = False

    # ---------- playing ----------

    def _write(self, l, r):
        li = int(min(180, max(0, l)) + 0.5)
        ri = int(min(180, max(0, r)) + 0.5)
        if self.pose != (li, ri):
            self.write_pose(li, ri)
            self.pose = (li, ri)

    def _start_next(self, now):
        l, r, ms = self.q.pop(0)
        fl, fr = self.pose if self.pose else (None, None)
        tl = l if l is not None else (fl if fl is not None else 90)
        tr = r if r is not None else (fr if fr is not None else 90)
        if self.pose is None:
            self._write(tl, tr)         # cold start: place the legs at once...
        if ms <= 0:
            self._write(tl, tr)         # explicit snap frame
            return
        # ...then still spend the frame's ms (constant glide = hold), so a
        # chunk lasts sum(ms) whether it started warm or cold.
        self.cur = (self.pose[0], self.pose[1], tl, tr, ms, now)
        self.hold_t0 = None

    def tick(self):
        """Call every main-loop pass (~every 20ms). Returns True while the
        engine owns the legs (glide, or post-drain hold)."""
        if not self.active:
            return False
        now = self.ticks_ms()
        while self.cur is None and self.q:  # ms=0 snap frames chain same-tick
            self._start_next(now)
        if self.cur:
            fl, fr, tl, tr, ms, t0 = self.cur
            p = self.ticks_diff(now, t0) / ms
            if p >= 1.0:
                self._write(tl, tr)
                self.cur = None
                if self.q:
                    self._start_next(now)
                else:
                    self.hold_t0 = now
            else:
                e = p * p * (3.0 - 2.0 * p)     # smoothstep ease
                self._write(fl + (tl - fl) * e, fr + (tr - fr) * e)
            return True
        if self.hold_t0 is None:                # drained with nothing played
            self.hold_t0 = now
        if self.ticks_diff(now, self.hold_t0) >= self.hold_ms:
            self.release()                      # limp; pose kept as best guess
            self.hold_t0 = None
            self.active = False
            return False
        return True
