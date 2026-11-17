// All sound is synthesized with WebAudio: dreamy pads, chimes, mumble voices,
// footsteps, dragon roar, fire, thunder.

const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);
// ambient dread bed per zone: drone root (Hz), drone level, wind level, whisper/creak rate
const DREAD = [
  { f: 55.0, drone: 0.05, wind: 0.032, whisper: 1, creak: 1 },
  { f: 49.0, drone: 0.045, wind: 0.036, whisper: 0.8, creak: 1.3 },
  { f: 46.25, drone: 0.065, wind: 0.055, whisper: 1.3, creak: 0.8 },
  { f: 51.9, drone: 0.055, wind: 0.02, whisper: 1.2, creak: 1.5 },
  { f: 41.2, drone: 0.08, wind: 0.016, whisper: 1.5, creak: 0.7 },
];
// per-zone pad chords (MIDI) and chime scales
const CHORDS = [
  [48, 55, 59, 64, 66], // meadow: C maj7 #11
  [53, 57, 60, 64, 67], // village: F maj9
  [50, 53, 56, 60, 61], // gloom: eerie D
  [52, 55, 59, 62, 66], // warren: E min9
  [48, 51, 55, 58, 62], // throne: C min9
];
const SCALES = [
  [72, 74, 76, 78, 79, 83, 84, 86],
  [77, 79, 81, 84, 86, 88, 89],
  [74, 75, 77, 80, 81, 84, 86],
  [76, 79, 81, 83, 86, 88],
  [72, 75, 77, 79, 82, 84],
];

