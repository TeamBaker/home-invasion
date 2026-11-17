// Pure input math shared by the desktop and WebXR controls (no three.js, no
// DOM) so it runs under node:test.

/** Camera-relative stick -> world XZ move vector (pure, tested). */
export function cameraRelativeMove(forward, strafe, yaw) {
  return cameraRelativeMoveInto(forward, strafe, yaw, { x: 0, z: 0 });
}

/** cameraRelativeMove into an existing { x, z } (no allocation). */
export function cameraRelativeMoveInto(forward, strafe, yaw, out) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw); // camera forward (-Z rotated by yaw)
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);  // camera right
  let x = fx * forward + rx * strafe, z = fz * forward + rz * strafe;
  const l = Math.hypot(x, z);
  if (l > 1) { x /= l; z /= l; }
  out.x = x; out.z = z;
  return out;
}

export const SNAP_ANGLE = Math.PI / 6;
export const LEASH = 0.3; // m of head-vs-body slack before the dolly is dragged

/** Radial stick deadzone, rescaled so motion starts at 0 just past it (pure). */
export function deadzone(x, y, dz = 0.18) {
  const l = Math.hypot(x, y);
  if (l < dz) return { x: 0, y: 0 };
  const k = Math.min(1, (l - dz) / (1 - dz)) / l;
  return { x: x * k, y: y * k };
}

/**
 * Radial deadzone plus a response curve, written into `out` { x, y, mag } (no
 * allocation). mag is 0 inside the deadzone and reaches 1 at full deflection;
 * exponent 1 is linear, 2 gives finer control near the centre.
 */
export function stickCurve(x, y, dz, exponent, out) {
  const l = Math.hypot(x, y);
  if (l < dz || l === 0) { out.x = 0; out.y = 0; out.mag = 0; return out; }
  const mag = Math.pow(Math.min(1, (l - dz) / (1 - dz)), exponent);
  out.x = x / l * mag; out.y = y / l * mag; out.mag = mag;
  return out;
}

/** Snap-turn trigger with hysteresis (pure): returns { turn: -1|0|1, armed }. */
export function snapTurn(x, armed) {
  if (armed && Math.abs(x) > 0.7) return { turn: x > 0 ? -1 : 1, armed: false };
  if (!armed && Math.abs(x) < 0.3) return { turn: 0, armed: true };
  return { turn: 0, armed };
}

/** Leash correction (pure): how far to move the dolly so |head - body| <= slack (XZ). */
export function leash(head, body, slack = LEASH) {
  const dx = body.x - head.x, dz = body.z - head.z, d = Math.hypot(dx, dz);
  if (d <= slack || d < 1e-9) return { x: 0, z: 0 };
  const k = (d - slack) / d;
  return { x: dx * k, z: dz * k };
}

// --- The input sink ----------------------------------------------------------------
//
// Every flat-screen source (keyboard + mouse, touch, gamepad) writes the same
// commands here, and the sink is the only thing that fills a ragdoll intent.
// Each frame: beginFrame(), every source's poll(), then fillIntent().
// Contributions add up, so two sources can be used at once.

export const PITCH_LIMIT = 1.45;
export const MOUSE_SENSITIVITY = 0.0022; // rad per pixel

/** Commands that last as long as they are held. */
export const HELD = Object.freeze({ JUMP: 'jump', CROUCH: 'crouch', RUN: 'run', LIMP: 'limp', INTERACT: 'interact', REACH_L: 'reachL', REACH_R: 'reachR' });

/** One-shot commands. */
export const EVENTS = Object.freeze({
  BUILD: 'build', PANEL: 'panel', RESPAWN: 'respawn', CAMERA: 'camera',
  TOOL_PREV: 'toolPrev', TOOL_NEXT: 'toolNext', SLOT_PREV: 'slotPrev', SLOT_NEXT: 'slotNext',
  CONFIRM: 'confirm', CANCEL: 'cancel', DELETE: 'delete', UNDO: 'undo', REDO: 'redo',
  NAV_UP: 'navUp', NAV_DOWN: 'navDown', NAV_LEFT: 'navLeft', NAV_RIGHT: 'navRight', NAV_OK: 'navOk',
  CHAT: 'chat', // open the chat input (batch K)
});

export class InputSink {
  constructor() {
    this.yaw = 0;
    this.pitch = -0.1;
    this.third = false;
    this.forward = 0;
    this.strafe = 0;
    this.frameYaw = 0;   // look applied since beginFrame: the build camera uses it
    this.framePitch = 0;
    this.held = { jump: false, crouch: false, run: false, limp: false, interact: false, reachL: false, reachR: false };
    this.onEvent = null;
    this._move = { x: 0, z: 0 };
  }

  beginFrame() {
    this.forward = 0;
    this.strafe = 0;
    this.frameYaw = 0;
    this.framePitch = 0;
    const h = this.held;
    h.jump = h.crouch = h.run = h.limp = h.interact = h.reachL = h.reachR = false;
  }

