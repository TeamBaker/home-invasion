// HOME INVASION — Mixed Reality horror for Meta Quest (WebXR, three.js)
//
// Rig:   scene ─ dolly (Group) ─ camera (HMD pose is applied relative to dolly)
//                              ├ controller grips
// The monster chases the *camera's world position* (your real head, plus any
// stick locomotion), so physically walking away matters as much as the stick.
//
// Room sensing: on Quest the session asks for plane-detection / mesh-detection.
// Detected floor, walls and furniture become a nav grid in *room space* (the XR
// reference space = the dolly's local space). The monster walks on the detected
// floor, can't pass through walls or your couch, and paths around them to reach you.
// Note: stick locomotion moves you relative to the real room too, so if you slide,
// the room "comes with you" and the monster is re-constrained to wherever it now is.

import * as THREE from 'three';
import { RoomSense } from './room.js';
import { FLASH, shadowFov, receiverShaders } from './flashlight.js';

// ───────────────────────────── config ─────────────────────────────
const CFG = {
  // locomotion
  moveSpeed: 2.0,          // m/s at full stick
  accel: 10,               // velocity smoothing when pushing the stick
  decel: 14,               // smoothing when releasing (stops quick, no ice-skating)
  deadzone: 0.15,
  responseCurve: 1.4,      // >1 = finer control near the center of the stick
  snapAngle: THREE.MathUtils.degToRad(30),
  snapPress: 0.7,          // stick must pass this to fire a snap
  snapRelease: 0.3,        // ...and return under this before the next one
  // monster
  startSpeed: 0.55,        // m/s
  maxSpeed: 1.35,
  speedRampPerSec: 0.012,  // gets faster the longer you survive
  lurchChance: 0.18,       // chance per second of a sudden burst
  lurchMul: 2.3,
  catchDistance: 0.5,      // horizontal metres HMD ↔ monster
  spawnDistance: 6,
  leashDistance: 14,       // farther than this + out of view = it relocates behind you
  stride: 0.7,             // metres per footstep
  stuckRespawn: 6,         // s without progress (and out of view) → relocate to a reachable spot
  roomCaptureDelay: 3,     // s with no scan data before asking Quest to run room setup
  desktopEyeHeight: 1.6,
};

const UP = new THREE.Vector3(0, 1, 0);
const clamp = THREE.MathUtils.clamp;
const rand = (a, b) => a + Math.random() * (b - a);
const lerpAngle = (a, b, t) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

// ───────────────────────────── renderer / scene ─────────────────────────────
let renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000, 0);          // transparent → passthrough shows through
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 100);
camera.position.y = CFG.desktopEyeHeight;

const dolly = new THREE.Group();
dolly.add(camera);
scene.add(dolly);

scene.add(new THREE.HemisphereLight(0x8a96a8, 0x120000, 0.7));
const key = new THREE.DirectionalLight(0xffffff, 0.35);
key.position.set(2, 4, 1);
scene.add(key);

// VR / desktop only: a floor so you're not floating in a void.
const vrEnv = new THREE.Group();
vrEnv.add(new THREE.GridHelper(60, 60, 0x551111, 0x221010));
scene.add(vrEnv);
const VR_BG = new THREE.Color(0x040404);

function setPassthrough(on) {
  vrEnv.visible = !on;
  scene.background = on ? null : VR_BG;
  scene.fog = on ? null : new THREE.FogExp2(0x040404, 0.09);
}
setPassthrough(false);

// Controller grips — small markers so you can see your hands in VR mode.
// Keyed by handedness so the flashlight can follow the right controller.
const grips = new Map();
for (let i = 0; i < 2; i++) {
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.03, 0.1),
    new THREE.MeshStandardMaterial({ color: 0x333333 }),
  ));
  dolly.add(grip);
  grip.addEventListener('connected', (e) => { grips.set(e.data.handedness, grip); });
  grip.addEventListener('disconnected', (e) => { grips.delete(e.data.handedness); });
}
// Target-ray (pointing) spaces — the flashlight aims along these so the beam goes
// where the controller points (grip space -Z runs along the handle, tilted down).
const aims = new Map();
for (let i = 0; i < 2; i++) {
  const aim = renderer.xr.getController(i);
  dolly.add(aim);
  aim.addEventListener('connected', (e) => { aims.set(e.data.handedness, aim); });
  aim.addEventListener('disconnected', (e) => { aims.delete(e.data.handedness); });
}

// ───────────────────────────── head-locked UI ─────────────────────────────
// DOM isn't visible in XR, so we use a canvas texture parented to the camera.
const hud = (() => {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 512;
  const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 0.4),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }),
  );
  mesh.position.set(0, -0.02, -1);
  mesh.renderOrder = 1000;
  mesh.visible = false;
  camera.add(mesh);

  let timer = 0;
  return {
    show(title, sub = '', hint = '', { panel = true, duration = 0 } = {}) {
      g.clearRect(0, 0, 1024, 512);
      if (panel) {
        g.fillStyle = 'rgba(0,0,0,0.78)';
        g.fillRect(0, 0, 1024, 512);
        g.strokeStyle = '#8a0000'; g.lineWidth = 6;
        g.strokeRect(8, 8, 1008, 496);
      }
      g.textAlign = 'center';
      g.fillStyle = '#d40000';
      g.shadowColor = '#ff0000'; g.shadowBlur = 30;
      g.font = 'bold 120px Georgia, serif';
      g.fillText(title, 512, 210);
      g.shadowBlur = 0;
      g.fillStyle = '#eee'; g.font = '44px Georgia, serif';
      g.fillText(sub, 512, 310);
      g.fillStyle = '#999'; g.font = 'italic 34px Georgia, serif';
      g.fillText(hint, 512, 400);
      tex.needsUpdate = true;
      mesh.visible = true;
      timer = duration;
    },
    hide() { mesh.visible = false; timer = 0; },
    update(dt) { if (timer > 0 && (timer -= dt) <= 0) mesh.visible = false; },
  };
})();

// Red "blood" vignette sphere around the head: pulses with proximity, floods on death.
const bloodMat = new THREE.MeshBasicMaterial({
  color: 0x8a0000, transparent: true, opacity: 0,
  side: THREE.BackSide, depthTest: false, depthWrite: false,
});
const blood = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), bloodMat);
blood.renderOrder = 999;
camera.add(blood);

// ───────────────────────────── audio (all procedural) ─────────────────────────────
const listener = new THREE.AudioListener();
camera.add(listener);

class HorrorAudio {
  constructor(listener) {
    const ctx = this.ctx = listener.context;
    this.started = false;

    // Shared output for non-spatial sounds, with a limiter so the scare doesn't clip.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -10; this.comp.ratio.value = 12;
    this.comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.comp);

    // 2s white noise buffer reused by everything.
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Spatial voice of the monster (footsteps, growls). Added to the monster mesh later.
    this.voice = new THREE.PositionalAudio(listener);
    this.voiceBus = ctx.createGain();
    this.voice.setNodeSource(this.voiceBus);
    this.voice.setRefDistance(1.2);
    this.voice.setRolloffFactor(1.6);
    this.voice.setDistanceModel('inverse');
    this.voice.panner.panningModel = 'HRTF';

    this.tension = 0;
    this.heartTimer = 1;
    this.growlTimer = 6;
  }

  noiseSrc(loop = false) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise; s.loop = loop;
    return s;
  }

  start() {
    if (this.started) return;
    this.started = true;
    const ctx = this.ctx, t = ctx.currentTime;

    // Drone: detuned low saws + sub sine through a resonant, slowly swept lowpass.
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 160;
    this.droneFilter.Q.value = 7;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.setValueAtTime(0, t);
    this.droneGain.gain.linearRampToValueAtTime(0.22, t + 4);
    this.droneFilter.connect(this.droneGain).connect(this.master);

    for (const [type, f] of [['sawtooth', 55], ['sawtooth', 55.6], ['sawtooth', 82.7], ['sine', 41.2]]) {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = type === 'sine' ? 0.8 : 0.35;
      o.connect(g).connect(this.droneFilter);
      o.start();
    }
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 70;
    lfo.connect(lfoAmt).connect(this.droneFilter.frequency);
    lfo.start();

    // Air: band-passed noise, like wind in a vent.
    const air = this.noiseSrc(true);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 450; bp.Q.value = 0.8;
    this.airGain = ctx.createGain(); this.airGain.gain.value = 0.035;
    air.connect(bp).connect(this.airGain).connect(this.master);
    air.start();
    const lfo2 = ctx.createOscillator(); lfo2.frequency.value = 0.13;
    const lfo2Amt = ctx.createGain(); lfo2Amt.gain.value = 250;
    lfo2.connect(lfo2Amt).connect(bp.frequency);
    lfo2.start();
  }

  // 0 = far away, 1 = it's on top of you.
  setTension(t, dt) {
    if (!this.started) return;
    this.tension = t;
    const now = this.ctx.currentTime;
    this.droneFilter.frequency.setTargetAtTime(160 + t * 650, now, 0.3);
    this.droneGain.gain.setTargetAtTime(0.22 + t * 0.25, now, 0.3);

    if (t > 0.15) {
      this.heartTimer -= dt;
      if (this.heartTimer <= 0) {
        this.heartbeat(0.25 + t * 0.6);
        this.heartTimer = THREE.MathUtils.lerp(1.1, 0.38, t);
      }
    }
    this.growlTimer -= dt;
    if (this.growlTimer <= 0) {
      this.growl();
      this.growlTimer = rand(5, 11) * (1 - t * 0.5);
    }
  }

  thump(dest, when, f0, f1, dur, vol) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f0, when);
    o.frequency.exponentialRampToValueAtTime(f1, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g).connect(dest);
    o.start(when); o.stop(when + dur + 0.05);
  }

  footstep() {
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime;
    this.thump(this.voiceBus, t, 95, 38, 0.28, 1.0);
    // Wet, dragging scrape
    const n = this.noiseSrc();
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = rand(500, 900);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + rand(0.15, 0.3));
    n.connect(lp).connect(g).connect(this.voiceBus);
    n.start(t, rand(0, 1.5), 0.4);
  }

  heartbeat(vol) {
    const t = this.ctx.currentTime;
    this.thump(this.master, t, 60, 35, 0.16, vol);
    this.thump(this.master, t + 0.18, 55, 32, 0.2, vol * 0.75);
  }

  growl() {
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime, dur = rand(1.2, 2.2);
    const n = this.noiseSrc();
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 4;
    bp.frequency.setValueAtTime(rand(180, 260), t);
    bp.frequency.linearRampToValueAtTime(rand(90, 140), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1.6, t + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // Tremolo for a rattling throat.
    const trem = ctx.createOscillator(); trem.frequency.value = rand(18, 30);
    const tremAmt = ctx.createGain(); tremAmt.gain.value = 0.6;
    const tremGain = ctx.createGain(); tremGain.gain.value = 0.6;
    trem.connect(tremAmt).connect(tremGain.gain);
    n.connect(bp).connect(g).connect(tremGain).connect(this.voiceBus);
    n.start(t, 0, dur + 0.1); trem.start(t); trem.stop(t + dur + 0.1);
  }

  jumpscare() {
    const ctx = this.ctx, t = ctx.currentTime;
    const out = ctx.createGain(); out.gain.value = 1.0;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = (1 + 40) * x / (1 + 40 * Math.abs(x)); }
    shaper.curve = curve;
    shaper.connect(out).connect(this.master);

    // Dissonant screaming cluster, sweeping up.
    for (const f of [220, 233, 311, 466, 698]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 1.6, t + 0.25);
      o.frequency.exponentialRampToValueAtTime(f * 0.7, t + 1.8);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.25, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.9);
      o.connect(g).connect(shaper);
      o.start(t); o.stop(t + 2);
    }
    // Noise blast
    const n = this.noiseSrc();
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 700;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(1.2, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    n.connect(hp).connect(ng).connect(this.master);
    n.start(t);
    // Sub hit
    this.thump(this.master, t, 80, 25, 1.2, 1.0);
  }
}

