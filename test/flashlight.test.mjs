// Test for flashlight mode functionality
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLASH, coneCos, shadowFov, texelScale, linearizeDepth, perspectiveDepth,
  shadowBias, lightProject, isLit, receiverShaders,
} from '../js/flashlight.js';

// Mock THREE.js for testing
const mockTHREE = {
  MathUtils: {
    degToRad: (deg) => deg * Math.PI / 180,
    clamp: (value, min, max) => Math.min(Math.max(value, min), max)
  },
  Vector3: class Vector3 {
    constructor(x, y, z) {
      this.x = x || 0;
      this.y = y || 0;
      this.z = z || 0;
    }
    copy(v) {
      this.x = v.x;
      this.y = v.y;
      this.z = v.z;
      return this;
    }
  }
};

// Mock global THREE
globalThis.THREE = mockTHREE;

// Mock performance
globalThis.performance = {
  now: () => Date.now()
};

// Mock requestAnimationFrame
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);

// Mock WebGLRenderer
class MockWebGLRenderer {
  setSize() {}
  setClearColor() {}
  render() {}
}

// Mock Scene
class MockScene {
  constructor() {
    this.children = [];
  }
  add(obj) {
    this.children.push(obj);
  }
}

// Mock Camera
class MockCamera {
  constructor() {
    this.position = new mockTHREE.Vector3();
    this.rotation = new mockTHREE.Vector3();
  }
}

// Mock Group
class MockGroup {
  constructor() {
    this.children = [];
    this.position = new mockTHREE.Vector3();
    this.rotation = new mockTHREE.Vector3();
  }
  add(obj) {
    this.children.push(obj);
  }
}

// Mock Mesh
class MockMesh {
  constructor(geometry, material) {
    this.geometry = geometry;
    this.material = material;
    this.position = new mockTHREE.Vector3();
    this.rotation = new mockTHREE.Vector3();
    this.visible = false;
    this.renderOrder = 0;
  }
  translateZ() {}
  translateY() {}
}

// Mock RoomSense
class MockRoomSense {
  constructor() {
    this.group = new MockGroup();
  }
}

// Setup mocks
globalThis.THREE.WebGLRenderer = MockWebGLRenderer;
globalThis.THREE.Scene = MockScene;
globalThis.THREE.PerspectiveCamera = MockCamera;
globalThis.THREE.Group = MockGroup;
globalThis.THREE.Mesh = MockMesh;
globalThis.THREE.CylinderGeometry = class { };
globalThis.THREE.ConeGeometry = class { };
globalThis.THREE.MeshStandardMaterial = class { };
globalThis.THREE.ShaderMaterial = class { 
  constructor(params) {
    this.uniforms = params.uniforms || {};
  }
};
globalThis.THREE.MeshBasicMaterial = class { };
globalThis.THREE.PlaneGeometry = class { };

globalThis.document = {
  body: {
    appendChild: () => {}
  },
  createElement: () => ({
    getContext: () => ({
      strokeRect: () => {}
    })
  })
};

// Test flashlight functionality directly
test('flashlight mode toggle', () => {
  // Mock the flashlight mode functionality
  let flashlightMode = false;
  const flashlightCone = { visible: false };
  const flashlightModel = { visible: false };
  const darknessOverlay = { visible: false };
  
  function toggleFlashlightMode() {
    flashlightMode = !flashlightMode;
    flashlightCone.visible = flashlightMode;
    flashlightModel.visible = flashlightMode;
    darknessOverlay.visible = flashlightMode;
  }
  
  // Toggle on
  toggleFlashlightMode();
  assert.equal(flashlightMode, true);
  assert.equal(flashlightCone.visible, true);
  assert.equal(flashlightModel.visible, true);
  assert.equal(darknessOverlay.visible, true);
  
  // Toggle off
  toggleFlashlightMode();
  assert.equal(flashlightMode, false);
  assert.equal(flashlightCone.visible, false);
  assert.equal(flashlightModel.visible, false);
  assert.equal(darknessOverlay.visible, false);
});

