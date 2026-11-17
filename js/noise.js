// Shared procedural-noise + painting library used by every texture recipe.
// Everything here tiles seamlessly: noise is periodic over the [0,1) tile and
// canvas brushwork is drawn at every wrap offset.
import { makeRng, TAU } from './util.js';

const TS = 256, TM = 255;
const TAB = new Float32Array(TS * TS);
{
  const r = makeRng(90210);
  for (let i = 0; i < TAB.length; i++) TAB[i] = r();
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const sstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const mix = (a, b, t) => a + (b - a) * t;
export const fract = (x) => x - Math.floor(x);
export const hash = (a, b, s = 0) => TAB[(((b * 3 + s * 31) & TM) << 8) | ((a * 5 + s * 17) & TM)];

// Periodic value noise. (x,y) in lattice units, period (px,py) cells. -> [-1,1]
export function vnoise(x, y, px, py, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  let x0 = xi % px; if (x0 < 0) x0 += px;
  let y0 = yi % py; if (y0 < 0) y0 += py;
  const x1 = x0 + 1 === px ? 0 : x0 + 1, y1 = y0 + 1 === py ? 0 : y0 + 1;
  const ox = (s * 59) & TM, oy = (s * 113 + 17) & TM;
  const r0 = ((y0 + oy) & TM) << 8, r1 = ((y1 + oy) & TM) << 8;
  const a = TAB[r0 | ((x0 + ox) & TM)], b = TAB[r0 | ((x1 + ox) & TM)];
  const c = TAB[r1 | ((x0 + ox) & TM)], d = TAB[r1 | ((x1 + ox) & TM)];
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

// Tileable fbm over the unit tile. base = cells per tile (x), by = cells (y).
// Output roughly [-1,1] (scaled so typical values span most of it).
export function fbm(u, v, base, oct = 4, s = 0, gain = 0.5, by = base) {
  let sum = 0, amp = 1, norm = 0, px = base, py = by;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(u * px, v * py, px, py, s + i * 7);
    norm += amp;
    amp *= gain;
    px *= 2;
    py *= 2;
  }
  const r = (sum / norm) * 1.7;
  return r < -1 ? -1 : r > 1 ? 1 : r;
}

// Ridged noise: sharp creases (veins, cracks, crevices). -> [0,1]
export function ridged(u, v, base, oct = 4, s = 0, by = base) {
  let sum = 0, amp = 1, norm = 0, px = base, py = by;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(vnoise(u * px, v * py, px, py, s + i * 11));
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    px *= 2;
    py *= 2;
  }
  return sum / norm;
}

// Domain-warped fbm: swirly, marbled, roiling.
export function warp(u, v, base, oct, s, k) {
  const qx = fbm(u, v, base, 3, s + 31), qy = fbm(u, v, base, 3, s + 47);
  return fbm(u + qx * k, v + qy * k, base, oct, s);
}

// Tileable Voronoi. n = cells per tile. Fills `o` with:
// f1,f2 (cell units), id (0..1), dx,dy (pixel -> feature point), cx,cy (cell idx)
export function voronoi(u, v, n, s = 0, jit = 0.85, o = {}) {
  const X = u * n, Y = v * n;
  const xi = Math.floor(X), yi = Math.floor(Y);
  let f1 = 9, f2 = 9;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      let wx = cx % n; if (wx < 0) wx += n;
      let wy = cy % n; if (wy < 0) wy += n;
      const px = cx + 0.5 + (hash(wx, wy, s) - 0.5) * jit;
      const py = cy + 0.5 + (hash(wx, wy, s + 101) - 0.5) * jit;
      const ddx = px - X, ddy = py - Y;
      const d = ddx * ddx + ddy * ddy;
      if (d < f1) {
        f2 = f1;
        f1 = d;
        o.id = hash(wx, wy, s + 203);
        o.dx = ddx;
        o.dy = ddy;
        o.cx = wx;
        o.cy = wy;
      } else if (d < f2) f2 = d;
    }
  o.f1 = Math.sqrt(f1);
  o.f2 = Math.sqrt(f2);
  return o;
}