const audio = new HorrorAudio(listener);

// ───────────────────────────── monster ─────────────────────────────
// Deterministic per-position noise so shared vertices (seams) move together → no cracks.
function distort(geo, amount) {
  const p = geo.attributes.position;
  const h = (x, y, z, s) => {
    const v = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + s) * 43758.5453;
    return (v - Math.floor(v)) - 0.5;
  };
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const kx = Math.round(x * 1e4) / 1e4, ky = Math.round(y * 1e4) / 1e4, kz = Math.round(z * 1e4) / 1e4;
    p.setXYZ(i, x + h(kx, ky, kz, 1) * amount, y + h(kx, ky, kz, 2) * amount, z + h(kx, ky, kz, 3) * amount);
  }
  geo.computeVertexNormals();
  return geo;
}

class Monster {
  constructor() {
    const skin = new THREE.MeshStandardMaterial({
      color: 0x0b0b0d, roughness: 0.95, metalness: 0, flatShading: true, emissive: 0x060000,
    });
    const limb = (len, rTop, rBot, seg = 6) => {
      const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 4);
      g.translate(0, -len / 2, 0);
      return new THREE.Mesh(distort(g, 0.012), skin);
    };

    // Built facing +Z with feet at y=0 (Object3D convention).
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);

    const hipY = 1.24;
    this.hips = new THREE.Group();
    this.hips.position.y = hipY;
    this.body.add(this.hips);

    // Legs — thigh + shin, knees bend backward.
    this.legs = [];
    for (const side of [-1, 1]) {
      const thigh = new THREE.Group();
      thigh.position.x = 0.11 * side;
      this.hips.add(thigh);
      thigh.add(limb(0.62, 0.055, 0.035));
      const knee = new THREE.Group();
      knee.position.y = -0.62;
      thigh.add(knee);
      knee.add(limb(0.6, 0.035, 0.02));
      const foot = new THREE.Mesh(distort(new THREE.BoxGeometry(0.06, 0.03, 0.22, 2, 1, 3).translate(0, 0, 0.07), 0.01), skin);
      foot.position.y = -0.61;
      knee.add(foot);
      this.legs.push({ thigh, knee });
    }

    // Spine — hunched forward.
    this.spine = new THREE.Group();
    this.spine.rotation.x = 0.38;
    this.hips.add(this.spine);
    const torsoGeo = new THREE.CylinderGeometry(0.17, 0.08, 0.85, 7, 6);
    torsoGeo.translate(0, 0.425, 0);
    torsoGeo.scale(1, 1, 0.55);
    this.spine.add(new THREE.Mesh(distort(torsoGeo, 0.045), skin));
    // Vertebrae poking out of the back.
    for (let i = 0; i < 7; i++) {
      const v = new THREE.Mesh(new THREE.SphereGeometry(0.025 + Math.random() * 0.012, 5, 4), skin);
      v.position.set(0, 0.1 + i * 0.11, -0.075 - Math.sin(i / 6 * Math.PI) * 0.03);
      this.spine.add(v);
    }

    // Neck + head, cocked at a wrong angle.
    const neck = new THREE.Group();
    neck.position.set(0.02, 0.84, 0.02);
    neck.rotation.set(0.5, 0, -0.15);
    this.spine.add(neck);
    neck.add(limb(0.32, 0.03, 0.045).rotateX(Math.PI)); // limb hangs down; flip so it points up
    this.head = new THREE.Group();
    this.head.position.y = 0.32;
    neck.add(this.head);
    this.headBase = new THREE.Euler(-0.75, 0.1, 0.38);
    this.head.rotation.copy(this.headBase);

    const skull = new THREE.SphereGeometry(0.14, 10, 8);
    skull.scale(0.8, 1.4, 0.9);
    const skullMesh = new THREE.Mesh(distort(skull, 0.03), skin);
    skullMesh.position.y = 0.13;
    this.head.add(skullMesh);

    // Mismatched glowing eyes.
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xfff0cc });
    for (const [x, r] of [[-0.045, 0.024], [0.05, 0.015]]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), eyeMat);
      eye.position.set(x, 0.17 + (x > 0 ? -0.012 : 0), 0.105);
      this.head.add(eye);
    }
    // Long gash of a mouth.
    this.mouth = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.16, 0.03),
      new THREE.MeshBasicMaterial({ color: 0x300000 }),
    );
    this.mouth.position.set(0.005, 0.02, 0.1);
    this.mouth.rotation.z = 0.12;
    this.head.add(this.mouth);
    this.face = new THREE.Object3D();
    this.face.position.set(0, 0.15, 0.12);
    this.head.add(this.face);

    const glow = new THREE.PointLight(0xff2200, 0.8, 2.5);
    glow.position.set(0, 0.15, 0.25);
    this.head.add(glow);

    // Arms — too long, asymmetric, hands with spindly fingers.
    this.arms = [];
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(0.19 * side, 0.78 + (side > 0 ? 0.05 : -0.03), 0);
      shoulder.rotation.z = 0.12 * side;
      this.spine.add(shoulder);
      const upperLen = 0.6 + (side > 0 ? 0.08 : 0);
      shoulder.add(limb(upperLen, 0.04, 0.03));
      const elbow = new THREE.Group();
      elbow.position.y = -upperLen;
      shoulder.add(elbow);
      elbow.add(limb(0.62, 0.03, 0.018));
      const hand = new THREE.Group();
      hand.position.y = -0.62;
      elbow.add(hand);
      for (let i = 0; i < 4; i++) {
        const f = limb(0.2 + Math.random() * 0.09, 0.011, 0.003, 4);
        f.rotation.set(-0.25, 0, (i - 1.5) * 0.2);
        hand.add(f);
      }
      this.arms.push({ shoulder, elbow, hand, side });
    }

    this.root.add(audio.voice);
    audio.voice.position.y = 0.8;

    this.phase = 0;
    this.lastStep = 0;
    this.reach = 0;
    this.twitch = new THREE.Vector3();
    this.twitchTimer = 2;
  }

  // speed in m/s, dist to player in metres (for reaching), dt in seconds.
  animate(dt, speed, dist, frantic = false) {
    // Gait
    this.phase += (speed * dt / CFG.stride) * Math.PI;
    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    const swing = 0.45 * clamp(speed / 0.8, 0.4, 1.4);
    this.legs[0].thigh.rotation.x = s * swing;
    this.legs[1].thigh.rotation.x = -s * swing;
    this.legs[0].knee.rotation.x = Math.max(0, c) * 0.9;
    this.legs[1].knee.rotation.x = Math.max(0, -c) * 0.9;
    this.body.position.y = -Math.abs(c) * 0.05;
    this.body.rotation.z = s * 0.06;
    this.spine.rotation.y = s * 0.12;

    const step = Math.floor(this.phase / Math.PI);
    if (step !== this.lastStep) { this.lastStep = step; audio.footstep(); }

    // Arms: dangle and swing, then rise to grab as it gets close.
    const targetReach = frantic ? 1 : clamp((3.5 - dist) / 2.5, 0, 1);
    this.reach += (targetReach - this.reach) * (1 - Math.exp(-3 * dt));
    for (const a of this.arms) {
      const armSwing = (a.side < 0 ? -s : s) * 0.3;
      const grabTwitch = Math.sin(performance.now() * 0.02 + a.side) * 0.08 * this.reach;
      a.shoulder.rotation.x = -0.38 + THREE.MathUtils.lerp(-0.1 + armSwing, -1.5 + grabTwitch, this.reach);
      a.elbow.rotation.x = THREE.MathUtils.lerp(-0.25, -0.05, this.reach);
      a.hand.rotation.x = THREE.MathUtils.lerp(0, -0.4, this.reach);
    }

    // Head: sharp random twitches that ease back.
    this.twitchTimer -= dt;
    if (this.twitchTimer <= 0) {
      this.twitch.set(rand(-0.4, 0.4), rand(-0.7, 0.7), rand(-0.9, 0.9));
      this.twitchTimer = frantic ? 0.05 : rand(1.2, 4.5);
    }
    this.twitch.multiplyScalar(Math.exp(-6 * dt));
    this.head.rotation.set(
      this.headBase.x + this.twitch.x,
      this.headBase.y + this.twitch.y,
      this.headBase.z + this.twitch.z,
    );
    this.mouth.scale.y = 0.6 + this.reach * 1.3 + (frantic ? Math.random() * 0.8 : 0);

    // Occasional one-frame glitch squash.
    if (Math.random() < (frantic ? 0.3 : 0.01)) this.body.scale.set(rand(0.85, 1.2), rand(0.95, 1.05), 1);
    else this.body.scale.set(1, 1, 1);
  }
}

const monster = new Monster();
scene.add(monster.root);
monster.root.visible = false;

// ───────────────────────────── room sensing ─────────────────────────────
const room = new RoomSense(dolly);
function toggleDebug() {
  room.setDebug(!room.debug);
  hud.show('', room.debug ? 'room overlay ON' : 'room overlay OFF', room.summary(), { panel: false, duration: 1.5 });
}