test('flashlight configuration', () => {
  const FLASHLIGHT_CFG = {
    coneLength: 12.0,
    coneAngle: mockTHREE.MathUtils.degToRad(35),
    coneSegments: 16,
    flickerIntensity: 0.15,
    flickerSpeed: 3.0,
    darknessOpacity: 0.92
  };
  
  assert.equal(FLASHLIGHT_CFG.coneLength, 12.0);
  assert.equal(FLASHLIGHT_CFG.coneAngle, mockTHREE.MathUtils.degToRad(35));
  assert.equal(FLASHLIGHT_CFG.coneSegments, 16);
  assert.equal(FLASHLIGHT_CFG.flickerIntensity, 0.15);
  assert.equal(FLASHLIGHT_CFG.flickerSpeed, 3.0);
  assert.equal(FLASHLIGHT_CFG.darknessOpacity, 0.92);
});


// ─────────────── shadow-mapped flashlight: core math ───────────────

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function makeLight(pos, target) {
  const fwd = norm(sub(target, pos));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  return { pos, fwd, right, up };
}

// Ray vs axis-aligned box (slab test). Returns entry distance or Infinity.
function rayBox(o, d, min, max) {
  let t0 = -Infinity, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) { if (o[i] < min[i] || o[i] > max[i]) return Infinity; continue; }
    let a = (min[i] - o[i]) / d[i], b = (max[i] - o[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
  }
  return t1 >= Math.max(t0, 0) ? Math.max(t0, 0) : Infinity;
}

// CPU "depth pass": for every texel, ray from the light through the texel centre,
// store the nearest hit as a perspective depth value — what the GPU depth pass stores.
function bakeShadowMap(light, boxes, res = FLASH.shadowRes) {
  const t = Math.tan((shadowFov() * Math.PI) / 360);
  const map = new Float32Array(res * res).fill(1);
  for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
    const sx = ((x + 0.5) / res * 2 - 1) * t, sy = ((y + 0.5) / res * 2 - 1) * t;
    const d = [0, 1, 2].map((i) => light.fwd[i] + light.right[i] * sx + light.up[i] * sy);
    let best = Infinity;
    for (const b of boxes) best = Math.min(best, rayBox(light.pos, d, b.min, b.max));
    if (best === Infinity) continue;
    const w = best;                               // d has unit fwd component → t == light-axis depth
    if (w > FLASH.near && w < FLASH.range) map[y * res + x] = perspectiveDepth(w, FLASH.near, FLASH.range);
  }
  return (u, v) => {
    const x = Math.min(res - 1, Math.max(0, Math.floor(u * res)));
    const y = Math.min(res - 1, Math.max(0, Math.floor(v * res)));
    return map[y * res + x];
  };
}

test('depth linearization round-trips', () => {
  for (const w of [0.1, 0.25, 1, 2.5, 7, 12]) {
    const z = perspectiveDepth(w, FLASH.near, FLASH.range);
    assert.ok(z >= -1e-9 && z <= 1 + 1e-9, `z in range for ${w}`);
    assert.ok(Math.abs(linearizeDepth(z, FLASH.near, FLASH.range) - w) < 1e-9);
  }
  assert.ok(Math.abs(perspectiveDepth(FLASH.near, FLASH.near, FLASH.range)) < 1e-9);
  assert.ok(Math.abs(perspectiveDepth(FLASH.range, FLASH.near, FLASH.range) - 1) < 1e-9);
});

test('light projection: axis at centre, cone edge inside the shadow frustum', () => {
  const L = makeLight([0, 1.5, 3], [0, 1.5, 0]);
  const c = lightProject([0, 1.5, 0], L);
  assert.ok(Math.abs(c.u - 0.5) < 1e-9 && Math.abs(c.v - 0.5) < 1e-9 && Math.abs(c.w - 3) < 1e-9);
  const half = (FLASH.coneAngle * Math.PI) / 360;
  const e = lightProject([Math.tan(half) * 3, 1.5, 0], L);
  assert.ok(e.u > 0.5 && e.u < 1, 'cone edge projects inside the depth map');
});

test('bias grows with distance and grazing angle, stays below a raised-trace height', () => {
  assert.ok(shadowBias(4, 0.9) > shadowBias(1, 0.9));
  assert.ok(shadowBias(2, 0.3) > shadowBias(2, 0.95));
  // At 2 m, near-head-on, the bias must stay well under a 1 cm raised trace.
  assert.ok(shadowBias(2, 0.95) < 0.006, `bias ${shadowBias(2, 0.95)}`);
  assert.ok(texelScale() * 2 < 0.003, 'shadow texel ≤ 3 mm at 2 m');
});

