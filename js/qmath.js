// Tiny allocation-light vector/quaternion helpers on plain {x,y,z(,w)}
// objects, the shape Rapier returns. Pure (no three.js) so the ragdoll
// controller runs (and is tested) under node.

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const q4 = (x = 0, y = 0, z = 0, w = 1) => ({ x, y, z, w });

export function qmul(a, b, out = q4()) {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x; out.y = y; out.z = z; out.w = w;
  return out;
}

export function qconj(a, out = q4()) {
  out.x = -a.x; out.y = -a.y; out.z = -a.z; out.w = a.w;
  return out;
}

export function qnorm(a) {
  const l = Math.hypot(a.x, a.y, a.z, a.w) || 1;
  a.x /= l; a.y /= l; a.z /= l; a.w /= l;
  return a;
}

/** Rotate vector v by unit quaternion q. */
export function qrot(q, v, out = v3()) {
  const { x, y, z } = v;
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  out.x = x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = z + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}

/** Rotation vector (axis * angle, shortest arc) of a unit quaternion. */
export function qlog(q, out = v3()) {
  let { x, y, z, w } = q;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.hypot(x, y, z);
  if (s < 1e-9) { out.x = 2 * x; out.y = 2 * y; out.z = 2 * z; return out; }
  const k = (2 * Math.atan2(s, w)) / s;
  out.x = x * k; out.y = y * k; out.z = z * k;
  return out;
}

/** Unit quaternion from a rotation vector. */
export function qexp(v, out = q4()) {
  const a = Math.hypot(v.x, v.y, v.z);
  if (a < 1e-9) { out.x = v.x / 2; out.y = v.y / 2; out.z = v.z / 2; out.w = 1; return qnorm(out); }
  const s = Math.sin(a / 2) / a;
  out.x = v.x * s; out.y = v.y * s; out.z = v.z * s; out.w = Math.cos(a / 2);
  return out;
}

export function qyaw(yaw, out = q4()) {
  out.x = 0; out.y = Math.sin(yaw / 2); out.z = 0; out.w = Math.cos(yaw / 2);
  return out;
}

/** Heading (rotation about +Y) of a body's forward (-Z) axis. */
export function yawOf(q) {
  const f = qrot(q, { x: 0, y: 0, z: -1 });
  return Math.atan2(-f.x, -f.z);
}

/** Angle (rad) between a body's local +Y and world up. */
export function tiltOf(q) {
  const u = qrot(q, { x: 0, y: 1, z: 0 });
  return Math.acos(Math.max(-1, Math.min(1, u.y)));
}

export function qslerp(a, b, t, out = q4()) {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  let c = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (c < 0) { c = -c; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let k0 = 1 - t, k1 = t;
  if (c < 0.9995) {
    const th = Math.acos(c), s = Math.sin(th);
    k0 = Math.sin((1 - t) * th) / s;
    k1 = Math.sin(t * th) / s;
  }
  out.x = a.x * k0 + bx * k1; out.y = a.y * k0 + by * k1; out.z = a.z * k0 + bz * k1; out.w = a.w * k0 + bw * k1;
  return qnorm(out);
}

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export function wrapPi(a) {
  const t = Math.PI * 2;
  let r = ((a % t) + t) % t;
  if (r > Math.PI) r -= t;
  return r;
}