// ───────────────────────────── input ─────────────────────────────
const keys = new Set();
addEventListener('keydown', (e) => {
  keys.add(e.code);

  // Tab toggles the settings panel (desktop).
  if (e.code === 'Tab') {
    e.preventDefault();
    toggleSettingsPanel();
    return;
  }

  // While the panel is open, arrows/Enter drive the panel instead of the game.
  if (settingsPanelOpen) {
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      settingsCursor = clamp(settingsCursor + (e.code === 'ArrowUp' ? -1 : 1), 0, 10);
      updateSettingsPanel();
      return;
    }
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      if (settingsCursor === 1) {
        roomBrightness = Math.max(0, Math.min(100, roomBrightness + (e.code === 'ArrowRight' ? 1 : -1)));
        localStorage.setItem('mrh-room-brightness', String(roomBrightness));
        applyDarknessLevels();
        updateSettingsPanel();
      } else if (settingsCursor === 2) {
        maskStrength = Math.max(0, Math.min(100, maskStrength + (e.code === 'ArrowRight' ? 5 : -5)));
        localStorage.setItem('mrh-mask-strength', String(maskStrength));
        applyDarknessLevels();
        updateSettingsPanel();
      } else if (settingsCursor === 3) {
        flashFalloffFt = Math.max(1, Math.min(39, flashFalloffFt + (e.code === 'ArrowRight' ? 1 : -1)));
        localStorage.setItem('mrh-flash-dist', String(flashFalloffFt));
        updateSettingsPanel();
      } else if (settingsCursor === 4) {
        flashFade = Math.max(0, Math.min(100, flashFade + (e.code === 'ArrowRight' ? 5 : -5)));
        localStorage.setItem('mrh-flash-fade', String(flashFade));
        updateSettingsPanel();
      } else if (settingsCursor === 7) {
        beamGlowLevel = Math.max(0, Math.min(100, beamGlowLevel + (e.code === 'ArrowRight' ? 5 : -5)));
        localStorage.setItem('mrh-beam-glow', String(beamGlowLevel));
        updateBeamGlow();
        updateSettingsPanel();
      } else if (settingsCursor === 8) {
        flashOver = Math.max(0, Math.min(100, flashOver + (e.code === 'ArrowRight' ? 5 : -5)));
        localStorage.setItem('mrh-flash-over2', String(flashOver));
        if (flashlightOver) {
          flashlightOver.visible = flashlightMode && flashOver > 0;
        }
        updateSettingsPanel();
      } else if (settingsCursor === 9) {
        lightBlur = Math.max(0, Math.min(20, lightBlur + (e.code === 'ArrowRight' ? 1 : -1)));
        localStorage.setItem('mrh-light-blur', String(lightBlur));
        updateSettingsPanel();
      }
      return;
    }
    if (e.code === 'Enter') {
      if (settingsCursor === 0) toggleFlashlightMode();
      else if (settingsCursor === 5) {
        flashBeam = !flashBeam;
        localStorage.setItem('mrh-flash-beam', flashBeam ? '1' : '0');
        updateBeamGlow();
      } else if (settingsCursor === 6) {
        flashThruFurniture = !flashThruFurniture;
        localStorage.setItem('mrh-flash-thru2', flashThruFurniture ? '1' : '0');
      } else if (settingsCursor === 10) {
        blurDynOnly = !blurDynOnly;
        localStorage.setItem('mrh-blur-dyn', blurDynOnly ? '1' : '0');
      }
      updateSettingsPanel();
      return;
    }
    if (e.code === 'Escape') toggleSettingsPanel();
    return;
  }

  if (e.code === 'KeyQ' || e.code === 'ArrowLeft') pendingSnap += 1;
  if (e.code === 'KeyE' || e.code === 'ArrowRight') pendingSnap -= 1;
  if (e.code === 'Space') pendingTrigger = true;

  if (e.code === "KeyF") toggleFlashlightMode();
  if (e.code === 'KeyG') toggleDebug();
});
addEventListener('keyup', (e) => keys.delete(e.code));
let pendingTrigger = false;
let pendingSnap = 0; // desktop only (keyboard is edge-triggered already)

// Flashlight mode variables
let flashlightMode = false;
let flashlightModel = null;
let stencilWriter = null;    // writes stencil mask where light reaches
let beamGlow = null;         // visible glow effect
let darknessOverlay = null;  // darkness overlay with stencil test
let flashlightFlickerTime = 0;
let roomBrightness = +(localStorage.getItem('mrh-room-brightness') || 0);  // 0 = pitch black, 100 = fully lit
const _storedMask = localStorage.getItem('mrh-mask-strength');
let maskStrength = _storedMask === null ? 100 : Math.max(0, Math.min(100, +(_storedMask) || 0));  // % of darkness the light spot removes
const _storedDist = localStorage.getItem('mrh-flash-dist');
let flashFalloffFt = _storedDist === null ? 20 : Math.max(1, Math.min(39, Math.round(+(_storedDist) || 20)));  // flashlight falloff DISTANCE in feet (linear fade to black over it)
const _storedFade = localStorage.getItem('mrh-flash-fade');
let flashFade = _storedFade === null ? 30 : Math.max(0, Math.min(100, +(_storedFade) || 0));  // edge fade strength (0-100%)
const _storedBeam = localStorage.getItem('mrh-flash-beam');
let flashBeam = _storedBeam === null ? false : _storedBeam === '1';  // beam glow effect on/off
const _storedThru = localStorage.getItem('mrh-flash-thru2');
let flashThruFurniture = _storedThru === null ? false : _storedThru === '1';  // ON: furniture is invisible to the flashlight (visual occlusion only)
const _storedBlur = localStorage.getItem('mrh-light-blur');
let lightBlur = _storedBlur === null ? 6 : Math.max(0, Math.min(20, Math.round(+(_storedBlur) || 6)));  // Gaussian blur strength for the vis field: higher = softer lit/unlit transition
const _storedBlurDyn = localStorage.getItem('mrh-blur-dyn');
let blurDynOnly = _storedBlurDyn === null ? true : _storedBlurDyn === '1';  // ON: the blur only softens the dynamic mesh (furniture); OFF: it softens everything
const _storedGlow = localStorage.getItem('mrh-beam-glow');
let beamGlowLevel = _storedGlow === null ? 40 : Math.max(0, Math.min(100, +(_storedGlow) || 0));  // beam visibility (0-100%)
const _storedOver = localStorage.getItem('mrh-flash-over2');
let flashOver = _storedOver === null ? 10 : Math.max(0, Math.min(100, Math.round(+(_storedOver) || 0)));  // over reach: white core ends at this % of the falloff distance
let spotGroup = null;        // light receivers: stencil-only redraw of the room/monster, lit per pixel
let coneDarkness = null;     // second darkness pass drawn ONLY inside the light spot
let flashlightOver = null;   // over-bright additive pass inside the light spot

// Flashlight = one direct spotlight with a real shadow map (see js/flashlight.js for
// cone / range / bias tuning). No raycasts, no bounce light.
let lightCam = null;         // shadow camera = the flashlight
let shadowRT = null;         // depth-only shadow map
let visRT = null;            // visibility render target (left eye)
let visRT2 = null;           // visibility render target (right eye)
let visBlurRT = null;        // Gaussian-blurred vis (left/desktop)
let visBlurRT2 = null;       // Gaussian-blurred vis (right eye)
let blurTmpRT = null;        // scratch target for the separable passes
let blurCam = null;
let blurMat = null;
let blurQuad = null;
let blurScene = null;
let visEyeL = null;          // dedicated camera for the visibility pass (left eye)
let visEyeR = null;          // dedicated camera for the visibility pass (right eye)
let casterScene = null;      // depth-pass proxies (separate scene → no recursion into main render)
let casterMat = null;
let receiverMat = null;
let receiverMatThru = null;
let receiverMatStruct = null;   // structure class: never blurred   // SHINE THRU variant: no away-face test — whole silhouette gets stencil
const lightProxies = new Map();  // source mesh → { recv, cast, stamp }
let proxyStamp = 0;
let visFrameStamp = 0;

// Settings panel (Y button / Tab)
let settingsPanelOpen = false;
let settingsCursor = 0;
let settingsPanel = null;      // camera-attached canvas quad (XR-visible)
let settingsCanvas = null;
let settingsCtx = null;
let settingsTex = null;
let turnSuppressed = false;
let settingsBtnWasDown = false;
let settingsStickWasZero = true;
let settingsTriggerWasDown = false;


// Desktop mouse look (pointer lock).
renderer.domElement.addEventListener('click', () => {
  if (mode === 'desktop') {
    pendingTrigger = true;
    lockPointer();
  }
});
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  dolly.rotation.y -= e.movementX * 0.0025;
  camera.rotation.x = clamp(camera.rotation.x - e.movementY * 0.0025, -1.3, 1.3);
});

const input = { moveX: 0, moveY: 0, turnX: 0 };
let debugBtnWasDown = false;
function readInput() {
  input.moveX = input.moveY = input.turnX = 0;
  const session = renderer.xr.getSession();
  if (session) {
    for (const src of session.inputSources) {
      const gp = src.gamepad;
      // Left X button (xr-standard index 4) toggles the room overlay.
      if (gp && src.handedness === 'left') {
        const down = !!gp.buttons[4]?.pressed;
        if (down && !debugBtnWasDown) toggleDebug();
        debugBtnWasDown = down;
      }

      // Settings panel handling for right controller
      if (gp && src.handedness === 'right') {
        // Y button (buttons[5]) toggles the settings panel
        const btn5Down = !!gp.buttons[5]?.pressed;
        if (btn5Down && !settingsBtnWasDown) toggleSettingsPanel();
        settingsBtnWasDown = btn5Down;

        // Trigger press (buttons[0]) selects the highlighted row
        const triggerDown = !!gp.buttons[0]?.pressed;
        if (triggerDown && !settingsTriggerWasDown && settingsPanelOpen) {
          if (settingsCursor === 0) toggleFlashlightMode();
          else if (settingsCursor === 5) {
            flashBeam = !flashBeam;
            localStorage.setItem('mrh-flash-beam', flashBeam ? '1' : '0');
            updateBeamGlow();
          } else if (settingsCursor === 6) {
            flashThruFurniture = !flashThruFurniture;
            localStorage.setItem('mrh-flash-thru2', flashThruFurniture ? '1' : '0');
          } else if (settingsCursor === 10) {
            blurDynOnly = !blurDynOnly;
            localStorage.setItem('mrh-blur-dyn', blurDynOnly ? '1' : '0');
          }
          updateSettingsPanel();
        }
        settingsTriggerWasDown = triggerDown;

        // Thumbstick navigation: up/down = cursor, left/right = brightness (row 1)
        if (settingsPanelOpen && gp.axes.length >= 4) {
          const stickX = gp.axes[2];
          const stickY = gp.axes[3];
          const stickMoved = Math.abs(stickY) > 0.3 || Math.abs(stickX) > 0.3;

          if (stickMoved && settingsStickWasZero) {
            if (Math.abs(stickY) > Math.abs(stickX)) {
              settingsCursor = stickY < 0 ? Math.max(0, settingsCursor - 1) : Math.min(10, settingsCursor + 1);
              updateSettingsPanel();
            } else if (settingsCursor === 1) {
              roomBrightness = Math.max(0, Math.min(100, roomBrightness + (stickX > 0 ? 1 : -1)));
              localStorage.setItem('mrh-room-brightness', String(roomBrightness));
              applyDarknessLevels();
              updateSettingsPanel();
            } else if (settingsCursor === 2) {
              maskStrength = Math.max(0, Math.min(100, maskStrength + (stickX > 0 ? 5 : -5)));
              localStorage.setItem('mrh-mask-strength', String(maskStrength));
              applyDarknessLevels();
              updateSettingsPanel();
            } else if (settingsCursor === 3) {
              flashFalloffFt = Math.max(1, Math.min(39, flashFalloffFt + (stickX > 0 ? 1 : -1)));
              localStorage.setItem('mrh-flash-dist', String(flashFalloffFt));
              updateSettingsPanel();
            } else if (settingsCursor === 4) {
              flashFade = Math.max(0, Math.min(100, flashFade + (stickX > 0 ? 5 : -5)));
              localStorage.setItem('mrh-flash-fade', String(flashFade));
              updateSettingsPanel();
            } else if (settingsCursor === 7) {
              beamGlowLevel = Math.max(0, Math.min(100, beamGlowLevel + (stickX > 0 ? 5 : -5)));
              localStorage.setItem('mrh-beam-glow', String(beamGlowLevel));
              updateBeamGlow();
              updateSettingsPanel();
            } else if (settingsCursor === 8) {
              flashOver = Math.max(0, Math.min(100, flashOver + (stickX > 0 ? 5 : -5)));
              localStorage.setItem('mrh-flash-over2', String(flashOver));
              if (flashlightOver) {
                flashlightOver.visible = flashlightMode && flashOver > 0;
              }
              updateSettingsPanel();
            } else if (settingsCursor === 9) {
              lightBlur = Math.max(0, Math.min(20, lightBlur + (stickX > 0 ? 1 : -1)));
              localStorage.setItem('mrh-light-blur', String(lightBlur));
              updateSettingsPanel();
            }
            settingsStickWasZero = false;
          } else if (!stickMoved) {
            settingsStickWasZero = true;
          }

        }
      }

      if (!gp || gp.axes.length < 2) continue;  // tracked hands have no stick
      // xr-standard mapping: thumbstick is axes[2], axes[3]
      const x = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0];
      const y = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1];
      if (src.handedness === 'left') { input.moveX = x; input.moveY = y; }
      else if (src.handedness === 'right' && !turnSuppressed) { input.turnX = x; }
    }
  } else {
    input.moveX = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    input.moveY = (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0);
  }
  return input;
}