// ---------------------------------------------------------------------
// Scalar fields
export function field(S, fn) {
  const a = new Float32Array(S * S);
  for (let y = 0, i = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++, i++) a[i] = fn(x / S, v, x, y);
  }
  return a;
}
// Low-frequency field computed at 1/f resolution, bilinearly upsampled (wraps).
export function lowField(S, f, fn) {
  const L = S / f, lo = new Float32Array(L * L);
  for (let y = 0; y < L; y++) for (let x = 0; x < L; x++) lo[y * L + x] = fn(x / L, y / L);
  const a = new Float32Array(S * S);
  for (let y = 0, i = 0; y < S; y++) {
    const gy = y / f, y0 = Math.floor(gy), ty = gy - y0, ya = (y0 % L) * L, yb = ((y0 + 1) % L) * L;
    for (let x = 0; x < S; x++, i++) {
      const gx = x / f, x0 = Math.floor(gx), tx = gx - x0, xa = x0 % L, xb = (x0 + 1) % L;
      const p = lo[ya + xa] + (lo[ya + xb] - lo[ya + xa]) * tx;
      const q = lo[yb + xa] + (lo[yb + xb] - lo[yb + xa]) * tx;
      a[i] = p + (q - p) * ty;
    }
  }
  return a;
}
// Wrapping box blur of a scalar field (r px), used for soft AO/halos.
export function blur(a, S, r) {
  const t = new Float32Array(S * S), o = new Float32Array(S * S), k = 1 / (2 * r + 1);
  for (let y = 0; y < S; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += a[y * S + ((x + S) % S)];
    for (let x = 0; x < S; x++) {
      t[y * S + x] = acc * k;
      acc += a[y * S + ((x + r + 1) % S)] - a[y * S + ((x - r + S) % S)];
    }
  }
  for (let x = 0; x < S; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += t[((y + S) % S) * S + x];
    for (let y = 0; y < S; y++) {
      o[y * S + x] = acc * k;
      acc += t[((y + r + 1) % S) * S + x] - t[((y - r + S) % S) * S + x];
    }
  }
  return o;
}
// Bake light-from-top-left shading out of a height field (no normal maps).
// Returns a multiplier field around 1.
export function bump(H, S, strength) {
  const o = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const yu = ((y - 1 + S) % S) * S, yd = ((y + 1) % S) * S, yc = y * S;
    for (let x = 0; x < S; x++) {
      const xl = (x - 1 + S) % S, xr = (x + 1) % S;
      const gx = H[yc + xr] - H[yc + xl], gy = H[yd + x] - H[yu + x];
      o[yc + x] = 1 + (gx * 0.6 + gy * 0.8) * strength;
    }
  }
  return o;
}

// ---------------------------------------------------------------------
// Colour buffers (float RGB 0..1, top row = "up")
export const hexc = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
export function mixc(o, a, b, t) {
  o[0] = a[0] + (b[0] - a[0]) * t;
  o[1] = a[1] + (b[1] - a[1]) * t;
  o[2] = a[2] + (b[2] - a[2]) * t;
  return o;
}
export function lerpInto(o, b, t) {
  o[0] += (b[0] - o[0]) * t;
  o[1] += (b[1] - o[1]) * t;
  o[2] += (b[2] - o[2]) * t;
  return o;
}
export const css = (c, a = 1, m = 1) =>
  `rgba(${Math.round(Math.min(255, c[0] * 255 * m))},${Math.round(Math.min(255, c[1] * 255 * m))},${Math.round(Math.min(255, c[2] * 255 * m))},${a})`;