export const VOICES = {
  elder: { base: 150, vary: 0.25, wave: 'square', f1: 650, f2: 1100, rate: 2, gain: 0.07 },
  goblin: { base: 380, vary: 0.6, wave: 'sawtooth', f1: 1200, f2: 2600, rate: 1, gain: 0.05 },
  villager: { base: 250, vary: 0.4, wave: 'triangle', f1: 900, f2: 1700, rate: 2, gain: 0.09 },
  villager2: { base: 320, vary: 0.35, wave: 'square', f1: 1000, f2: 2200, rate: 2, gain: 0.05 },
  sun: { base: 62, vary: 0.15, wave: 'sawtooth', f1: 320, f2: 600, rate: 3, gain: 0.12 },
  redsun: { base: 110, vary: 0.7, wave: 'sawtooth', f1: 500, f2: 1400, rate: 2, gain: 0.07 },
  dragon: { base: 55, vary: 0.2, wave: 'sawtooth', f1: 260, f2: 500, rate: 3, gain: 0.16 },
  sign: { base: 900, vary: 0.05, wave: 'sine', f1: 2000, f2: 3000, rate: 3, gain: 0.02 },
  wizard: { base: 220, vary: 0.3, wave: 'triangle', f1: 800, f2: 1500, rate: 2, gain: 0.08 },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.zone = 0;
    this.chimeT = 2;
    this.drumT = 0;
    this.boss = false;
    this.fire = null;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    // iOS needs a sound started inside the gesture to unlock
    const unlock = ctx.createBuffer(1, 1, 22050);
    const us = ctx.createBufferSource();
    us.buffer = unlock;
    us.connect(ctx.destination);
    us.start(0);
    if (ctx.state !== 'running') ctx.resume();

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    // procedural reverb impulse
    const len = Math.floor(ctx.sampleRate * 3.2);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    this.verb = ctx.createConvolver();
    this.verb.buffer = ir;
    this.verbIn = ctx.createGain();
    this.verbIn.gain.value = 0.55;
    this.verbIn.connect(this.verb).connect(this.master);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);
    const sfxSend = ctx.createGain();
    sfxSend.gain.value = 0.25;
    this.sfx.connect(sfxSend).connect(this.verbIn);

    this.music = ctx.createGain();
    this.music.gain.value = 0;
    this.music.gain.setTargetAtTime(0.5, ctx.currentTime, 2);
    this.music.connect(this.master);
    const musicSend = ctx.createGain();
    musicSend.gain.value = 0.8;
    this.music.connect(musicSend).connect(this.verbIn);

    // noise buffer
    const nlen = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, nlen, ctx.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;

    // pad
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 800;
    this.padFilter.Q.value = 0.8;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 380;
    lfo.connect(lfoG).connect(this.padFilter.frequency);
    lfo.start();
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0.11;
    this.padFilter.connect(this.padGain).connect(this.music);
    this.padOsc = [];
    const chord = CHORDS[this.zone];
    for (let i = 0; i < chord.length; i++) {
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.28 : 0.18;
      g.connect(this.padFilter);
      const pair = [];
      for (const [type, det] of [['sawtooth', -8], ['triangle', 7]]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = NOTE(chord[i]);
        o.detune.value = det + (Math.random() - 0.5) * 6;
        o.connect(g);
        o.start();
        pair.push(o);
      }
      // slow tremolo per voice for shimmer
      const tl = ctx.createOscillator();
      tl.frequency.value = 0.1 + Math.random() * 0.2;
      const tg = ctx.createGain();
      tg.gain.value = 0.06;
      tl.connect(tg).connect(g.gain);
      tl.start();
      this.padOsc.push(pair);
    }
    this.bass = ctx.createOscillator();
    this.bass.type = 'sine';
    this.bass.frequency.value = NOTE(chord[0] - 12);
    const bg = ctx.createGain();
    bg.gain.value = 0.16;
    this.bass.connect(bg).connect(this.music);
    this.bass.start();
    this.initDread();
  }

  // Two looping sources for the whole game: a detuned low drone pair and one
  // noise loop that feeds both the wind and the whispers.
  initDread() {
    const ctx = this.ctx, t = ctx.currentTime, d = DREAD[this.zone];
    this.dread = ctx.createGain();
    this.dread.gain.value = 0;
    this.dread.gain.setTargetAtTime(1, t, 3);
    this.dread.connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.4;
    this.dread.connect(send).connect(this.verbIn);

    this.droneLP = ctx.createBiquadFilter();
    this.droneLP.type = 'lowpass';
    this.droneLP.frequency.value = 120;
    this.droneLP.Q.value = 3;
    this.droneG = ctx.createGain();
    this.droneG.gain.value = d.drone;
    this.droneLP.connect(this.droneG).connect(this.dread);
    this.drone = [];
    for (const [type, mul] of [['sawtooth', 1], ['sawtooth', 1.059]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = d.f * mul;
      o.connect(this.droneLP);
      o.start();
      this.drone.push({ o, mul });
    }
    const dl = ctx.createOscillator();
    dl.frequency.value = 0.045;
    const dlg = ctx.createGain();
    dlg.gain.value = 45;
    dl.connect(dlg).connect(this.droneLP.frequency);
    dl.start();

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.windBP = ctx.createBiquadFilter();
    this.windBP.type = 'bandpass';
    this.windBP.frequency.value = 380;
    this.windBP.Q.value = 0.7;
    this.windG = ctx.createGain();
    this.windG.gain.value = d.wind;
    src.connect(this.windBP).connect(this.windG).connect(this.dread);
    const wl = ctx.createOscillator();
    wl.frequency.value = 0.07;
    const wlg = ctx.createGain();
    wlg.gain.value = 0.6;
    wl.connect(wlg).connect(this.windG.gain);
    const wf = ctx.createOscillator();
    wf.frequency.value = 0.11;
    const wfg = ctx.createGain();
    wfg.gain.value = 200;
    wf.connect(wfg).connect(this.windBP.frequency);
    wl.start();
    wf.start();
    this.windLfo = wlg;
    this.windLfo.gain.value = d.wind * 0.6;

    this.whBP = ctx.createBiquadFilter();
    this.whBP.type = 'bandpass';
    this.whBP.frequency.value = 2600;
    this.whBP.Q.value = 7;
    this.whG = ctx.createGain();
    this.whG.gain.value = 0;
    this.whPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    src.connect(this.whBP).connect(this.whG);
    if (this.whPan) this.whG.connect(this.whPan).connect(this.dread);
    else this.whG.connect(this.dread);
    src.start();
    this.whisperT = 6 + Math.random() * 6;
    this.creakT = 9 + Math.random() * 8;
    this.breathT = 0;
  }

  dreadZone(z) {
    if (!this.dread) return;
    const t = this.ctx.currentTime, d = DREAD[z];
    for (const { o, mul } of this.drone) o.frequency.setTargetAtTime(d.f * mul, t, 2);
    this.droneG.gain.setTargetAtTime(d.drone, t, 2);
    this.windG.gain.setTargetAtTime(d.wind, t, 2);
    this.windLfo.gain.setTargetAtTime(d.wind * 0.6, t, 2);
  }

  // breathy syllables panned somewhere beside you
  whisper() {
    const ctx = this.ctx, t = ctx.currentTime;
    const n = 5 + Math.floor(Math.random() * 9);
    const g = this.whG.gain, f = this.whBP.frequency;
    g.cancelScheduledValues(t);
    f.cancelScheduledValues(t);
    g.setValueAtTime(0, t);
    if (this.whPan) this.whPan.pan.setValueAtTime(Math.random() < 0.5 ? -0.75 : 0.75, t);
    let tt = t + 0.05;
    for (let i = 0; i < n; i++) {
      const len = 0.08 + Math.random() * 0.16, v = 0.05 + Math.random() * 0.07;
      f.setValueAtTime(1600 + Math.random() * 2600, tt);
      g.linearRampToValueAtTime(v, tt + len * 0.3);
      g.linearRampToValueAtTime(0.004, tt + len);
      tt += len + Math.random() * 0.09;
    }
    g.linearRampToValueAtTime(0, tt + 0.1);
  }
  // wood creaking under weight: stick-slip pitch wobble
  creak() {
    const ctx = this.ctx, t = ctx.currentTime, len = 0.8 + Math.random() * 1.0;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const base = 70 + Math.random() * 60;
    const curve = new Float32Array(16);
    for (let i = 0; i < 16; i++) curve[i] = base * (1 + (Math.random() - 0.5) * 0.35 + i * 0.012);
    o.frequency.setValueCurveAtTime(curve, t, len);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 500 + Math.random() * 500;
    bp.Q.value = 9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.1);
    g.gain.setValueAtTime(0.09, t + len * 0.7);
    g.gain.linearRampToValueAtTime(0, t + len);
    const p = this.whPan ? ctx.createStereoPanner() : null;
    o.connect(bp).connect(g);
    if (p) { p.pan.value = Math.random() * 1.6 - 0.8; g.connect(p).connect(this.dread); } else g.connect(this.dread);
    o.start(t);
    o.stop(t + len + 0.05);
  }
  caw() {
    if (!this.ok) return;
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const d = i * 0.26 + Math.random() * 0.05;
      this.tone('sawtooth', 640 + Math.random() * 80, 380, 0.2, 0.05, d);
      this.noiseBurst(0.18, 'bandpass', 1500, 900, 0.09, 3, d);
    }
    this.noiseBurst(0.6, 'highpass', 2500, 1800, 0.05, 0.6);
  }
  distantRumble() {
    if (!this.ok) return;
    this.noiseBurst(4.5, 'lowpass', 160, 35, 0.4, 0.8);
  }
  distantRoar() {
    if (!this.ok) return;
    this.roar(2.6, 0.08, 260);
  }

  get ok() {
    return this.ctx && this.ctx.state === 'running';
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.1);
    return this.muted;
  }

  setZone(z) {
    if (z === this.zone) return;
    this.zone = z;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const chord = CHORDS[z];
    this.padOsc.forEach((pair, i) => pair.forEach((o) => o.frequency.setTargetAtTime(NOTE(chord[i]), t, 0.9)));
    this.bass.frequency.setTargetAtTime(NOTE(chord[0] - 12), t, 0.9);
    this.padFilter.frequency.setTargetAtTime(z === 2 ? 500 : z === 4 ? 600 : 850, t, 1.5);
    this.dreadZone(z);
  }

  setBoss(on) {
    this.boss = on;
  }

  update(dt) {
    if (!this.ok) return;
    this.chimeT -= dt;
    if (this.chimeT <= 0) {
      this.chimeT = 1.4 + Math.random() * 3.2;
      const sc = SCALES[this.zone];
      const n = sc[Math.floor(Math.random() * sc.length)];
      this.bell(NOTE(n), 0.05, 2.5, this.music);
      if (Math.random() < 0.35) this.bell(NOTE(sc[Math.floor(Math.random() * sc.length)]), 0.035, 2.5, this.music, 0.18);
    }
    if (this.dread) {
      const d = DREAD[this.zone];
      this.whisperT -= dt * d.whisper;
      if (this.whisperT <= 0) {
        this.whisperT = 9 + Math.random() * 14;
        this.whisper();
      }
      this.creakT -= dt * d.creak;
      if (this.creakT <= 0) {
        this.creakT = 10 + Math.random() * 16;
        this.creak();
      }
      // the dragon's slow breathing swells the drone in the throne hall
      if (this.zone === 4) {
        this.breathT -= dt;
        if (this.breathT <= 0) {
          this.breathT = 4.2;
          const t = this.ctx.currentTime;
          this.droneG.gain.setTargetAtTime(d.drone * 1.9, t, 0.7);
          this.droneG.gain.setTargetAtTime(d.drone, t + 1.8, 0.9);
        }
      }
    }
    if (this.boss) {
      this.drumT -= dt;
      if (this.drumT <= 0) {
        this.drumT = 0.55;
        this.kick();
      }
    }
  }

  bell(f, vol, dur, dest = this.sfx, delay = 0) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(dest);
    for (const [m, a] of [[1, 1], [2.76, 0.35], [5.4, 0.12]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * m;
      const og = ctx.createGain();
      og.gain.value = a;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  noiseBurst(dur, type, f0, f1, vol, q = 1, delay = 0) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + Math.min(0.03, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.sfx);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.05);
  }

  tone(type, f0, f1, dur, vol, delay = 0) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // --- SFX -----------------------------------------------------------
  coin() {
    if (!this.ok) return;
    this.bell(NOTE(88), 0.08, 0.8);
    this.bell(NOTE(95), 0.06, 1.0, this.sfx, 0.07);
  }
  pickup() {
    if (!this.ok) return;
    [84, 88, 91, 96].forEach((n, i) => this.bell(NOTE(n), 0.08, 1.4, this.sfx, i * 0.08));
  }
  shard() {
    if (!this.ok) return;
    [72, 79, 84, 88, 91, 96, 100].forEach((n, i) => this.bell(NOTE(n), 0.09, 2.2, this.sfx, i * 0.09));
    this.noiseBurst(1.6, 'highpass', 4000, 9000, 0.05, 0.5);
  }
  lantern() {
    if (!this.ok) return;
    this.noiseBurst(0.4, 'bandpass', 600, 2400, 0.25, 2);
    [79, 84, 88].forEach((n, i) => this.bell(NOTE(n), 0.07, 1.2, this.sfx, 0.1 + i * 0.07));
  }
  hurt() {
    if (!this.ok) return;
    this.tone('square', 520, 140, 0.35, 0.12);
    this.noiseBurst(0.25, 'lowpass', 2000, 300, 0.25);
  }
  jump() {
    if (!this.ok) return;
    this.tone('sine', 300, 620, 0.18, 0.12);
  }
  land() {
    if (!this.ok) return;
    this.noiseBurst(0.12, 'lowpass', 500, 120, 0.25);
  }
  step() {
    if (!this.ok) return;
    this.noiseBurst(0.08, 'lowpass', 380 + Math.random() * 120, 100, 0.12);
  }
  swing() {
    if (!this.ok) return;
    this.noiseBurst(0.22, 'bandpass', 500, 2600, 0.25, 3);
  }
  hit() {
    if (!this.ok) return;
    this.tone('triangle', 200, 60, 0.3, 0.3);
    this.noiseBurst(0.3, 'bandpass', 1800, 400, 0.4, 1.5);
    [76, 83].forEach((n, i) => this.bell(NOTE(n), 0.08, 0.9, this.sfx, i * 0.05));
  }
  splash() {
    if (!this.ok) return;
    this.noiseBurst(0.8, 'bandpass', 1500, 300, 0.4, 0.8);
    this.tone('sine', 900, 200, 0.4, 0.1);
  }
  fall() {
    if (!this.ok) return;
    this.tone('sine', 700, 80, 1.0, 0.12);
  }
  goo() {
    if (!this.ok) return;
    this.tone('sine', 180, 520, 0.2, 0.15);
    this.tone('sine', 240, 90, 0.3, 0.12, 0.1);
  }
  thunder() {
    if (!this.ok) return;
    this.noiseBurst(0.25, 'highpass', 3000, 1500, 0.25);
    this.noiseBurst(3.2, 'lowpass', 400, 40, 0.75, 0.7, 0.08);
  }
  gate() {
    if (!this.ok) return;
    this.noiseBurst(3.0, 'lowpass', 200, 60, 0.6, 1);
    this.tone('sawtooth', 70, 50, 3, 0.08);
    [60, 67, 72, 76, 79].forEach((n, i) => this.bell(NOTE(n), 0.08, 3, this.sfx, 0.5 + i * 0.25));
  }
  roar(len = 1.6, vol = 0.3, lpMax = 1400) {
    if (!this.ok) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 128) - 1;
      curve[i] = Math.tanh(x * 4);
    }
    shaper.curve = curve;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.15);
    g.gain.setValueAtTime(vol, t + len * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(400, t);
    f.frequency.linearRampToValueAtTime(lpMax, t + len * 0.3);
    f.frequency.exponentialRampToValueAtTime(200, t + len);
    for (const [fr, det] of [[78, 0], [81, 15], [52, -10]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(fr, t);
      o.frequency.linearRampToValueAtTime(fr * 1.3, t + len * 0.3);
      o.frequency.exponentialRampToValueAtTime(fr * 0.6, t + len);
      o.detune.value = det;
      const trem = ctx.createOscillator();
      trem.frequency.value = 23;
      const tg = ctx.createGain();
      tg.gain.value = 18;
      trem.connect(tg).connect(o.frequency);
      trem.start(t);
      trem.stop(t + len);
      o.connect(shaper);
      o.start(t);
      o.stop(t + len + 0.05);
    }
    shaper.connect(f).connect(g).connect(this.sfx);
    this.noiseBurst(len, 'bandpass', 700 * Math.min(1, lpMax / 1400), 220, 0.45 * vol / 0.3, 1.2);
  }
  fireStart() {
    if (!this.ok || this.fire) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.2);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 9;
    const lg = ctx.createGain();
    lg.gain.value = 400;
    lfo.connect(lg).connect(f.frequency);
    lfo.start(t);
    s.connect(f).connect(g).connect(this.sfx);
    s.start(t);
    this.fire = { s, g, lfo };
  }
  fireStop() {
    if (!this.fire) return;
    const t = this.ctx.currentTime;
    this.fire.g.gain.setTargetAtTime(0, t, 0.1);
    this.fire.s.stop(t + 0.6);
    this.fire.lfo.stop(t + 0.6);
    this.fire = null;
  }
  fireball() {
    if (!this.ok) return;
    this.noiseBurst(0.6, 'lowpass', 1500, 200, 0.35);
  }
  boom() {
    if (!this.ok) return;
    this.noiseBurst(0.9, 'lowpass', 900, 50, 0.6);
    this.tone('sine', 120, 40, 0.5, 0.3);
  }
  kick() {
    this.tone('sine', 110, 38, 0.3, 0.28);
  }
  win() {
    if (!this.ok) return;
    [60, 64, 67, 72, 76, 79, 84, 88].forEach((n, i) => this.bell(NOTE(n), 0.09, 3, this.sfx, i * 0.18));
  }
  rumble() {
    if (!this.ok) return;
    this.noiseBurst(1.4, 'lowpass', 160, 50, 0.5, 1);
  }

  // mumble voice blip for typewriter text
  blip(v) {
    if (!this.ok || !v) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = v.wave;
    const f = v.base * (1 + (Math.random() - 0.5) * v.vary * 2);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * (0.85 + Math.random() * 0.3), t + 0.08);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = v.f1 + Math.random() * (v.f2 - v.f1);
    bp.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v.gain * 3, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(bp).connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.12);
  }
}
