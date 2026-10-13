/* spin-wire.js: THE spin v4 wiring, shared by the v3 agent (v3/next.html runSpinPolicy) and the tester's Policy tab
   (tester/policy.html RUN SPIN), so the two cannot drift. Classic script, ES2018 only (the iPhone 6 parse law: var and
   function, no arrows, let/const, template literals, ?. or ??). It sets window.GBSpinWire and nothing else. It never
   writes gb_walk_cal: every override lands on the spin walker's OWN cal copy, so the shared physical calibration
   (signs, trims, gain, SWAP) stays exactly what the Manual tab saved, and walk, gestures and get-up never see it.

   WHY. spin v4 (policies/spin-v4-0911.json = gallery 46181387) was trained with a0 ("right_leg") driving the robot's
   LEFT leg (servo L), both joints + toward the battery end, and its UNMIRRORED net turns CCW (0929 sim, DIY v1 body).
   The legacy routing gave it the phone's own signs, ran "right" unmirrored and fed the gyro {x:gamma,y:beta,z:alpha},
   which puts pitch rate in the yaw slot. On Brit's -1/-1 phone it stalled, travelled or turned the wrong way.
   The corrected wiring, logged as wire "trained-0929-gyro" (it shipped 0929 as the opt-in ?spinwire=1 arm):
     signs   L_SIGN -1, R_SIGN +1: this policy's convention on the stock kit's servos. Trims and gain stay the phone's.
             The phone's STORED signs are not used and not a selector: only stored -1/+1 (kit default) and -1/-1 (Brit)
             are hardware-validated with this wiring, and Brit's -1/-1 shows a stored sign is not proof of a reversed
             servo. Every spin_start logs them as phoneSigns/phoneImu so a fleet read can split results by stored set.
             OPEN (Brit's call): route a stored set outside those two (e.g. L_SIGN +1) to a logged legacy arm.
     IMU     IMU_SIGN [1,-1,1] (portrait phone, top at the camera end, into the policy's frame).
     mirror  left/ccw runs the UNmirrored net, right/cw runs it mirrored.
     legs    the per-direction leg swap is unchanged (ccw puts a0/a1 on the other servos).
     gyro    {x:beta, y:alpha, z:gamma}: W3C rotationRate alpha is about device X (measured 0923, the bench robot).
   HARDWARE 0930 (Brit, the bench robot, kit PLA legs, current mount; phone cal L_SIGN -1 R_SIGN -1 L_OFF -8 R_OFF 3
   gain 0.99 turn 0, SWAP off; 10 s asks): hard floor right = CW, left = CCW, carpet right and left both worked.
   Four user-observed first-pass runs. Not measured angles and not a repeatability study.

   WHICH WIRING (select), checked in this order:
     ?spinwire=0                   "legacy"             rollback and A/B compare: exactly the pre-0930 default.
     SWAP on + ?spinwire=1         refused              the explicit arm never guesses on a swapped phone (as 0929).
     SWAP on                       "legacy_swap"        only SWAP off was validated. The relay swaps the ports AFTER this
                                                        routing, and SWAP set on a correctly plugged robot negates poses
                                                        (0929 wiring audit), so a swapped phone keeps today's spin.
     non-stock body, no flag       "legacy_body"        the agent passes the soul's body id; only the stock kit body
                                                        (v3/body.json) was validated. The tester passes none (kit only).
     otherwise                     "trained-0929-gyro"  the default; ?spinwire=1 still accepted (and forces it on a
                                                        non-stock body, as the 0929 arm did).
   Wheels never get here: the agent sends a wheeled body to runDrive before any spin. */