export function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Per-pixel generator -> canvas. fn(u, v, i, out) writes 0..1 RGB into out.
export function paint(W, H, fn, c = canvas(W, H)) {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(W, H), d = img.data, out = [0, 0, 0];
  for (let y = 0, i = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++, i++) {
      fn(x / W, v, i, out, x, y);
      const k = i * 4;
      d[k] = out[0] * 255;
      d[k + 1] = out[1] * 255;
      d[k + 2] = out[2] * 255;
      d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Per-pixel post pass over an existing canvas. fn(u,v,i,rgb[0..1],x,y) mutates rgb.
export function post(c, fn) {
  const W = c.width, H = c.height, ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, W, H), d = img.data, p = [0, 0, 0];
  for (let y = 0, i = 0; y < H; y++)
    for (let x = 0; x < W; x++, i++) {
      const k = i * 4;
      p[0] = d[k] / 255; p[1] = d[k + 1] / 255; p[2] = d[k + 2] / 255;
      fn(x / W, y / H, i, p, x, y, d[k + 3]);
      d[k] = p[0] * 255; d[k + 1] = p[1] * 255; d[k + 2] = p[2] * 255;
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

// The shared finishing pass: dense grain, speckle, contrast, saturation,
// and desaturation that only bites in the shadows.
export function finish(c, seed, o = {}) {
  const rng = makeRng(seed);
  const grain = o.grain ?? 0.05, speck = o.speck ?? 0.025, sAmt = o.speckAmt ?? 0.28;
  const con = o.contrast ?? 1.08, sat = o.sat ?? 1.12, sd = o.shadowDesat ?? 0.35;
  return post(c, (u, v, i, p) => {
    let n = (rng() - 0.5) * grain + (rng() - 0.5) * grain * 0.5;
    if (rng() < speck) n += (rng() < 0.55 ? -1 : 0.7) * sAmt * (0.5 + rng() * 0.5);
    for (let k = 0; k < 3; k++) p[k] = (p[k] - 0.5) * con + 0.5 + n * (0.4 + p[k]);
    const L = p[0] * 0.3 + p[1] * 0.55 + p[2] * 0.15;
    const s = sat * (1 - sd * sstep(0.32, 0.04, L));
    for (let k = 0; k < 3; k++) p[k] = clamp01(L + (p[k] - L) * s);
  });
}

// ---------------------------------------------------------------------
// Brushwork (all wrap so tiles stay seamless)
export function wrapAt(W, H, x, y, r, fn) {
  for (let ox = -1; ox <= 1; ox++)
    for (let oy = -1; oy <= 1; oy++) {
      const xx = x + ox * W, yy = y + oy * H;
      if (xx + r < 0 || xx - r > W || yy + r < 0 || yy - r > H) continue;
      fn(xx, yy);
    }
}
// Soft airbrush dab.
export function dab(ctx, W, H, x, y, r, col, a = 1, sy = 1, rot = 0) {
  wrapAt(W, H, x, y, r * Math.max(1, sy), (xx, yy) => {
    ctx.save();
    ctx.translate(xx, yy);
    ctx.rotate(rot);
    ctx.scale(1, sy);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, css(col, a));
    g.addColorStop(0.55, css(col, a * 0.45));
    g.addColorStop(1, css(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.restore();
  });
}
// Hard painted dot / ellipse.
export function dot(ctx, W, H, x, y, r, col, a = 1, ry = r, rot = 0) {
  ctx.fillStyle = css(col, a);
  wrapAt(W, H, x, y, Math.max(r, ry), (xx, yy) => {
    ctx.beginPath();
    ctx.ellipse(xx, yy, r, ry, rot, 0, TAU);
    ctx.fill();
  });
}
// Curved brush stroke.
export function stroke(ctx, W, H, x, y, ang, len, w, col, a = 1, bend = 0.3) {
  ctx.strokeStyle = css(col, a);
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  const ex = Math.cos(ang) * len, ey = Math.sin(ang) * len;
  const mx = ex * 0.5 - ey * bend, my = ey * 0.5 + ex * bend;
  wrapAt(W, H, x, y, len + w, (xx, yy) => {
    ctx.beginPath();
    ctx.moveTo(xx, yy);
    ctx.quadraticCurveTo(xx + mx, yy + my, xx + ex, yy + ey);
    ctx.stroke();
  });
}
// Bristle stroke: several thin parallel hairs with uneven paint load.
export function bristle(ctx, W, H, rng, x, y, ang, len, w, col, a = 0.3, hairs = 5) {
  const nx = -Math.sin(ang), ny = Math.cos(ang);
  for (let h = 0; h < hairs; h++) {
    const o = ((h + 0.5) / hairs - 0.5) * w;
    const l = len * (0.7 + rng() * 0.3);
    stroke(ctx, W, H, x + nx * o, y + ny * o, ang + (rng() - 0.5) * 0.06, l, Math.max(0.6, (w / hairs) * (0.6 + rng() * 0.8)), col, a * (0.4 + rng() * 0.6), 0.08);
  }
}
// Paired dark/light strokes: reads as baked bump / sculpted form.
export function bumpStrokes(ctx, W, H, rng, n, o = {}) {
  const lenA = o.len ?? [6, 16], wA = o.w ?? [2, 4], a = o.a ?? 0.14;
  const light = o.light ?? [1, 1, 1], dark = o.dark ?? [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const x = rng() * W, y = rng() * H;
    const ang = o.ang !== undefined ? o.ang + (rng() - 0.5) * (o.angJit ?? 0.5) : rng() * TAU;
    const len = lenA[0] + rng() * (lenA[1] - lenA[0]), w = wA[0] + rng() * (wA[1] - wA[0]);
    const bend = (rng() - 0.5) * 0.6;
    stroke(ctx, W, H, x + w * 0.45, y + w * 0.55, ang, len, w, dark, a, bend);
    stroke(ctx, W, H, x, y, ang, len, w * 0.7, light, a * 0.9, bend);
  }
}
// Scattered hard specks (grit, glints, star dust).
export function speckles(ctx, W, H, rng, n, cols, rA = [0.5, 1.4], aA = [0.3, 0.8]) {
  for (let i = 0; i < n; i++) {
    const col = cols[Math.floor(rng() * cols.length)];
    dot(ctx, W, H, rng() * W, rng() * H, rA[0] + rng() * (rA[1] - rA[0]), col, aA[0] + rng() * (aA[1] - aA[0]));
  }
}
