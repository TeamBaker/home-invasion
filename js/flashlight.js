// Flashlight light model — pure math + GLSL, no three.js import (unit-testable in node).
//
// The beam is a single direct spotlight with a real shadow map and NO bounce light:
//   1. Depth pass: room occluders + monster rendered depth-only from the flashlight
//      into a small depth texture (one pass per frame, not per eye).
//   2. Receiver pass: the same geometry is redrawn stencil-only (colorWrite off). Each
//      fragment survives — and writes stencil=1, erasing the darkness overlay — only if
//      it is inside the cone, within range, faces the light, and is not occluded in the
//      shadow map. So the lit region is computed per pixel on the actual surfaces:
//      raised features light up on their light-facing sides and cast real shadows.
//
// `isLit()` is the exact CPU mirror of the fragment shader's predicate; the shader is
// generated from the same constants, so the unit tests exercise the real decision logic.

export const FLASH = {
  coneAngle: 30,          // degrees, FULL cone angle (old disks effectively spread ~1.45x wider)
  range: 12,              // metres
  near: 0.1,              // shadow camera near plane (metres)
  shadowRes: 512,         // depth-map size; texel ≈ 2.3 mm at 2 m
  fovMargin: 4,           // degrees added to the shadow frustum so the cone edge never clips
  ndotlMin: 0.05,         // surfaces more grazing than ~87° to the beam stay dark (CPU bool twin)
  faceFadeEnd: 0.55,      // grazing faces fade smoothly to dark across this N·L range (shader only)
  biasConst: 0.004,       // metres of constant depth bias
  biasSlopeTexels: 1.5,   // slope-scaled bias, in shadow-map texels
  maxSlope: 8,            // clamp on tan(incidence) for the slope bias
};

export const shadowFov = (cfg = FLASH) => cfg.coneAngle + cfg.fovMargin;
export const coneCos = (cfg = FLASH) => Math.cos((cfg.coneAngle * Math.PI) / 360);
/** World size of one shadow texel per metre of light-space depth. */
export const texelScale = (cfg = FLASH) => (2 * Math.tan((shadowFov(cfg) * Math.PI) / 360)) / cfg.shadowRes;

/** Perspective depth-buffer value (0..1) → linear depth along the light axis. */
export function linearizeDepth(z, near, far) {
  const ndc = z * 2 - 1;
  return (2 * near * far) / (far + near - ndc * (far - near));
}
/** Linear depth along the light axis → depth-buffer value (0..1). Inverse of linearizeDepth. */
export function perspectiveDepth(viewZ, near, far) {
  const ndc = (far + near - (2 * near * far) / viewZ) / (far - near);
  return ndc * 0.5 + 0.5;
}