(function (root) {
  var WIRE = "trained-0929-gyro", STOCK_BODY = "growbot-85mm-2leg";
  /* "1", "0" or "" (no flag). Exactly spinwire=1 or spinwire=0; anything else (spinwire=10, xspinwire=1) is no flag. */
  function flag(search) { var m = /[?&]spinwire=([01])(&|$)/.exec(String(search || "")); return m ? m[1] : ""; }
  /* o = {flag, swap, body}. body: the body id, or null when the caller only ever drives the stock kit (the tester). */
  function select(o) {
    o = o || {}; var f = String(o.flag == null ? "" : o.flag);
    if (f === "0") return { wire: "legacy", corrected: false, flag: f };
    if (o.swap) {
      if (f === "1") return { refuse: "the corrected spin needs leg swap off (SWAP is on)", flag: f };
      return { wire: "legacy_swap", corrected: false, flag: f };
    }
    if (f !== "1" && o.body != null && String(o.body) !== STOCK_BODY) return { wire: "legacy_body", corrected: false, flag: f };
    return { wire: WIRE, corrected: true, flag: f };
  }
  /* The cal this spin runs with. Legacy: the SAME object (behaviour byte-identical to pre-0930). Corrected: a copy
     with this policy's signs and IMU; trims, gain, turn and everything else carried over untouched. */
  function spinCal(cal, sel) {
    if (!sel || !sel.corrected) return cal;
    return Object.assign({}, cal, { L_SIGN: -1, R_SIGN: 1, IMU_SIGN: [1, -1, 1] });
  }
  /* Direction dispatch. mirror = the obs mirror, legswap = the servo swap of a0/a1. */
  function route(sel, ccw, swapDeclared) {
    ccw = !!ccw; var sd = !!swapDeclared;
    return { mirror: (sel && sel.corrected) ? !ccw : ccw, legswap: ccw ? !sd : sd };
  }
  /* Wire a freshly built growbot_runner.js Walker for one spin. Throws (the caller's load failure path) when the
     runner cannot mirror and this spin needs it, the same condition the pre-0930 code threw on. */
  function apply(w, sel, ccw) {
    if (((sel && sel.corrected) || ccw) && (!w.setMirror || !w.setSwap)) throw new Error("this runner cannot mirror a spin");
    var r = route(sel, ccw, w.setSwap ? w.spec.swapDeclared : false), phone = w.cal;
    w.cal = spinCal(w.cal, sel);
    if (w.setMirror) w.setMirror(r.mirror);
    if (w.setSwap) w.setSwap(r.legswap);
    return describe(w.cal, sel, r, phone);
  }
  /* The effective wiring, for spin_start and the tester trace. Never throws. phone = the cal as the phone stored it,
     before this spin's override (apply passes it): phoneSigns/phoneImu are the phone's own L_SIGN/R_SIGN and IMU_SIGN,
     which the corrected wiring does NOT use (signs/imu are what it drives with). Only two stored sets are validated on
     hardware with it: -1/+1 (the kit default) and -1/-1 (Brit, the bench robot). A builder who flipped a leg in the Manual
     tab because that servo is physically reversed shows up here as a different set, so a fleet read can split the
     corrected spin's results by stored signs. Legacy: phoneSigns == signs. No phone given: [] (unknown). */
  function describe(c, sel, r, phone) {
    var d = { wire: "", wflag: "", mirrored: false, legswap: false, signs: [], trim: [], imu: [], gyro: "", phoneSigns: [], phoneImu: [] };
    try {
      c = c || {}; sel = sel || {}; r = r || {};
      d.wire = String(sel.wire || ""); d.wflag = String(sel.flag || "");
      d.mirrored = !!r.mirror; d.legswap = !!r.legswap;
      d.signs = [c.L_SIGN, c.R_SIGN]; d.trim = [c.L_OFF, c.R_OFF];
      d.imu = Array.isArray(c.IMU_SIGN) ? c.IMU_SIGN.slice(0, 3) : [];
      d.gyro = sel.corrected ? "b,a,g" : "g,b,a";
      if (phone) {
        d.phoneSigns = [phone.L_SIGN, phone.R_SIGN];
        d.phoneImu = Array.isArray(phone.IMU_SIGN) ? phone.IMU_SIGN.slice(0, 3) : [];
      }
    } catch (e) {}
    return d;
  }
  /* rotationRate (deg/s, {a,b,g}) to the runner's gyro {x,y,z} in rad/s. d = degrees to radians. */
  function gyro(sel, rate, d) {
    if (sel && sel.corrected) return { x: rate.b * d, y: rate.a * d, z: rate.g * d };
    return { x: rate.g * d, y: rate.b * d, z: rate.a * d };
  }
  root.GBSpinWire = { WIRE: WIRE, STOCK_BODY: STOCK_BODY, flag: flag, select: select, spinCal: spinCal, route: route,
    apply: apply, describe: describe, gyro: gyro };
})(typeof window !== "undefined" ? window : this);
