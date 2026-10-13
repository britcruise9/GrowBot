// GrowBot 85mm walk policy — pure-JS forward pass. No deps; runs in the browser
// AND node. Verified bit-equal (<2e-6) to the trained JAX net via shadow_test.mjs.
//
// obs16 = [roll,pitch,yaw, gyroRoll,gyroPitch,gyroYaw, hist5x2 newest-first]
// action = [aRight (a0), aLeft (a1)] in [-1,1], scaled by action_to_rad (±1.5708 = ±90°, the sim's ctrlrange) downstream.

function swish(x){ return x / (1 + Math.exp(-x)); }

export class GrowBotPolicy {
  constructor(j){ this.mean=j.mean; this.std=j.std; this.layers=j.layers; this.n=j.obs_size; }
  // obs: length-16 number[] -> [aRight, aLeft]
  forward(obs){
    let x = new Array(this.n);
    for (let i=0;i<this.n;i++) x[i] = (obs[i]-this.mean[i])/this.std[i];   // normalize
    for (const L of this.layers){
      const W=L.W, b=L.b, out=new Array(b.length).fill(0);
      for (let i=0;i<W.length;i++){ const xi=x[i], Wi=W[i]; for (let j=0;j<Wi.length;j++) out[j]+=xi*Wi[j]; }
      for (let j=0;j<b.length;j++) out[j]+=b[j];
      x = (L.act==='swish') ? out.map(swish) : out;            // linear final layer
    }
    return [Math.tanh(x[0]), Math.tanh(x[1])];                  // deterministic mode = tanh(loc)
  }
}

// Ready-to-wire walker: owns the 5-step action history + calibration + servo mapping,
// mirroring cockpit_bridge.py exactly (the 4 stacked left/right conventions).
export class GrowBotWalker {
  constructor(policyJson, cal={}){
    this.p = new GrowBotPolicy(policyJson);
    this.hist = [0,0,0,0,0,0,0,0,0,0];          // 5x2 newest-first, flattened
    this.toRad = policyJson.action_to_rad || 1.5708;   // action [-1,1] -> joint RADIANS, matching the sim's ctrlrange ±1.57 (Harsh 2026-06-22: this was missing — legs under-swung ±57° instead of ±90°)
    this.cal = Object.assign({L_SIGN:-1,R_SIGN:1,L_OFF:0,R_OFF:0,IMU_SIGN:[1,-1,1],gain:1,turn:0}, cal);  // pitch flipped: per-build, this body 2026-06-15
  }
  reset(){ this.hist = this.hist.map(()=>0); }
  // imu in RADIANS: {roll,pitch,yaw, gr,gp,gy}. returns {l,r} servo degrees (0-180) + raw action.
  step(imu){
    const s=this.cal.IMU_SIGN;
    const obs=[ s[0]*imu.roll, s[1]*imu.pitch, s[2]*imu.yaw,
                s[0]*imu.gr,  s[1]*imu.gp,    s[2]*imu.gy, ...this.hist];
    const a=this.p.forward(obs);                 // [aRight, aLeft]
    this.hist = [a[0],a[1], ...this.hist.slice(0,8)];   // push newest-first, drop oldest
    const c=this.cal, deg=v=>v*this.toRad*180/Math.PI;          // action -> servo degrees (toRad=π/2 → ±90°, matches the sim ctrlrange ±1.57)
    let l = 90 + c.L_OFF + c.L_SIGN*deg(a[1])*c.gain + c.turn;   // a[1]=left -> port1
    let r = 90 + c.R_OFF + c.R_SIGN*deg(a[0])*c.gain - c.turn;   // a[0]=right -> port3
    const clamp=v=>Math.max(0,Math.min(180,v));
    return { l:clamp(l), r:clamp(r), action:a };
  }
}

// Steerable walker — runs a policy that declares an obs_spec of stacked frames incl. a joystick command.
// (mels.a's kppy6: obs90 = 10 channels x 9 frames, NEWEST-FIRST frame-major:
//   [accel_x,accel_y,accel_z, gyro_x,gyro_y,gyro_z, prevAction_0(right),prevAction_1(left), cmdForward, cmdYaw].)
// The NETWORK runs through GrowBotPolicy.forward (any depth, swish); this class owns the frame-ring,
// the action feedback, and the servo map. Action is scaled by obs_spec.action_to_rad (±1.57 rad = ±90°).
export class SteerableWalker {
  constructor(policyJson, cal={}){
    this.p = new GrowBotPolicy(policyJson);
    const sp = policyJson.obs_spec || {};
    this.nch = (sp.channels && sp.channels.length) || 10;
    this.frames = sp.frames || Math.round((policyJson.obs_size||90)/this.nch);
    this.toRad = sp.action_to_rad || 1.5708;                                  // [-1,1] action -> radians
    this.cal = Object.assign({L_SIGN:-1,R_SIGN:1,L_OFF:0,R_OFF:0,IMU_SIGN:[1,-1,1],gain:1,turn:0}, cal);
    this.reset();
  }
  reset(){ this.ring=[]; for(let i=0;i<this.frames;i++) this.ring.push(new Array(this.nch).fill(0)); this.last=[0,0]; }
  // accel/gyro: {x,y,z} already rotated into the body frame (accel m/s² gravity-incl; gyro rad/s). cmd:{fwd,yaw}.
  step(accel, gyro, cmd){
    const s=this.cal.IMU_SIGN;                                                // bench-tunable axis signs (shared w/ the classic walker)
    const frame=[ s[0]*accel.x, s[1]*accel.y, s[2]*accel.z,
                  s[0]*gyro.x,  s[1]*gyro.y,  s[2]*gyro.z,
                  this.last[0], this.last[1], cmd.fwd, cmd.yaw ];
    this.ring.unshift(frame); if(this.ring.length>this.frames) this.ring.pop();
    const obs=[]; for(const f of this.ring) for(const v of f) obs.push(v);    // flatten newest-first, frame-major
    const a=this.p.forward(obs);                                             // [aRight, aLeft] in [-1,1]
    this.last=a;                                                             // feed the actually-sent action back
    const c=this.cal, deg=v=>v*this.toRad*180/Math.PI;                       // action -> servo degrees (toRad=π/2 → ±90°)
    let l = 90 + c.L_OFF + c.L_SIGN*deg(a[1])*c.gain + c.turn;               // a[1]=left -> port1
    let r = 90 + c.R_OFF + c.R_SIGN*deg(a[0])*c.gain - c.turn;               // a[0]=right -> port3
    const clamp=v=>Math.max(0,Math.min(180,v));
    return { l:clamp(l), r:clamp(r), action:a, dbg:{ax:frame[0],ay:frame[1],az:frame[2],gx:frame[3],gy:frame[4],gz:frame[5]} };
  }
}