  move(forward, strafe) { this.forward += forward; this.strafe += strafe; }

  look(dYaw, dPitch) {
    this.yaw += dYaw;
    this.pitch = Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, this.pitch + dPitch));
    this.frameYaw += dYaw;
    this.framePitch += dPitch;
  }

  hold(cmd) { this.held[cmd] = true; }

  fire(event) {
    if (event === EVENTS.CAMERA) this.third = !this.third;
    this.onEvent?.(event);
  }

  /** Write this frame's commands into a ragdoll intent. chest: the chest position { x, y, z }. */
  fillIntent(intent, chest) {
    const h = this.held;
    intent.move = cameraRelativeMoveInto(this.forward, this.strafe, this.yaw, this._move);
    intent.run = h.run;
    intent.crouch = h.crouch;
    intent.jump = h.jump;
    intent.limp = h.limp;
    intent.faceYaw = this.yaw;
    intent.lookYaw = this.yaw;
    intent.lookPitch = this.pitch;
    intent.vr = false;
    intent.headTarget = null;
    // Reach out along the look direction (shoulder height, 0.6 m out), each
    // hand on its own side. Force-tracked, so a crate in the way gets shoved
    // and a wall pushes you back.
    const left = h.reachL || h.interact, right = h.reachR || h.interact;
    const cp = Math.cos(this.pitch), dx = -Math.sin(this.yaw) * cp, dy = Math.sin(this.pitch), dz = -Math.cos(this.yaw) * cp;
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    for (let i = 0; i < 2; i++) {
      if (!(i === 0 ? left : right)) { intent.reach[i] = null; continue; }
      const side = i === 0 ? -1 : 1;
      const r = intent.reach[i] || { p: { x: 0, y: 0, z: 0 } };
      r.p.x = chest.x + dx * 0.62 + rx * side * 0.17;
      r.p.y = chest.y + 0.12 + dy * 0.62;
      r.p.z = chest.z + dz * 0.62 + rz * side * 0.17;
      r.q = null;
      intent.reach[i] = r;
    }
    intent.fist[0] = left;
    intent.fist[1] = right;
  }
}

const MOVE_KEYS = { KeyW: 'f', KeyS: 'b', KeyA: 'l', KeyD: 'r', ArrowUp: 'f', ArrowDown: 'b', ArrowLeft: 'l', ArrowRight: 'r' };

/** Keyboard + mouse, minus the DOM (client/controls.js feeds it the events). */
export class KeyMouseSource {
  constructor(sink) {
    this.sink = sink;
    this.held = new Set();
    this.buttons = [false, false];
    this.sensitivity = MOUSE_SENSITIVITY;
  }

  keyDown(code) {
    if (code === 'KeyR') this.sink.fire(EVENTS.RESPAWN);
    else if (code === 'KeyV') this.sink.fire(EVENTS.CAMERA);
    this.held.add(code);
  }

  keyUp(code) { this.held.delete(code); }
  mouseMove(dx, dy) { this.sink.look(-dx * this.sensitivity, -dy * this.sensitivity); }
  clear() { this.held.clear(); this.buttons = [false, false]; }

  poll() {
    const h = this.held, sink = this.sink;
    let f = 0, s = 0;
    for (const code of h) {
      const k = MOVE_KEYS[code];
      if (k === 'f') f += 1; else if (k === 'b') f -= 1; else if (k === 'r') s += 1; else if (k === 'l') s -= 1;
    }
    sink.move(Math.sign(f), Math.sign(s));
    if (h.has('ShiftLeft') || h.has('ShiftRight')) sink.hold(HELD.RUN);
    if (h.has('KeyC') || h.has('ControlLeft')) sink.hold(HELD.CROUCH);
    if (h.has('Space')) sink.hold(HELD.JUMP);
    if (h.has('KeyG')) sink.hold(HELD.LIMP);
    if (this.buttons[0]) sink.hold(HELD.REACH_L);
    if (this.buttons[1]) sink.hold(HELD.REACH_R);
  }
}

/**
 * The XR controllers' stick and button commands (pure). The HMD and hand poses
 * stay in client/vr.js, because only a headset has them.
 */
export function xrPadCommands(left, right, out) {
  const stick = left && left.axes.length >= 4 ? 2 : 0;
  const lx = left && left.axes.length >= 2 ? left.axes[stick] : 0;
  const ly = left && left.axes.length >= 2 ? left.axes[stick + 1] : 0;
  const s = deadzone(lx, ly);
  const pressed = (g, i) => !!(g && g.buttons[i] && g.buttons[i].pressed);
  out.forward = -s.y;
  out.strafe = s.x;
  out.run = pressed(left, 3);
  out.jump = pressed(right, 4) || pressed(left, 4);
  return out;
}