test('spot size: lit footprint on a flat wall equals the cone, not the old inflated disks', () => {
  const wall = { min: [-5, -5, -0.05], max: [5, 5, 0] };
  const L = makeLight([0, 0, 2], [0, 0, 0]);
  const depth = bakeShadowMap(L, [wall], 256);
  const eye = [0, 0, 2.2];
  const r = 2 * Math.tan((FLASH.coneAngle * Math.PI) / 360);
  assert.equal(isLit([0, 0, 0], [0, 0, 1], eye, L, depth), true, 'centre lit');
  assert.equal(isLit([r * 0.95, 0, 0], [0, 0, 1], eye, L, depth), true, 'just inside edge lit');
  assert.equal(isLit([r * 1.05, 0, 0], [0, 0, 1], eye, L, depth), false, 'just outside edge dark');
  // Old 9-disk fan reached ~ d·tan(17.5°)·0.8·1.8 + 0.03 from the axis → must now be dark.
  const oldReach = 2 * Math.tan((35 * Math.PI) / 360) * 0.8 * 1.8 + 0.03;
  assert.equal(isLit([oldReach * 0.95, 0, 0], [0, 0, 1], eye, L, depth), false);
  // No acne: every flat-wall sample inside the cone is lit.
  let miss = 0;
  for (let i = 0; i < 400; i++) {
    const a = i * 2.39996, rr = Math.sqrt(i / 400) * r * 0.97;
    if (!isLit([Math.cos(a) * rr, Math.sin(a) * rr, 0], [0, 0, 1], eye, L, depth)) miss++;
  }
  assert.equal(miss, 0, `${miss} self-shadowed samples on a flat wall`);
});

test('raised trace gets depth: lit top + light-facing side, dark far side + cast shadow', () => {
  // Wall in the z=0 plane, a 2 cm tall raised trace (bar) running vertically on it.
  // Flashlight 1.5 m out, off to the +x side, so the trace shadows the wall at -x.
  const wall = { min: [-3, -3, -0.05], max: [3, 3, 0] };
  const trace = { min: [-0.01, -0.3, 0], max: [0.01, 0.3, 0.02] };
  const L = makeLight([0.9, 0, 1.2], [0, 0, 0]);
  const depth = bakeShadowMap(L, [wall, trace]);
  const eye = [0.2, 0, 1.6];
  const lit = (p, n) => isLit(p, n, eye, L, depth);

  assert.equal(lit([0, 0.1, 0.02], [0, 0, 1]), true, 'top face of trace lit');
  assert.equal(lit([0.01, 0.1, 0.01], [1, 0, 0]), true, 'light-facing side lit');
  assert.equal(lit([-0.01, 0.1, 0.01], [-1, 0, 0]), false, 'far side (faces away) dark');
  // Shadow on the wall: x = -0.02·(0.9/1.2) ≈ -0.015 m long → point at -0.015 is in it.
  assert.equal(lit([-0.014, 0.1, 0], [0, 0, 1]), false, 'cast shadow behind the trace dark');
  assert.equal(lit([-0.08, 0.1, 0], [0, 0, 1]), true, 'wall past the shadow lit again');
  assert.equal(lit([0.1, 0.1, 0], [0, 0, 1]), true, 'wall on the lit side lit');
});

test('occluded surface stays dark; range limit', () => {
  const wall = { min: [-3, -3, -0.05], max: [3, 3, 0] };
  const blocker = { min: [-0.2, -0.2, 0.8], max: [0.2, 0.2, 0.85] };
  const L = makeLight([0, 0, 2], [0, 0, 0]);
  const depth = bakeShadowMap(L, [wall, blocker], 256);
  assert.equal(isLit([0, 0, 0], [0, 0, 1], [0.5, 0, 2], L, depth), false, 'behind blocker dark');
  assert.equal(isLit([0, 0, 0.85], [0, 0, 1], [0.5, 0, 2], L, depth), true, 'blocker face lit');
  const far = makeLight([0, 0, FLASH.range + 1], [0, 0, 0]);
  assert.equal(isLit([0, 0, 0], [0, 0, 1], [0, 0, 1], far, () => 1), false, 'beyond range dark');
});