// ───────────────────────────── locomotion ─────────────────────────────
const headPos = new THREE.Vector3();
const headFwd = new THREE.Vector3();   // flattened (XZ) view direction
const vel = new THREE.Vector3();
const _target = new THREE.Vector3();
const _right = new THREE.Vector3();
const _v = new THREE.Vector3();
let snapArmed = true;

function updateHead() {
  camera.getWorldPosition(headPos);
  camera.getWorldDirection(headFwd);
  headFwd.y = 0;
  if (headFwd.lengthSq() < 1e-6) headFwd.set(0, 0, -1).applyQuaternion(dolly.quaternion);
  headFwd.normalize();
}

// Rotate the dolly around the *head*, not the dolly origin — otherwise if you've
// physically walked away from the play-space center, snapping swings you around in an arc.
function snapTurn(angle) {
  updateHead();
  _v.copy(dolly.position).sub(headPos).applyAxisAngle(UP, angle);
  dolly.position.copy(headPos).add(_v);
  dolly.rotateY(angle);
  vel.applyAxisAngle(UP, angle);
}

function updateLocomotion(dt, inp) {
  // Snap turn — fires once per flick, must recentre before the next.
  const tx = inp.turnX;
  if (snapArmed && Math.abs(tx) > CFG.snapPress) {
    snapTurn(-Math.sign(tx) * CFG.snapAngle);
    snapArmed = false;
  } else if (Math.abs(tx) < CFG.snapRelease) {
    snapArmed = true;
  }
  if (pendingSnap) { snapTurn(pendingSnap * CFG.snapAngle); pendingSnap = 0; }

  // Head-relative slide with radial deadzone + response curve.
  updateHead();
  let x = inp.moveX, y = inp.moveY;
  const mag = Math.hypot(x, y);
  if (mag < CFG.deadzone) { x = y = 0; }
  else {
    const m = Math.min(1, (mag - CFG.deadzone) / (1 - CFG.deadzone));
    const k = Math.pow(m, CFG.responseCurve) / mag;
    x *= k; y *= k;
  }
  _right.crossVectors(headFwd, UP);
  _target.copy(_right).multiplyScalar(x).addScaledVector(headFwd, -y).multiplyScalar(CFG.moveSpeed);

  const rate = _target.lengthSq() > 0 ? CFG.accel : CFG.decel;
  vel.lerp(_target, 1 - Math.exp(-rate * dt));
  if (vel.lengthSq() < 1e-6) vel.set(0, 0, 0);
  dolly.position.addScaledVector(vel, dt);
}

// ───────────────────────────── game state ─────────────────────────────
let mode = null;            // 'immersive-ar' | 'immersive-vr' | 'desktop'
let state = 'menu';         // menu | playing | scare | over
let elapsed = 0;
let stateTime = 0;
let needSpawn = false;
let lurchTime = 0;
let best = +(localStorage.getItem('home-invasion-best') || 0);
const scareAnchor = new THREE.Vector3();

// Room-space helpers. The monster object lives in world space (scene child) but all
// navigation happens in room space so it lines up with the real walls.
const _mL = new THREE.Vector3();
const _hL = new THREE.Vector3();
const _fL = new THREE.Vector3();
const _steer = {};
const _yawEuler = new THREE.Euler();
const _q = new THREE.Quaternion();
// room.group is parented to the dolly in XR (scan data is in reference space) and to
// the scene in the desktop preview (so mouse-look doesn't spin the simulated room).
const roomSpace = () => { room.group.updateWorldMatrix(true, false); return room.group; };
const toRoom = (world, out) => roomSpace().worldToLocal(out.copy(world));
const fromRoom = (local) => roomSpace().localToWorld(local);
const roomYaw = () => _yawEuler.setFromQuaternion(roomSpace().getWorldQuaternion(_q), 'YXZ').y;
let stuckTime = 0;

// Put the monster at room-space (x,z), standing on the detected floor.
function placeMonster(x, z, faceX, faceZ) {
  _mL.set(x, room.floorAt(x, z), z);
  monster.root.position.copy(fromRoom(_mL));
  monster.root.rotation.y = Math.atan2(faceX - x, faceZ - z) + roomYaw();
}

function spawnMonster(dist) {
  updateHead();
  toRoom(headPos, _hL);
  // Head forward in room space.
  _fL.copy(headFwd).applyAxisAngle(UP, -roomYaw());
  const nav = room.nav;
  if (nav.ok) {
    nav.setTarget(_hL.x, _hL.z);
    const p = nav.pickSpawn(_hL.x, _hL.z, _fL.x, _fL.z, dist);
    if (p) {
      placeMonster(p.x, p.z, _hL.x, _hL.z);
      monster.root.visible = true;
      stuckTime = 0;
      return;
    }
  }
  // No room data (or nowhere reachable): behind you, slightly off-axis.
  _v.set(-_fL.x, 0, -_fL.z).applyAxisAngle(UP, rand(-0.7, 0.7));
  placeMonster(_hL.x + _v.x * dist, _hL.z + _v.z * dist, _hL.x, _hL.z);
  monster.root.visible = true;
  stuckTime = 0;
}

function startRound() {
  state = 'playing';
  stateTime = 0;
  elapsed = 0;
  lurchTime = 0;
  vel.set(0, 0, 0);
  monster.reach = 0;
  needSpawn = true;            // wait for a real HMD pose (and, in XR, the first room scan)
  bloodMat.opacity = 0;
}

function triggerGameOver() {
  state = 'scare';
  stateTime = 0;
  audio.jumpscare();
  updateHead();
  // Put its face right in yours.
  scareAnchor.copy(headPos).addScaledVector(headFwd, 0.42);
  monster.root.rotation.y = Math.atan2(-headFwd.x, -headFwd.z);
  monster.root.position.copy(scareAnchor);
  monster.root.updateMatrixWorld(true);
  monster.face.getWorldPosition(_v);
  monster.root.position.add(scareAnchor.clone().sub(_v));
  scareAnchor.copy(monster.root.position);
}

function updateMonster(dt) {
  const nav = room.nav;
  toRoom(monster.root.position, _mL);
  toRoom(headPos, _hL);
  const dx = _hL.x - _mL.x, dz = _hL.z - _mL.z;
  const dist = Math.hypot(dx, dz);

  // Caught — but not through a wall.
  if (dist < CFG.catchDistance && nav.lineFree(_mL.x, _mL.z, _hL.x, _hL.z, true)) { triggerGameOver(); return; }

  // Is the player looking roughly toward it? (We only relocate it when unseen.)
  _v.set(monster.root.position.x - headPos.x, 0, monster.root.position.z - headPos.z).normalize();
  const looking = _v.dot(headFwd) > 0.2;

  // Leash (open space only): if you've outrun it and aren't looking, it's suddenly behind you again.
  if (!nav.ok && dist > CFG.leashDistance && !looking) { spawnMonster(CFG.spawnDistance + 1); return; }
  // Stuck behind something with no route for a while → reappear somewhere that does have one.
  if (nav.ok && stuckTime > CFG.stuckRespawn && !looking) { spawnMonster(CFG.spawnDistance); return; }

  // Lurches: random bursts of speed, more likely as the round goes on.
  if (lurchTime > 0) lurchTime -= dt;
  else if (dist < 8 && Math.random() < CFG.lurchChance * dt * (1 + elapsed / 60)) lurchTime = rand(0.5, 1.1);

  const base = Math.min(CFG.startSpeed + elapsed * CFG.speedRampPerSec, CFG.maxSpeed);
  const speed = base * (lurchTime > 0 ? CFG.lurchMul : 1);

  // Where to go next: straight at you if there's a clear line, otherwise along the flow field.
  nav.setTarget(_hL.x, _hL.z);
  const wp = nav.steer(_mL.x, _mL.z, _hL.x, _hL.z, _steer);
  let sx = wp.x - _mL.x, sz = wp.z - _mL.z;
  const sl = Math.hypot(sx, sz);
  let moved = 0, faceX = dx, faceZ = dz;
  if (sl > 1e-4) {
    sx /= sl; sz /= sl;
    const step = Math.min(speed * dt, wp.mode === 'direct' ? dist : sl + speed * dt);
    // Final lunge: within arm's reach with a clear line, ignore the body-radius margin.
    const lunge = dist < 1.0 && nav.lineFree(_mL.x, _mL.z, _hL.x, _hL.z, true);
    const [nx, nz] = wp.mode === 'escape' ? [_mL.x + sx * step, _mL.z + sz * step]
      : nav.move(_mL.x, _mL.z, sx * step, sz * step, lunge);
    moved = Math.hypot(nx - _mL.x, nz - _mL.z);
    faceX = sx; faceZ = sz;
    _mL.x = nx; _mL.z = nz;
  }

  // Progress check: if the walking distance to you isn't shrinking, it's stuck.
  const expected = speed * dt;
  stuckTime = (wp.mode === 'blocked' || moved < expected * 0.25) ? stuckTime + dt : Math.max(0, stuckTime - dt * 2);

  // Stand on the detected floor and turn to face the direction of travel (in world space).
  _mL.y = room.floorAt(_mL.x, _mL.z);
  monster.root.position.copy(fromRoom(_mL));
  const yaw = Math.atan2(faceX, faceZ) + roomYaw();
  monster.root.rotation.y = lerpAngle(monster.root.rotation.y, yaw, 1 - Math.exp(-6 * dt));
  monster.animate(dt, Math.max(moved / Math.max(dt, 1e-4), 0.15), dist);
  if (room.debug) room.drawPath(nav.path);

  const tension = clamp(1 - (dist - 0.8) / 7, 0, 1);
  audio.setTension(tension, dt);
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.001 * (3 + tension * 8));
  bloodMat.opacity = tension > 0.55 ? (tension - 0.55) * 0.55 * (0.6 + 0.4 * pulse) : 0;
}

function updateScare(dt) {
  // Violent shake right in your face.
  monster.root.position.copy(scareAnchor).add(_v.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(0.025));
  monster.animate(dt, 0, 0, true);
  bloodMat.opacity = Math.min(0.75, bloodMat.opacity + dt * 1.2);

  if (stateTime > 1.4) {
    state = 'over';
    stateTime = 0;
    monster.root.visible = false;
    const t = Math.floor(elapsed);
    const isBest = elapsed > best;
    if (isBest) { best = elapsed; localStorage.setItem('home-invasion-best', String(best)); }
    hud.show('GAME OVER', `You survived ${t}s${isBest ? ' — new best' : ''}`,
      mode === 'desktop' ? 'Click to try again' : 'Pull the trigger to try again');
    updateBestLabel();
  }
}