/** Depth bias (metres) for a receiver at light-space depth `w` with N·L = `ndl`. */
export function shadowBias(w, ndl, cfg = FLASH) {
  const tanT = Math.min(Math.sqrt(Math.max(1 - ndl * ndl, 0)) / ndl, cfg.maxSlope);
  return cfg.biasConst + cfg.biasSlopeTexels * texelScale(cfg) * w * tanT;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.sqrt(dot(a, a));

/**
 * Light-space projection (CPU twin of uLightVP). light = { pos, right, up, fwd } (unit,
 * orthonormal). Returns uv in 0..1 and w = depth along the light axis.
 */
export function lightProject(p, light, cfg = FLASH) {
  const r = sub(p, light.pos);
  const w = dot(r, light.fwd);
  const t = Math.tan((shadowFov(cfg) * Math.PI) / 360);
  return { u: (dot(r, light.right) / (w * t)) * 0.5 + 0.5, v: (dot(r, light.up) / (w * t)) * 0.5 + 0.5, w };
}

/**
 * The per-pixel light decision.
 *   p        world point on a visible surface
 *   n        its geometric normal (either orientation)
 *   eye      viewer position (normal is flipped to face the viewer, like the shader)
 *   light    { pos, right, up, fwd }
 *   sampleDepth(u, v) → raw 0..1 depth from the shadow map
 */
export function isLit(p, n, eye, light, sampleDepth, cfg = FLASH) {
  const toL = sub(light.pos, p);
  const d = len(toL);
  if (d > cfg.range) return false;
  const L = [toL[0] / d, toL[1] / d, toL[2] / d];
  if (-dot(L, light.fwd) < coneCos(cfg)) return false;
  let N = n;
  if (dot(N, sub(eye, p)) < 0) N = [-N[0], -N[1], -N[2]];
  const ndl = dot(N, L) / len(N);
  if (ndl < cfg.ndotlMin) return false;
  const { u, v, w } = lightProject(p, light, cfg);
  const occ = linearizeDepth(sampleDepth(u, v), cfg.near, cfg.range);
  return w - occ <= shadowBias(w, ndl, cfg);
}

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/** GLSL for the receiver (stencil-writing) material — same predicate as isLit(). */
export function receiverShaders(cfg = FLASH, opts = {}) {
  const thru = opts.thru === true;
  const vertexShader = /* glsl */ `
    varying vec3 vWorld;
    void main() {
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;
  const fragmentShader = /* glsl */ `
    ${thru ? '#define THRU 1' : ''}
    uniform vec3 uLightPos;
    uniform vec3 uLightDir;
    uniform mat4 uLightVP;
    uniform sampler2D uShadow;
    varying vec3 vWorld;
    const float RANGE = ${f(cfg.range)};
    const float NEAR = ${f(cfg.near)};
    const float CONE_COS = ${coneCos(cfg).toFixed(6)};
    const float BIAS_CONST = ${f(cfg.biasConst)};
    const float BIAS_SLOPE = ${(cfg.biasSlopeTexels * texelScale(cfg)).toExponential(6)};
    const float MAX_SLOPE = ${f(cfg.maxSlope)};
    uniform float uDist;
    uniform float uOverReach;
    uniform float uClass;
    uniform float uFade;
    float linZ(float z) {
      float ndc = z * 2.0 - 1.0;
      return 2.0 * NEAR * RANGE / (RANGE + NEAR - ndc * (RANGE - NEAR));
    }
    void main() {
      vec3 toL = uLightPos - vWorld;
      float d = length(toL);
      vec3 L = toL / d;
      
      // Distance attenuation: LINEAR fade to black from the flashlight to the
      // FALLOFF DISTANCE (uDist, metres). Fully lit at the lamp, zero exactly at
      // uDist. FLASH OVER is a shorter linear window inside this same distance.
      float falloffFactor = clamp(1.0 - d / uDist, 0.0, 1.0);
      
      // Calculate cone edge fade factor (0-1)
      float coneDot = dot(-L, uLightDir);
      float fadeFactor = smoothstep(CONE_COS - 0.2 * uFade, CONE_COS, coneDot);
      
      // Combine falloff and fade
      float visibility = falloffFactor * fadeFactor;
      float shape = fadeFactor;
      
      if (visibility <= 0.0 || d > RANGE || coneDot < CONE_COS - 0.2) discard;
      
      // Flat geometric normal from screen derivatives (no normal attribute needed),
      // oriented toward the viewer: we can only see the lit side if the light is on our side.
      vec3 N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
      if (dot(N, cameraPosition - vWorld) < 0.0) N = -N;
      float ndl = dot(N, L);
      #ifndef THRU
      if (ndl <= 0.0) discard;
      #endif
      vec4 lc = uLightVP * vec4(vWorld, 1.0);
      vec2 uv = lc.xy / lc.w * 0.5 + 0.5;
      float occ = linZ(texture2D(uShadow, uv).r);
      float tanT = min(sqrt(max(1.0 - ndl * ndl, 0.0)) / ndl, MAX_SLOPE);
      if (lc.w - occ > BIAS_CONST + BIAS_SLOPE * lc.w * tanT) discard;
      
      // G = over-bright amount: the beam's FULL shape (cone edge + fade + N·L,
      // same dimensions as the main light) scaled by the FLASH OVER linear reach
      // (white at the lamp, zero at uOverReach). A = full visibility (with the
      // distance falloff) for the darkness removal.
      float overShape = shape * clamp(1.0 - d / uOverReach, 0.0, 1.0) * step(0.0001, uOverReach);
      // B = surface class: 1 = dynamic mesh (furniture), 0 = structure
      // (walls / floor / ceiling / monster). Gates where the blur applies.
      gl_FragColor = vec4(0.0, overShape, uClass, visibility);
    }`;
  return { vertexShader, fragmentShader };
}