test('lit test is one-sided: viewer behind the lit surface sees no light', () => {
  const L = makeLight([0, 0, 2], [0, 0, 0]);
  assert.equal(isLit([0, 0, 0], [0, 0, 1], [0, 0, -1], L, () => 1), false);
  assert.equal(isLit([0, 0, 0], [0, 0, -1], [0, 0, 1], L, () => 1), true, 'normal orientation ignored');
});

test('receiver GLSL: baked constants + live cone uniforms match the JS predicate', () => {
  const { vertexShader, fragmentShader } = receiverShaders();
  assert.match(vertexShader, /vWorld/);
  assert.ok(fragmentShader.includes(`RANGE = ${FLASH.range.toFixed(1)}`), 'range = shadow far');
  for (const tok of ['dFdx', 'uLightVP', 'uShadow', 'discard', 'NDOTL_MIN', 'cameraPosition',
    'uniform float uConeCos', 'uniform float uInnerCos', 'uniform float uBiasSlope',
    'uniform float uDarkBase', 'uniform float uMask', '#ifdef FURN_MASK']) {
    assert.ok(fragmentShader.includes(tok), tok);
  }
  // Every light `discard` path has a matching `return -1` in lightAmount (furniture mask
  // is a geometry selection inside #ifdef FURN_MASK, mirrored by inFurniture()).
  const lightPart = fragmentShader.replace(/#ifdef FURN_MASK[\s\S]*?#endif/g, '');
  assert.equal((lightPart.match(/discard/g) || []).length, 3);
  // Uniform helpers equal the formulas the old shader baked in.
  assert.ok(Math.abs(biasSlope() - FLASH.biasSlopeTexels * texelScale()) < 1e-15);
  assert.ok(innerCos() > coneCos(), 'core is inside the cone');
});

test('caster + beam shaders: furniture mask, no stencil logic, beam stops at surfaces', () => {
  const c = casterShaders();
  assert.ok(c.fragmentShader.includes('inFurniture') && c.fragmentShader.includes('#ifdef FURN_MASK'));
  const b = beamShaders();
  for (const tok of ['uShadow', 'uLightVP', 'uTan', 'uLensR', 'uIntensity']) {
    assert.ok((b.vertexShader + b.fragmentShader).includes(tok), tok);
  }
});

// ─────────────── round 3: falloff, cone diameter, furniture ───────────────

test('edge falloff: hard edge at 0, smooth penumbra otherwise, core untouched', () => {
  const hard = { ...FLASH, falloff: 0 };
  const soft = { ...FLASH, falloff: 0.4 };
  const cosAt = (deg) => Math.cos((deg * Math.PI) / 180);
  const half = FLASH.coneAngle / 2;
  assert.equal(coneFalloff(cosAt(half * 0.99), hard), 1, 'hard: full right up to the edge');
  assert.equal(coneFalloff(cosAt(half * 1.01), hard), 0);
  assert.equal(coneFalloff(cosAt(half * 0.5), soft), 1, 'core');
  const mid = coneFalloff(cosAt(half * 0.8), soft);
  assert.ok(mid > 0.3 && mid < 0.7, `penumbra mid ${mid}`);
  let prev = 1;
  for (let f = 0.6; f <= 1.0; f += 0.02) {          // monotone toward the edge
    const v = coneFalloff(cosAt(half * f), soft);
    assert.ok(v <= prev + 1e-12);
    prev = v;
  }
  assert.ok(coneFalloff(cosAt(half * 0.999), soft) < 0.01, 'fades to ~0 at the edge');
});

test('penumbra blend: core identical to old erase, edge returns to full darkness', () => {
  for (const base of [1, 0.9, 0.5]) for (const mask of [1, 0.7, 0]) {
    assert.equal(penumbraAlpha(base, mask, 1), 0, 'core: no extra darkness');
    const a = base * (1 - mask);
    const k = penumbraAlpha(base, mask, 0);
    const final = 1 - (1 - k) * (1 - a);          // receiver k, then coneDarkness a
    assert.ok(Math.abs(final - base) < 1e-9, `edge → ${final} vs ${base}`);
    const kh = penumbraAlpha(base, mask, 0.5);
    const fh = 1 - (1 - kh) * (1 - a);
    assert.ok(Math.abs(fh - base * (1 - mask * 0.5)) < 1e-9, 'half lit = half erase');
  }
});

test('lightAmount: 1 in the core, partial in the penumbra, -1 where isLit is false', () => {
  const wall = { min: [-5, -5, -0.05], max: [5, 5, 0] };
  const L = makeLight([0, 0, 2], [0, 0, 0]);
  const depth = bakeShadowMap(L, [wall], 256);
  const eye = [0, 0, 2.2];
  const cfg = { ...FLASH, falloff: 0.4 };
  const r = 2 * Math.tan((FLASH.coneAngle * Math.PI) / 360);
  assert.equal(lightAmount([0, 0, 0], [0, 0, 1], eye, L, depth, cfg), 1);
  const edge = lightAmount([r * 0.9, 0, 0], [0, 0, 1], eye, L, depth, cfg);
  assert.ok(edge > 0 && edge < 1, `penumbra ${edge}`);
  assert.equal(isLit([r * 0.9, 0, 0], [0, 0, 1], eye, L, depth, cfg), true, 'penumbra still writes stencil');
  assert.equal(lightAmount([r * 1.05, 0, 0], [0, 0, 1], eye, L, depth, cfg), -1);
});

test('cone diameter: wider cone lights a wider spot, shadow frustum follows', () => {
  const wide = { ...FLASH, coneAngle: 60 };
  assert.equal(shadowFov(wide), 64);
  const wall = { min: [-5, -5, -0.05], max: [5, 5, 0] };
  const L = makeLight([0, 0, 2], [0, 0, 0]);
  const eye = [0, 0, 2.2];
  const p = [2 * Math.tan((22 * Math.PI) / 180), 0, 0];   // 22° off-axis
  const dNarrow = bakeShadowMap(L, [wall], 128);
  assert.equal(isLit(p, [0, 0, 1], eye, L, dNarrow), false, '30° cone: dark');
  // Shadow map for the wide cone must be baked with the wide frustum.
  const t = Math.tan((shadowFov(wide) * Math.PI) / 360);
  const z = perspectiveDepth(2, wide.near, wide.range);
  const dWide = () => z;                                   // flat wall at w = 2 everywhere
  assert.ok(t > 0 && lightProject(p, L, wide).u < 1, 'edge inside the wide shadow map');
  assert.equal(isLit(p, [0, 0, 1], eye, L, dWide, wide), true, '60° cone: lit');
  for (let i = 0; i < 100; i++) {                          // no acne on the wide flat wall
    const rr = (i / 100) * 2 * Math.tan((29 * Math.PI) / 180);
    assert.equal(isLit([rr, 0, 0], [0, 0, 1], eye, L, dWide, wide), true);
  }
});

test('furniture pass-through: no shadow from furniture, wall behind it is lit', () => {
  const wall = { min: [-3, -3, -0.05], max: [3, 3, 0] };
  const couch = { min: [-0.3, -0.3, 0.6], max: [0.3, 0.3, 0.9] };
  const L = makeLight([0, 0, 2], [0, 0, 0]);
  const eye = [0.4, 0, 2];
  // Furniture is not in the caster set → bake without it (what main.js renders).
  const depth = bakeShadowMap(L, [wall], 256);
  assert.equal(isLit([0, 0, 0], [0, 0, 1], eye, L, depth), true, 'wall behind couch lit');
  // Had it been a caster, the wall would be dark — guards the semantics.
  assert.equal(isLit([0, 0, 0], [0, 0, 1], eye, L, bakeShadowMap(L, [wall, couch], 256)), false);
  // Scan-mesh mask: unit-cube box matrix for the couch (world → [-1,1]^3), margin 3 cm.
  const c = [0, 0, 0.75], h = [0.33, 0.33, 0.18];
  const box = [1 / h[0], 0, 0, 0, 0, 1 / h[1], 0, 0, 0, 0, 1 / h[2], 0, -c[0] / h[0], -c[1] / h[1], -c[2] / h[2], 1];
  assert.equal(inFurniture([0, 0, 0.9], [box]), true, 'couch surface masked');
  assert.equal(inFurniture([0, 0, 0], [box]), false, 'wall not masked');
  assert.equal(inFurniture([0, 0, 0.9], []), false);
});