// ───────────────────────────── main loop ─────────────────────────────
const clock = new THREE.Clock();

let xrTime = 0;
let roomCaptureAsked = false;

function loop(time, frame) {
  const dt = Math.min(clock.getDelta(), 0.05);
  stateTime += dt;

  // Room sensing: pull detected planes/meshes, rebuild the nav grid when they change.
  if (frame && renderer.xr.isPresenting && !window.__fakeXR) {
    xrTime += dt;
    room.updateXR(frame, renderer.xr.getReferenceSpace());
    // Quest: if the user never ran Space Setup there is nothing to detect — offer it once.
    const session = renderer.xr.getSession();
    if (!room.hasData && !roomCaptureAsked && xrTime > CFG.roomCaptureDelay && session?.initiateRoomCapture) {
      roomCaptureAsked = true;
      session.initiateRoomCapture().catch(() => {});
    }
  }
  if (room.source !== 'none') {
    camera.getWorldPosition(_v);
    room.update(dt, toRoom(_v, _hL));
  }

  // Pull this frame's HMD pose into `camera` now (three.js otherwise does it inside
  // render()), so locomotion and the monster use the current head position.
  if (renderer.xr.isPresenting) {
    dolly.updateMatrixWorld(true);
    renderer.xr.updateCamera(camera);
  }

  const inp = readInput();

  if (state === 'playing') {
    elapsed += dt;
    updateLocomotion(dt, inp);
    updateHead();

    updateFlashlightPosition();
    if (needSpawn && (room.source !== 'xr' || room.nav.ok || xrTime > 1.5)) {
      needSpawn = false;
      spawnMonster(CFG.spawnDistance);
      hud.show('IT KNOWS', 'you are here', room.summary(), { panel: false, duration: 3 });
    }
    updateMonster(dt);
  } else if (state === 'scare') {
    updateScare(dt);
  } else if (state === 'over') {
    bloodMat.opacity += (0.45 - bloodMat.opacity) * (1 - Math.exp(-2 * dt));
    audio.setTension(0, dt);
    if (pendingTrigger && stateTime > 1) startRound();
  }
  pendingTrigger = false;

  hud.update(dt);
  if (window.__dbgTick) window.__dbgTick(dt);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(loop);

// ───────────────────────────── session management ─────────────────────────────
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('start');
const modeInfo = document.getElementById('mode-info');
const bestLabel = document.getElementById('best');

function updateBestLabel() {
  bestLabel.textContent = best > 0 ? `Longest survival: ${Math.floor(best)}s` : '';
}
updateBestLabel();

async function detectMode() {
  if (!navigator.xr) return 'desktop';
  try { if (await navigator.xr.isSessionSupported('immersive-ar')) return 'immersive-ar'; } catch {}
  try { if (await navigator.xr.isSessionSupported('immersive-vr')) return 'immersive-vr'; } catch {}
  return 'desktop';
}

const MODE_TEXT = {
  'immersive-ar': 'Passthrough mixed reality — it will be in your room.',
  'immersive-vr': 'Passthrough not available — falling back to VR.',
  'desktop': 'No headset found — desktop preview.',
};

detectMode().then((m) => {
  mode = m;
  startBtn.disabled = false;
  startBtn.textContent = 'START SURVIVAL';
  modeInfo.textContent = MODE_TEXT[m];
  if (!window.isSecureContext) modeInfo.textContent += ' (WebXR needs HTTPS or localhost.)';
});

const lockPointer = () => renderer.domElement.requestPointerLock?.()?.catch?.(() => {});

startBtn.addEventListener('click', async () => {
  if (mode === 'desktop') lockPointer();   // must run synchronously inside the click
  await listener.context.resume();   // must be inside the user gesture
  audio.start();

  if (mode === 'desktop') {
    setPassthrough(false);
    room.reset();
    scene.add(room.group);
    if (!new URLSearchParams(location.search).has('noroom')) { room.loadSim(); room.rebuild(); }
    overlay.classList.add('hidden');
    startRound();
    return;
  }

  try {
    const features = ['local-floor', 'hand-tracking', 'plane-detection', 'mesh-detection'];
    let session;
    try {
      session = await navigator.xr.requestSession(mode, { optionalFeatures: features });
    } catch (e) {
      // Some browsers reject unknown feature strings instead of ignoring them.
      console.warn('Retrying without scene understanding:', e);
      session = await navigator.xr.requestSession(mode, { optionalFeatures: features.slice(0, 2) });
    }
    room.reset();
    dolly.add(room.group);
    xrTime = 0;
    await renderer.xr.setSession(session);
    // 'alpha-blend' = real passthrough. Some browsers grant AR but report opaque.
    setPassthrough(mode === 'immersive-ar' && session.environmentBlendMode !== 'opaque');
    session.addEventListener('select', () => { if (!settingsPanelOpen) pendingTrigger = true; }); // trigger or hand pinch
    session.addEventListener('end', onSessionEnded);
    overlay.classList.add('hidden');
    startRound();
  } catch (err) {
    console.error(err);
    modeInfo.textContent = `Could not start ${mode}: ${err.message}`;
  }
});

function onSessionEnded() {
  state = 'menu';
  room.reset();
  monster.root.visible = false;
  hud.hide();
  bloodMat.opacity = 0;
  dolly.position.set(0, 0, 0);
  dolly.rotation.set(0, 0, 0);
  camera.position.set(0, CFG.desktopEyeHeight, 0);
  camera.quaternion.identity();
  setPassthrough(false);
  overlay.classList.remove('hidden');
}

addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Console handle for debugging (e.g. __game.room.nav, __game.monster.root.position).
window.__game = { room, monster, dolly, camera };
// ───────────────────────────── flashlight mode ─────────────────────────────
function createFlashlight() {
  // Flashlight model group
  flashlightModel = new THREE.Group();
  flashlightModel.position.set(0.1, -0.1, -0.2);
  flashlightModel.visible = false;

  // ── Light receivers: mark stencil ONLY on the pixels the beam actually lights.
  // Every room occluder (real walls / scene mesh / furniture) and monster mesh gets a
  // stencil-only twin drawn with receiverMat, whose fragment shader keeps a pixel only
  // if it is in the cone, in range, faces the flashlight and is not in shadow (depth
  // map rendered from the flashlight each frame). The beam through air is invisible.
  const { vertexShader, fragmentShader } = receiverShaders(FLASH);
  const thruShaders = receiverShaders(FLASH, { thru: true });
  // One shared uniform-value set: per-frame updates on receiverMat.uniforms
  // propagate to every variant automatically (same value objects).
  const sharedU = {
    uLightPos: { value: new THREE.Vector3() },
    uLightDir: { value: new THREE.Vector3(0, 0, -1) },
    uLightVP: { value: new THREE.Matrix4() },
    uShadow: { value: null },
    uDist: { value: 20 * 0.3048 },
    uOverReach: { value: (flashOver / 100) * flashFalloffFt * 0.3048 },
    uFade: { value: 0.3 },
  };
  const visUniforms = (cls) => Object.assign({}, sharedU, { uClass: { value: cls } });
  receiverMat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: visUniforms(1),   // dynamic mesh class
    colorWrite: false,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    polygonOffset: true,                     // win the depth tie with the surface it shadows
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilFail: THREE.KeepStencilOp
  });
  // SHINE THRU FURNITURE variant: same stencil test but NO away-face test —
  // furniture writes stencil across its whole silhouette so its pixels lose the
  // darkness using the light of the surface BEHIND it (the beam reads as
  // passing through, not a black hole).
  receiverMatThru = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: thruShaders.fragmentShader,
    uniforms: visUniforms(1),                // shared values — one per-frame update serves all
    colorWrite: false,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilFail: THREE.KeepStencilOp
  });
  // Structure variant (walls / floor / ceiling / monster): class 0 — the blur
  // never softens these, they keep their hard light edges.
  receiverMatStruct = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: visUniforms(0),
    colorWrite: false,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilFail: THREE.KeepStencilOp
  });
  // Depth-only shadow casters; polygon offset = free hardware slope-scaled bias.
  casterMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
  });
  const res = FLASH.shadowRes;
  shadowRT = new THREE.WebGLRenderTarget(res, res, {
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  // Visibility render target for per-pixel flashlight visibility
  visRT = new THREE.WebGLRenderTarget(1024, 1024, {
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  visRT2 = new THREE.WebGLRenderTarget(1024, 1024, {
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  visEyeL = new THREE.PerspectiveCamera();
  visEyeR = new THREE.PerspectiveCamera();
  visEyeL.matrixWorldAutoUpdate = false;
  visEyeR.matrixWorldAutoUpdate = false;
  // Gaussian-blurred copies of the vis textures (LIGHT BLUR): two separable
  // passes at half res — smooth falloff, none of the mip-level blockiness.
  visBlurRT = new THREE.WebGLRenderTarget(512, 512, { depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  visBlurRT2 = new THREE.WebGLRenderTarget(512, 512, { depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  blurTmpRT = new THREE.WebGLRenderTarget(512, 512, { depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  blurCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  blurMat = new THREE.ShaderMaterial({
    uniforms: { tex: { value: null }, uOrig: { value: null }, uFinal: { value: 0 }, uDir: { value: new THREE.Vector2() } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `
      uniform sampler2D tex;
      uniform sampler2D uOrig;
      uniform float uFinal;
      uniform vec2 uDir;
      varying vec2 vUv;
      void main() {
        vec4 sum = texture2D(tex, vUv) * 0.227027;
        sum += (texture2D(tex, vUv + uDir * 1.3846) + texture2D(tex, vUv - uDir * 1.3846)) * 0.316216;
        sum += (texture2D(tex, vUv + uDir * 3.2308) + texture2D(tex, vUv - uDir * 3.2308)) * 0.070270;
        float cls = texture2D(tex, vUv).b;   // class channel: never blurred
        vec4 result = sum;
        if (uFinal > 0.5) {
          // One-sided blur: darkness intrudes on the bright, never the reverse —
          // the lit side loses its halo; the dark side keeps its hard edge.
          vec4 orig = texture2D(uOrig, vUv);
          result.a = min(orig.a, result.a);
          result.g = min(orig.g, result.g);
        }
        gl_FragColor = vec4(0.0, result.g, cls, result.a);
      }`,
    depthTest: false,
    depthWrite: false
  });
  blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMat);
  blurQuad.frustumCulled = false;
  blurScene = new THREE.Scene();
  blurScene.add(blurQuad);
  shadowRT = new THREE.WebGLRenderTarget(res, res, {
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthTexture: new THREE.DepthTexture(res, res),
  });
  receiverMat.uniforms.uShadow.value = shadowRT.depthTexture;
  lightCam = new THREE.PerspectiveCamera(shadowFov(FLASH), 1, FLASH.near, FLASH.range);
  casterScene = new THREE.Scene();
  casterScene.matrixWorldAutoUpdate = false;   // proxies carry copied world matrices

  spotGroup = new THREE.Group();
  spotGroup.visible = false;
  scene.add(spotGroup);
  scene.add(flashlightModel);

  // Shadow pass runs inside the main render, right after three.js has refreshed every
  // world matrix (so the monster/dolly are this frame's) and before the eye buffers are
  // bound/cleared — no mid-frame framebuffer switch on Quest's tiled GPU.
  const prevBeforeRender = scene.onBeforeRender;
  scene.onBeforeRender = function (r, s, c, rt) {
    prevBeforeRender.call(this, r, s, c, rt);
    if (flashlightMode) {
      renderFlashlightShadow(r);
      // Update cone darkness uniforms with visibility texture
      if (coneDarkness && coneDarkness.material.uniforms && visRT) {
        const uniforms = coneDarkness.material.uniforms;
        uniforms.uVisTex.value = visRT.texture;
        if (visRT2) uniforms.uVisTex2.value = visRT2.texture;
        uniforms.uVisBlurTex.value = lightBlur > 0 ? visBlurRT.texture : visRT.texture;
        if (visRT2) uniforms.uVisBlurTex2.value = lightBlur > 0 ? visBlurRT2.texture : visRT2.texture;
        uniforms.uDynOnly.value = blurDynOnly ? 1 : 0;
        // three r170 has no renderer.drawingBufferWidth/Height (undefined -> NaN
        // uniforms -> the cone-darkness shader sampled the visibility map at NaN
        // and re-covered the flashlight spot with full darkness on every platform).
        // The canvas backing store IS the buffer we render into: on desktop it is
        // the drawing buffer, and WebXRManager.setSize() resizes it to the full
        // side-by-side XR texture (both eyes) at session start.
        uniforms.uHalfW.value = r.xr.isPresenting ? r.domElement.width / 2 : r.domElement.width;
        uniforms.uBufH.value = r.domElement.height;
      }
      if (flashlightOver && flashlightOver.visible && visRT) {
        const uOver = flashlightOver.material.uniforms;
        uOver.uVisTex.value = visRT.texture;
        if (visRT2) uOver.uVisTex2.value = visRT2.texture;
        uOver.uVisBlurTex.value = lightBlur > 0 ? visBlurRT.texture : visRT.texture;
        if (visRT2) uOver.uVisBlurTex2.value = lightBlur > 0 ? visBlurRT2.texture : visRT2.texture;
        uOver.uDynOnly.value = blurDynOnly ? 1 : 0;
        uOver.uHalfW.value = r.xr.isPresenting ? r.domElement.width / 2 : r.domElement.width;
        uOver.uBufH.value = r.domElement.height;
        uOver.uMaskStrength.value = maskStrength;
      }
    }
  };

  // Darkness overlay with stencil test
  const darkGeom = new THREE.PlaneGeometry(20, 20);
  darknessOverlay = new THREE.Mesh(
    darkGeom,
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 1.0 - (roomBrightness / 100),
      depthTest: false,
      depthWrite: false,
      stencilWrite: true,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilRef: 1,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp
    })
  );
  darknessOverlay.position.set(0, 0, -5);
  darknessOverlay.renderOrder = 2000;       // renders after stencil writer
  darknessOverlay.visible = false;
  camera.add(darknessOverlay);

  // Darkness pass: covers the WHOLE screen with darkness, reduced per pixel by
  // the mip-blurred visibility from the vis pass (MASK REMOVAL scales it).
  // The vis field is Gaussian-blurred (LIGHT BLUR) before this pass samples
  // it — a smooth lit/unlit transition with no blocky steps.
  const coneDarknessShader = {
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uRoomBrightness;
      uniform float uMaskStrength;
      uniform sampler2D uVisTex;
      uniform sampler2D uVisTex2;
      uniform sampler2D uVisBlurTex;
      uniform sampler2D uVisBlurTex2;
      uniform float uDynOnly;
      uniform float uHalfW;
      uniform float uBufH;
      varying vec2 vUv;
      void main() {
        // Per-pixel flashlight visibility: raw + Gaussian-blurred (LIGHT BLUR).
        // Class channel (B: 1 = dynamic mesh, 0 = walls/floor/monster) picks
        // which one applies, so the blur can be scoped to the dynamic mesh.
        vec2 uv = vec2(mod(gl_FragCoord.x, uHalfW), gl_FragCoord.y) / vec2(uHalfW, uBufH);
        float isRight = step(uHalfW, gl_FragCoord.x);
        vec4 vis = mix(texture2D(uVisTex, uv), texture2D(uVisTex2, uv), isRight);
        vec4 blur = mix(texture2D(uVisBlurTex, uv), texture2D(uVisBlurTex2, uv), isRight);
        float classM = max(vis.b, 1.0 - uDynOnly);
        float visibility = mix(vis.a, blur.a, classM);
        
        // Base darkness level
        float baseDarkness = 1.0 - (uRoomBrightness / 100.0);
        
        // Apply mask strength and visibility
        float finalOpacity = baseDarkness * (1.0 - (uMaskStrength / 100.0) * visibility);
        
        gl_FragColor = vec4(0.0, 0.0, 0.0, finalOpacity);
      }
    `,
    uniforms: {
      uRoomBrightness: { value: roomBrightness },
      uMaskStrength: { value: maskStrength },
      uVisTex: { value: null },
      uVisTex2: { value: null },
      uVisBlurTex: { value: null },
      uVisBlurTex2: { value: null },
      uDynOnly: { value: blurDynOnly ? 1 : 0 },
      uHalfW: { value: 512 },
      uBufH: { value: 512 }
    }
  };
  
  coneDarkness = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.ShaderMaterial({
      vertexShader: coneDarknessShader.vertexShader,
      fragmentShader: coneDarknessShader.fragmentShader,
      uniforms: coneDarknessShader.uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false
    })
  );
  coneDarkness.position.set(0, 0, -5);
  coneDarkness.renderOrder = 2001;          // after darknessOverlay
  coneDarkness.visible = false;
  camera.add(coneDarkness);

  // Over-bright pass: pure white added inside the beam, ON TOP of everything.
  // Uses the beam's FULL shape (cone edge, fade, shadows — same dimensions as
  // the main light), scaled by a linear reach: white at the flashlight, zero at
  // FLASH OVER% of the falloff distance. The vis pass bakes that into the
  // GREEN channel every frame; this pass just adds it (Gaussian-blurred like
  // the darkness, so the white core gets a soft edge too).
  flashlightOver = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.ShaderMaterial({
      vertexShader: coneDarknessShader.vertexShader,
      fragmentShader: `
        uniform sampler2D uVisTex;
        uniform sampler2D uVisTex2;
        uniform sampler2D uVisBlurTex;
        uniform sampler2D uVisBlurTex2;
        uniform float uDynOnly;
        uniform float uHalfW;
        uniform float uBufH;
        uniform float uMaskStrength;
        varying vec2 vUv;
        void main() {
          vec2 uv = vec2(mod(gl_FragCoord.x, uHalfW), gl_FragCoord.y) / vec2(uHalfW, uBufH);
          float isRight = step(uHalfW, gl_FragCoord.x);
          vec4 vis = mix(texture2D(uVisTex, uv), texture2D(uVisTex2, uv), isRight);
          vec4 blur = mix(texture2D(uVisBlurTex, uv), texture2D(uVisBlurTex2, uv), isRight);
          float classM = max(vis.b, 1.0 - uDynOnly);
          float overAmt = mix(vis.g, blur.g, classM) * (uMaskStrength / 100.0);
          gl_FragColor = vec4(vec3(1.0), overAmt);
        }
      `,
      uniforms: {
        uVisTex: { value: null },
        uVisTex2: { value: null },
        uVisBlurTex: { value: null },
        uVisBlurTex2: { value: null },
        uDynOnly: { value: blurDynOnly ? 1 : 0 },
        uHalfW: { value: 512 },
        uBufH: { value: 512 },
        uMaskStrength: { value: maskStrength }
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  flashlightOver.position.set(0, 0, -5);
  flashlightOver.renderOrder = 2002;        // after coneDarkness
  flashlightOver.visible = false;
  camera.add(flashlightOver);
}

function updateBeamGlow() {
  if (!flashlightModel) return;
  
  const beamLen = Math.max(0.5, flashFalloffFt * 0.3048);   // beam reaches the falloff distance
  if (flashBeam && (!beamGlow || beamGlow.userData.len !== beamLen)) {
    if (beamGlow) {                     // falloff distance changed — rebuild the cone
      flashlightModel.remove(beamGlow);
      beamGlow.geometry.dispose();
      beamGlow = null;
    }
    // Create beam glow effect
    const length = beamLen;
    const radius = length * Math.tan((FLASH.coneAngle / 2) * Math.PI / 180);
    const beamGeom = new THREE.ConeGeometry(radius, length, 16);
    beamGeom.translate(0, -length / 2, 0);
    beamGeom.rotateX(Math.PI / 2);
    
    beamGlow = new THREE.Mesh(
      beamGeom,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.15,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,   // occlude the beam behind walls/furniture; overlays don't write depth
        side: THREE.DoubleSide
      })
    );
    beamGlow.userData.len = beamLen;
    beamGlow.visible = false;
    beamGlow.renderOrder = 2005;   // draw AFTER the darkness passes — else the darkness overlay paints over the beam
    // STOP AT OBJECTS: the room's depth-only occluders (walls/floor/furniture,
    // scene mesh on Quest) are written into the depth buffer again right before
    // the beam draws, so the beam's depth test truncates it at the first real
    // surface — the same limit the light itself stops at. Nested-render state is
    // saved/restored like the shadow/vis passes.
    beamGlow.onBeforeRender = function (r, sc, cam) {
      if (!casterScene) return;
      if (r.xr.isPresenting) return;   // Quest: never nested-render inside the XR frame. XR eye cameras carry pose only in matrixWorld; r.render()'s updateMatrixWorld collapses them to origin, so this pass wrote garbage depth and the beam stopped stopping. While presenting, the room's depth-only occluders already wrote the depth the beam tests against.
      const _xr = r.xr.enabled; r.xr.enabled = false;
      const _ac = r.autoClear; r.autoClear = false;
      r.render(casterScene, cam);
      r.autoClear = _ac;
      r.xr.enabled = _xr;
    };
    flashlightModel.add(beamGlow);
  }
  
  if (beamGlow) {
    beamGlow.visible = flashBeam && flashlightMode;
    beamGlow.material.opacity = (beamGlowLevel / 100) * 0.9;   // BEAM GLOW setting (must read over bright passthrough)
  }
}

function toggleFlashlightMode() {
  flashlightMode = !flashlightMode;

  if (flashlightMode) {
    if (!flashlightModel) createFlashlight();
    flashlightModel.visible = true;
    spotGroup.visible = true;
    darknessOverlay.visible = false;   // coneDarkness now covers the whole screen from the blurred vis
    coneDarkness.visible = true;
    if (flashlightOver) flashlightOver.visible = flashOver > 0;
    updateBeamGlow();   // beam state may have changed while mode was off
  } else {
    if (flashlightModel) flashlightModel.visible = false;
    if (spotGroup) spotGroup.visible = false;
    if (darknessOverlay) darknessOverlay.visible = true;   // static darkness back when the light is off
    if (coneDarkness) coneDarkness.visible = false;
    if (flashlightOver) flashlightOver.visible = false;
  }

}

function updateFlashlightPosition() {
  if (!flashlightModel || !flashlightMode) return;

  const session = renderer.xr.getSession();
  const grip = session ? grips.get('right') : null;
  const aim = session ? aims.get('right') : null;

  if (grip || aim) {
    // Anchored at the right grip (in the hand), aimed along the controller's
    // pointing ray. Poses are this frame's (three.js updates them before our callback).
    (grip || aim).getWorldPosition(flashlightModel.position);
    (aim || grip).getWorldQuaternion(flashlightModel.quaternion);
  } else {
    // No controller tracked (yet) — anchor to the view so the beam is never stuck in space.
    // camera.position is dolly-local; flashlightModel lives in scene space → use world pose.
    camera.getWorldPosition(flashlightModel.position);
    camera.getWorldDirection(_v);
    flashlightModel.position.addScaledVector(_v, 0.5);
    camera.getWorldQuaternion(flashlightModel.quaternion);
  }
  flashlightModel.updateMatrixWorld();
  // The light itself is cast on the GPU in renderFlashlightShadow (scene.onBeforeRender).
}

// ── Per-frame light pass. Cost: one 512² depth-only draw of the room/monster, plus the
// same geometry once more stencil-only in the eye pass (fragment shader is ~20 ALU ops
// and one texture tap). No CPU raycasts at all.
const _noRaycast = () => {};
const _lightFrustum = new THREE.Frustum();
function _worldVisible(o) {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}
// Room footprint + height from the classified planes (cached). Used to tell
// structure (floor/ceiling/walls — they span the room) apart from furniture
// (compact objects like a couch or table).
let _roomDimsCache = null;
function _roomDims() {
  if (_roomDimsCache) return _roomDimsCache;
  let maxDim = 6, height = 2.5;
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  for (const rec of room.model.planes.values()) {
    if (rec.kind === 'floor' && rec.polygon && rec.matrix) {
      let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
      m.fromArray(rec.matrix);
      for (const pt of rec.polygon) {
        v.set(pt.x, pt.y, pt.z).applyMatrix4(m);
        minx = Math.min(minx, v.x); maxx = Math.max(maxx, v.x);
        minz = Math.min(minz, v.z); maxz = Math.max(maxz, v.z);
      }
      maxDim = Math.max(maxDim, maxx - minx, maxz - minz, 1);
    }
    if (rec.kind === 'ceiling' && typeof rec.y === 'number') height = Math.max(height, rec.y - (room.floorY || 0));
  }
  _roomDimsCache = { maxDim, height };
  return _roomDimsCache;
}
function _syncProxy(src) {
  if (!src.isMesh || !src.geometry) return;
  // SHINE THRU FURNITURE ON: furniture casts no shadows and gets no light of
  // its own — its pixels inherit the light of the surface behind them, so the
  // beam reads as passing through and landing on what's behind. OFF: furniture
  // is a normal object (lit, casts shadows).
  if (src.userData.__furn === undefined) {
    if (src.userData.sceneMesh === true) {
      const bb = new THREE.Box3().setFromObject(src);
      const rd = _roomDims();
      const xzMax = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
      const yExt = bb.max.y - bb.min.y;
      src.userData.__furn = !(xzMax >= 0.6 * rd.maxDim || yExt >= 0.8 * rd.height);
    } else {
      src.userData.__furn = src.userData.isFurniture === true;
    }
  }
  let p = lightProxies.get(src);
  if (!p) {
    const recv = new THREE.Mesh(src.geometry, receiverMat);
    const cast = new THREE.Mesh(src.geometry, casterMat);
    for (const m of [recv, cast]) {
      m.matrixAutoUpdate = false;
      m.matrixWorldAutoUpdate = false;
      m.raycast = _noRaycast;
    }
    recv.renderOrder = 1990;                 // before the darkness overlay (2000)
    spotGroup.add(recv);
    casterScene.add(cast);
    p = { recv, cast, stamp: 0 };
    lightProxies.set(src, p);
  }
  if (p.recv.geometry !== src.geometry) p.recv.geometry = p.cast.geometry = src.geometry;
  p.stamp = proxyStamp;
  p.recv.matrixWorld.copy(src.matrixWorld);
  p.cast.matrixWorld.copy(src.matrixWorld);
  // SHINE THRU FURNITURE: furniture still writes its stencil (its pixels lose
  // the darkness using the light of the surface behind them) but never CASTS
  // shadows and is hidden in the visibility pass.
  const recvOnly = flashThruFurniture && src.userData.__furn === true;
  p.recv.material = recvOnly ? receiverMatThru : (src.userData.__furn === true ? receiverMat : receiverMatStruct);
  p.cast.visible = _worldVisible(src) && !recvOnly;   // casters: three culls them to the light frustum
  // Receivers outside the beam can never light up — skip their draw call entirely.
  p.recv.visible = _worldVisible(src) && _lightFrustum.intersectsObject(p.recv);
}

// The room's depth occluders cover walls + furniture but not the floor (plane fallback:
// the floor needs no occlusion). The beam must still land on it, so floor planes get
// light-only stand-ins here — read from the room model, the room pipeline is untouched.
// With a scene mesh (Quest 3) the floor is already part of the mesh occluders.
const floorSources = new Map();   // plane record → { mesh, polygon }
function _syncFloorProxies() {
  const og = room.occluderGroup;
  const planes = room.model && room.model.planes;
  const useFloor = og && planes && room.meshOcc && room.meshOcc.size === 0;
  if (useFloor) {
    const visible = _worldVisible(og);
    for (const rec of planes.values()) {
      if (rec.kind !== 'floor' || !rec.polygon || !rec.matrix) continue;
      let f = floorSources.get(rec);
      if (!f || f.polygon !== rec.polygon) {
        if (f) f.mesh.geometry.dispose();
        const shape = new THREE.Shape(rec.polygon.map((q) => new THREE.Vector2(q.x, -q.z)));
        const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2));
        f = { mesh, polygon: rec.polygon, stamp: 0 };
        floorSources.set(rec, f);
      }
      f.stamp = proxyStamp;
      f.mesh.matrix.fromArray(rec.matrix);
      f.mesh.matrixWorld.multiplyMatrices(og.matrixWorld, f.mesh.matrix);
      f.mesh.visible = visible;
      _syncProxy(f.mesh);
    }
  }
  for (const [rec, f] of floorSources) {
    if (f.stamp === proxyStamp) continue;
    f.mesh.geometry.dispose();
    floorSources.delete(rec);              // its proxy is dropped by the stale sweep
  }
}

function renderFlashlightShadow(r) {
  if (!shadowRT || !flashlightModel) return;

  // 1. Flashlight = shadow camera.
  lightCam.position.copy(flashlightModel.position);
  lightCam.quaternion.copy(flashlightModel.quaternion);
  lightCam.updateMatrixWorld();
  const u = receiverMat.uniforms;
  u.uLightPos.value.copy(lightCam.position);
  u.uLightDir.value.set(0, 0, -1).applyQuaternion(lightCam.quaternion);
  u.uLightVP.value.multiplyMatrices(lightCam.projectionMatrix, lightCam.matrixWorldInverse);
  u.uDist.value = flashFalloffFt * 0.3048;
  u.uOverReach.value = (flashOver / 100) * flashFalloffFt * 0.3048;
  u.uFade.value = flashFade / 100;
  _lightFrustum.setFromProjectionMatrix(u.uLightVP.value);

  // 2. Mirror the light targets (room occluders + floor + monster) — matrices are fresh here.
  proxyStamp++;
  // Sync receivers + casters from the full occluder set (furniture is skipped
  // inside _syncProxy — it takes no part in the flashlight).
  if (room.occluderGroup) room.occluderGroup.traverse(_syncProxy);
  _syncFloorProxies();
  if (monster.root) monster.root.traverse(_syncProxy);
  for (const [src, p] of lightProxies) {
    if (p.stamp === proxyStamp) continue;
    spotGroup.remove(p.recv);
    casterScene.remove(p.cast);
    lightProxies.delete(src);
  }

  // 3. Depth pass (once per frame, not per eye; XR camera override off for it).
  const xrEnabled = r.xr.enabled;
  const autoClear = r.autoClear;
  const prevTarget = r.getRenderTarget();
  r.xr.enabled = false;
  r.autoClear = false;
  r.setRenderTarget(shadowRT);
  r.clear(false, true, false);
  r.render(casterScene, lightCam);
  r.setRenderTarget(prevTarget);
  r.autoClear = autoClear;
  r.xr.enabled = xrEnabled;

  // 4. Visibility pass: render spot receivers PER EYE with colorWrite enabled.
  // XR MUST be off for these nested renders: while presenting, r.render() swaps
  // the camera for the XR ArrayCamera and draws per-eye with main-buffer viewports,
  // which corrupts the render target AND the renderer's viewport state (breaks the
  // darkness, menus and monster rendering for both eyes on Quest). The depth pass
  // disables XR for the same reason.
  if (visRT && visFrameStamp !== performance.now()) {
    visFrameStamp = performance.now();
    const xrActive = r.xr.enabled && r.xr.isPresenting && r.xr.getCamera() && r.xr.getCamera().cameras.length > 1;
    // Render through DEDICATED cameras with matrixWorldAutoUpdate off: three.js
    // recomputes matrixWorld from position/quaternion for parentless cameras, but
    // the XR eye cameras carry their pose in matrixWorld only — recomputing
    // collapses them to the origin and the visibility RT comes out empty on Quest.
    // Copying the XR matrices into cameras that never auto-update mirrors the
    // depth pass's lightCam pattern.
    const camL = xrActive ? visEyeL : camera;
    const camR = xrActive ? visEyeR : null;
    if (xrActive) {
      const xrSub = r.xr.getCamera().cameras;
      visEyeL.projectionMatrix.copy(xrSub[0].projectionMatrix);
      visEyeL.matrixWorld.copy(xrSub[0].matrixWorld);
      visEyeL.matrixWorldInverse.copy(xrSub[0].matrixWorldInverse);
      visEyeR.projectionMatrix.copy(xrSub[1].projectionMatrix);
      visEyeR.matrixWorld.copy(xrSub[1].matrixWorld);
      visEyeR.matrixWorldInverse.copy(xrSub[1].matrixWorldInverse);
    }
    r.xr.enabled = false;
    receiverMat.colorWrite = true;
    receiverMatStruct.colorWrite = true;
    receiverMatThru.colorWrite = true;
    // SHINE THRU FURNITURE: hide furniture receivers in the visibility pass —
    // the surface behind them fills their pixels, so they inherit its light.
    const _thruHidden = [];
    if (flashThruFurniture) {
      for (const [src, p] of lightProxies) {
        if (p.recv.visible && src.userData.__furn === true) { p.recv.visible = false; _thruHidden.push(p.recv); }
      }
    }
    r.setRenderTarget(visRT);
    r.clear(true, true, false);
    r.render(spotGroup, camL);
    if (camR && visRT2) {
      r.setRenderTarget(visRT2);
      r.clear(true, true, false);
      r.render(spotGroup, camR);
    }
    for (const m of _thruHidden) m.visible = true;
    // Gaussian blur of the vis field (LIGHT BLUR): two separable passes per eye.
    if (lightBlur > 0) {
      const stepUv = lightBlur * 0.64 / 512;
      blurMat.uniforms.uFinal.value = 0;
      blurMat.uniforms.uDir.value.set(stepUv, 0);
      blurMat.uniforms.tex.value = visRT.texture;
      r.setRenderTarget(blurTmpRT);
      r.render(blurScene, blurCam);
      blurMat.uniforms.uFinal.value = 1;
      blurMat.uniforms.uOrig.value = visRT.texture;
      blurMat.uniforms.uDir.value.set(0, stepUv);
      blurMat.uniforms.tex.value = blurTmpRT.texture;
      r.setRenderTarget(visBlurRT);
      r.render(blurScene, blurCam);
      if (camR && visRT2) {
        blurMat.uniforms.uFinal.value = 0;
        blurMat.uniforms.uDir.value.set(stepUv, 0);
        blurMat.uniforms.tex.value = visRT2.texture;
        r.setRenderTarget(blurTmpRT);
        r.render(blurScene, blurCam);
        blurMat.uniforms.uFinal.value = 1;
        blurMat.uniforms.uOrig.value = visRT2.texture;
        blurMat.uniforms.uDir.value.set(0, stepUv);
        blurMat.uniforms.tex.value = blurTmpRT.texture;
        r.setRenderTarget(visBlurRT2);
        r.render(blurScene, blurCam);
      }
    }
    r.setRenderTarget(prevTarget);
    r.xr.enabled = xrEnabled;
    receiverMat.colorWrite = false;
    receiverMatStruct.colorWrite = false;
    receiverMatThru.colorWrite = false;
  }
}

// Darkness opacity is driven by two settings: ROOM BRIGHTNESS (overall darkness)
// and MASK REMOVAL (how much of the darkness the light spot erases).
function applyDarknessLevels() {
  const base = 1.0 - (roomBrightness / 100);
  if (darknessOverlay) darknessOverlay.material.opacity = base;
  if (coneDarkness && coneDarkness.material.uniforms) {
    coneDarkness.material.uniforms.uRoomBrightness.value = roomBrightness;
    coneDarkness.material.uniforms.uMaskStrength.value = maskStrength;
  }
}

// ───────────────────────── settings panel ─────────────────────────
// Camera-attached canvas quad — visible inside the headset (DOM overlays are not
// rendered in immersive XR, which is why the old panel "didn't work" on device).
function createSettingsPanel() {
  if (settingsPanel) return;

  settingsCanvas = document.createElement('canvas');
  settingsCanvas.width = 512;
  settingsCanvas.height = 700;
  settingsCtx = settingsCanvas.getContext('2d');
  settingsTex = new THREE.CanvasTexture(settingsCanvas);

  const mat = new THREE.MeshBasicMaterial({
    map: settingsTex,
    transparent: true,
    depthTest: false,
    depthWrite: false
  });
  settingsPanel = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.956), mat);
  settingsPanel.renderOrder = 3000;
  settingsPanel.position.set(0, -0.28, -1.1);   // slightly below view center, ~1m ahead
  settingsPanel.visible = false;
  camera.add(settingsPanel);

  updateSettingsPanel();
}

function updateSettingsPanel() {
  if (!settingsCtx) return;
  const ctx = settingsCtx;
  const W = 512, H = 700;

  ctx.clearRect(0, 0, W, H);
  // Card background
  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(8, 8, W - 16, H - 16, 14);
  ctx.fill();
  ctx.stroke();

  const rows = [
    { text: 'FLASHLIGHT MODE: ' + (flashlightMode ? 'ON' : 'OFF'), y: 60 },
    { text: 'ROOM BRIGHTNESS: ' + roomBrightness + '%', y: 118 },
    { text: 'MASK REMOVAL: ' + maskStrength + '%', y: 176 },
    { text: 'FLASH FALLOFF: ' + flashFalloffFt + ' FT', y: 234 },
    { text: 'FLASH FADE: ' + flashFade + '%', y: 292 },
    { text: 'BEAM: ' + (flashBeam ? 'ON' : 'OFF'), y: 350 },
    { text: 'SHINE THRU FURNITURE: ' + (flashThruFurniture ? 'ON' : 'OFF'), y: 408 },
    { text: 'BEAM GLOW: ' + beamGlowLevel + '%', y: 466 },
    { text: 'FLASH OVER: ' + flashOver + '%', y: 524 },
    { text: 'LIGHT BLUR: ' + lightBlur, y: 582 },
    { text: 'BLUR DYNAMIC ONLY: ' + (blurDynOnly ? 'ON' : 'OFF'), y: 640 }
  ];
  ctx.textBaseline = 'middle';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (settingsCursor === i) {
      ctx.fillStyle = 'rgba(255, 255, 0, 0.25)';
      ctx.strokeStyle = '#ff6';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(24, r.y - 26, W - 48, 52, 10);
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = settingsCursor === i ? '#fff' : 'rgba(255, 255, 255, 0.85)';
    ctx.font = '600 30px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(r.text, W / 2, r.y);
  }

  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.font = '15px monospace';
  ctx.fillText('stick: navigate · stick ←/→: adjust · trigger: select', W / 2, 566);
  ctx.fillText('Y: close', W / 2, 590);

  settingsTex.needsUpdate = true;
}

function toggleSettingsPanel() {
  // Flags flip first so a rendering hiccup can never leave the game stuck.
  settingsPanelOpen = !settingsPanelOpen;
  turnSuppressed = settingsPanelOpen;

  try {
    if (!settingsPanel) createSettingsPanel();
    settingsPanel.visible = settingsPanelOpen;

    if (settingsPanelOpen) {
      settingsCursor = 0;
      updateSettingsPanel();
    }
  } catch (err) {
    console.warn('settings panel error:', err);
  }
}

// Debug handle for console-driven verification (renderer + visibility RTs).
window.__hi_dbg = { r: renderer, vis: () => [visRT, visRT2], eyeCams: () => [visEyeL, visEyeR] };

// ── ?fakexr=1: desktop XR simulation — exercises the per-eye vis branch locally ──
const __dbgParams = new URLSearchParams(location.search);
if (__dbgParams.has('fakexr')) {
  const fakeSubL = new THREE.PerspectiveCamera();
  const fakeSubR = new THREE.PerspectiveCamera();
  fakeSubL.viewport = new THREE.Vector4();
  fakeSubR.viewport = new THREE.Vector4();
  const fakeXR = new THREE.ArrayCamera([fakeSubL, fakeSubR]);
  const _fRight = new THREE.Vector3();
  function __syncFakeXR() {
    camera.updateMatrixWorld(true);
    const W = renderer.domElement.width, H = renderer.domElement.height;
    fakeSubL.viewport.set(0, 0, W / 2, H);
    fakeSubR.viewport.set(W / 2, 0, W / 2, H);
    fakeSubL.projectionMatrix.copy(camera.projectionMatrix);
    fakeSubR.projectionMatrix.copy(camera.projectionMatrix);
    fakeXR.projectionMatrix.copy(camera.projectionMatrix);
    fakeXR.matrixWorld.copy(camera.matrixWorld);
    fakeXR.matrixWorldInverse.copy(camera.matrixWorldInverse);
    for (const pair of [[fakeSubL, -0.032], [fakeSubR, 0.032]]) {
      const sub = pair[0], dx = pair[1];
      sub.matrixWorld.copy(camera.matrixWorld);
      _fRight.setFromMatrixColumn(camera.matrixWorld, 0);
      sub.matrixWorld.elements[12] += _fRight.x * dx;
      sub.matrixWorld.elements[13] += _fRight.y * dx;
      sub.matrixWorld.elements[14] += _fRight.z * dx;
      sub.matrixWorldInverse.copy(sub.matrixWorld).invert();
    }
  }
  renderer.xr.isPresenting = true;
  renderer.xr.getCamera = function () { __syncFakeXR(); return fakeXR; };
  window.__fakeXR = true;
}

// ── ?dbg=1: flashlight diagnostics panel + visibility thumbnails ──
if (__dbgParams.has('dbg')) {
  const dCan = document.createElement('canvas');
  dCan.width = 512; dCan.height = 300;
  const dCtx = dCan.getContext('2d');
  const dTex = new THREE.CanvasTexture(dCan);
  const dPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.363),
    new THREE.MeshBasicMaterial({ map: dTex, transparent: true, depthTest: false, depthWrite: false })
  );
  dPanel.renderOrder = 3500;
  dPanel.position.set(0, 0.5, -1.05);
  camera.add(dPanel);
  const mkThumb = (tex, x) => {
    const q = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.24),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    q.renderOrder = 3501;
    q.position.set(x, 0.2, -0.9);
    camera.add(q);
    return q;
  };
  let tL = null, tR = null;
  const readBuf = new Uint8Array(1024 * 1024 * 4);
  const stats = { nzL: -1, maxL: -1, nzR: -1, maxR: -1 };
  let lastRead = 0, lastText = 0;
  const mPos = (m) => [m.elements[12], m.elements[13], m.elements[14]].map(v => v.toFixed(2)).join(',');
  function __dbgCount(rt, which) {
    renderer.readRenderTargetPixels(rt, 0, 0, 1024, 1024, readBuf);
    let nz = 0, mx = 0;
    for (let i = 3; i < readBuf.length; i += 4) {
      const a = readBuf[i];
      if (a > 8) { nz++; if (a > mx) mx = a; }
    }
    if (which === 0) { stats.nzL = nz; stats.maxL = mx; } else { stats.nzR = nz; stats.maxR = mx; }
  }
  window.__dbgTick = function () {
    const now = performance.now();
    if (!tL && visRT) {
      tL = mkThumb(visRT.texture, -0.42);
      if (visRT2) tR = mkThumb(visRT2.texture, 0.42);
    }
    if (now - lastRead > 1000 && visRT) {
      lastRead = now;
      __dbgCount(visRT, 0);
      if (visRT2) __dbgCount(visRT2, 1);
    }
    if (now - lastText > 250) {
      lastText = now;
      const u = coneDarkness && coneDarkness.material.uniforms;
      const subs = renderer.xr.getCamera ? renderer.xr.getCamera().cameras : [];
      const ok = stats.nzL > 5000;
      dCtx.clearRect(0, 0, 512, 300);
      dCtx.fillStyle = 'rgba(0,0,0,0.75)';
      dCtx.fillRect(0, 0, 512, 300);
      dCtx.fillStyle = ok ? '#00ff88' : '#ff4444';
      dCtx.font = 'bold 26px monospace';
      dCtx.fillText(ok ? 'VIS RT: OK' : 'VIS RT: EMPTY', 14, 30);
      dCtx.fillStyle = '#ffffff';
      dCtx.font = '15px monospace';
      const lines = [
        'presenting=' + renderer.xr.isPresenting + ' fake=' + !!window.__fakeXR + ' subs=' + subs.length,
        'buf=' + renderer.domElement.width + 'x' + renderer.domElement.height +
          ' uHalfW=' + (u ? u.uHalfW.value.toFixed(0) : '?') + ' uBufH=' + (u ? u.uBufH.value.toFixed(0) : '?'),
        'visL nz=' + stats.nzL + ' max=' + stats.maxL + '  visR nz=' + stats.nzR + ' max=' + stats.maxR,
        'eyeL=' + (visEyeL ? mPos(visEyeL.matrixWorld) : '?'),
        'eyeR=' + (visEyeR ? mPos(visEyeR.matrixWorld) : '?'),
        'light=' + (flashlightModel ? mPos(flashlightModel.matrixWorld) : '?'),
        'bright=' + roomBrightness + ' mask=' + maskStrength +
          ' falloff=' + flashFalloffFt + 'ft fade=' + flashFade
      ];
      for (let i = 0; i < lines.length; i++) dCtx.fillText(lines[i], 14, 58 + i * 22);
      dTex.needsUpdate = true;
    }
  };
  dPanel.visible = true;
}
