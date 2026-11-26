// Room model: WebXR frame → plane/mesh records → classification → NavGrid.
// Pure JS (no three.js, no DOM) so the exact code that runs on the headset is
// exercised by `node --test test/`.
//
// Real WebXR API used (Plane Detection + Mesh Detection modules, Quest Browser):
//   frame.detectedPlanes : XRPlaneSet (Set-like) of XRPlane
//     plane.planeSpace      XRSpace — +Y of this space is the plane normal
//     plane.polygon         DOMPointReadOnly[] in planeSpace (y ≈ 0)
//     plane.orientation     'horizontal' | 'vertical' (may be undefined)
//     plane.semanticLabel   'floor' | 'wall' | 'ceiling' | 'table' | 'couch' | ...
//     plane.lastChangedTime DOMHighResTimeStamp
//   frame.detectedMeshes : XRMeshSet of XRMesh {meshSpace, vertices, indices, semanticLabel, lastChangedTime}
//   frame.getPose(space, refSpace).transform.matrix : Float32Array(16), column-major
//
// Everything here lives in *room space* = the XR reference space.

import { NavGrid } from './navgrid.js';

export const BAND_LO = 0.12;   // horizontal surfaces lower than this above the floor are stepped over (rugs)
export const BAND_HI = 1.6;    // vertical planes must reach below this to block
export const MESH_LO = 0.45;   // scene mesh counts as an obstacle only between knee...
export const MESH_HI = 1.8;    // ...and head height
export const CEILING_MIN = 2.0;
const PASSABLE_VERTICAL = new Set(['window', 'window frame', 'wall art']);
const FURNITURE_MESH_SKIP = new Set(['floor', 'ceiling', 'wall', 'window frame', 'window', 'wall art']);
export const REBUILD_INTERVAL = 0.5;   // s — at most this often while the scan keeps changing

// ───────────── frame access (guarded) ─────────────

/** Plane set from a frame. active=false means the plane module isn't available in this session. */
export function framePlanes(frame) {
  try {
    if ('detectedPlanes' in frame) {
      const set = frame.detectedPlanes;
      if (set && typeof set[Symbol.iterator] === 'function') return { active: true, set };
      return { active: false, set: null, why: 'frame.detectedPlanes is ' + set };
    }
    if (typeof frame.getPlaneDetectionResults === 'function') {   // non-standard spelling, just in case
      const set = frame.getPlaneDetectionResults();
      if (set && typeof set[Symbol.iterator] === 'function') return { active: true, set };
      return { active: false, set: null, why: 'getPlaneDetectionResults() returned ' + set };
    }
    return { active: false, set: null, why: 'no plane API on XRFrame' };
  } catch (e) {
    return { active: false, set: null, why: 'plane API threw: ' + (e && e.message) };
  }
}

export function frameMeshes(frame) {
  if ('detectedMeshes' in frame) {
    const set = frame.detectedMeshes;   // may throw — caller catches
    return set && typeof set[Symbol.iterator] === 'function' ? set : null;
  }
  if (typeof frame.getMeshDetectionResults === 'function') return frame.getMeshDetectionResults() || null;
  return null;
}

const planeLabel = (p) => String(p.semanticLabel ?? p.planeSemanticLabel ?? '').toLowerCase();
const planeSpace = (p) => p.planeSpace ?? (typeof p.orientation === 'object' ? p.orientation : null);

// ───────────── math helpers (column-major 4×4) ─────────────
export function xform(m, x, y, z) {
  return {
    x: m[0] * x + m[4] * y + m[8] * z + m[12],
    y: m[1] * x + m[5] * y + m[9] * z + m[13],
    z: m[2] * x + m[6] * y + m[10] * z + m[14],
  };
}

function polyArea(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j].x + pts[i].x) * (pts[j].z - pts[i].z);
  return Math.abs(s) / 2;
}

export function pointInPolyXZ(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Plane record from a local polygon + pose matrix. `pts` are room-space points.
 * Orientation: WebXR's string if given, else from the normal (planeSpace +Y):
 *   n.y > 0.7 → 'horizontal' (floor / tabletop), n.y < -0.7 → 'horizontal' + down-facing (ceiling), else 'vertical'.
 */
export function makePlaneRecord(orientation, label, polygon, matrix) {
  const m = Array.from(matrix);
  const ny = m[5];                         // y component of local +Y (the normal)
  const facing = ny > 0.7 ? 'up' : ny < -0.7 ? 'down' : 'side';
  if (orientation !== 'horizontal' && orientation !== 'vertical') orientation = facing === 'side' ? 'vertical' : 'horizontal';
  const poly = polygon.map((p) => ({ x: p.x, y: p.y || 0, z: p.z }));
  const pts = poly.map((p) => xform(m, p.x, p.y, p.z));
  return { orientation, facing, label: (label || '').toLowerCase(), polygon: poly, matrix: m, pts, y: m[13], kind: 'ignore' };
}

/**
 * Classify plane records in place (rec.kind = floor | wall | solid | ignore).
 * Returns the nav-grid input plus counts.
 */
export function classifyPlanes(recs) {
  const horiz = recs.filter((r) => r.orientation === 'horizontal');
  const isCeil = (r) => r.label === 'ceiling' || (!r.label && r.facing === 'down');

  // Floor: labelled floor planes, else the lowest big up-facing horizontal plane near y=0.
  let floors = horiz.filter((r) => r.label === 'floor');
  if (!floors.length) {
    const big = horiz.filter((r) => !isCeil(r) && !r.label && polyArea(r.pts) > 1).sort((a, b) => a.y - b.y);
    if (big.length && big[0].y < 0.3) floors = big.filter((r) => Math.abs(r.y - big[0].y) < 0.12);
  }
  const floorY = floors.length ? floors.reduce((s, r) => s + r.y, 0) / floors.length : 0;

  const walls = [], solids = [];
  for (const r of recs) {
    if (floors.includes(r)) r.kind = 'floor';
    else if (r.orientation === 'horizontal') {
      const h = r.y - floorY;
      r.kind = !isCeil(r) && r.label !== 'floor' && h > BAND_LO && h < CEILING_MIN ? 'solid' : 'ignore';
    } else {
      let lo = Infinity, hi = -Infinity;
      for (const p of r.pts) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
      r.kind = !PASSABLE_VERTICAL.has(r.label) && lo < floorY + BAND_HI && hi > floorY + BAND_LO ? 'wall' : 'ignore';
    }
    if (r.kind === 'solid') solids.push({ pts: r.pts });
    if (r.kind === 'wall') for (let i = 0, j = r.pts.length - 1; i < r.pts.length; j = i++) {
      walls.push([r.pts[j].x, r.pts[j].z, r.pts[i].x, r.pts[i].z]);
    }
  }
  const count = (k) => recs.filter((r) => r.kind === k).length;
  return {
    floorY,
    floors: floors.map((r) => ({ pts: r.pts, y: r.y })),
    walls, solids,
    counts: { total: recs.length, floor: count('floor'), wall: count('wall'), furniture: count('solid'), ignored: count('ignore') },
  };
}

/** Sample mesh triangles at ~cell spacing; keep XZ of points between knee and head height. */
export function sampleMesh(m, floorY, cell) {
  const out = [];
  const v = m.vertices, idx = m.indices, e = m.matrix;
  if (!v || !idx) return out;
  const lo = floorY + MESH_LO, hi = floorY + MESH_HI;
  const P = (i) => {
    const p = xform(e, v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
    return [p.x, p.y, p.z];
  };
  const step = cell * 0.7;
  for (let t = 0; t + 2 < idx.length && out.length < 400000; t += 3) {
    const a = P(idx[t]), b = P(idx[t + 1]), c = P(idx[t + 2]);
    if (Math.max(a[1], b[1], c[1]) < lo || Math.min(a[1], b[1], c[1]) > hi) continue;
    const len = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]));
    const n = Math.min(40, Math.max(1, Math.ceil(len / step)));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, w = j / n, k = 1 - u - w;
      const y = a[1] * k + b[1] * u + c[1] * w;
      if (y < lo || y > hi) continue;
      out.push(a[0] * k + b[0] * u + c[0] * w, a[2] * k + b[2] * u + c[2] * w);
    }
  }
  return out;
}

const moved = (a, m) => Math.abs(a[12] - m[12]) + Math.abs(a[13] - m[13]) + Math.abs(a[14] - m[14]) > 0.02;

// ───────────── the model ─────────────
export class RoomModel {
  /** hooks: { planeAdded(rec), planeRemoved(rec) } — for visualization. */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.nav = new NavGrid({ cell: 0.15, radius: 0.25 });
    this.planes = new Map();   // XRPlane → record
    this.meshes = new Map();   // XRMesh → record
    this.reset();
  }

  reset() {
    for (const r of this.planes.values()) this.hooks.planeRemoved?.(r);
    this.planes.clear();
    this.meshes.clear();
    this.nav.ok = false;
    this.floorY = 0;
    this.floors = [];
    this.dirty = false;
    this.sinceBuild = REBUILD_INTERVAL;    // first scan builds immediately
    this.counts = { total: 0, floor: 0, wall: 0, furniture: 0, ignored: 0 };
    // Diagnostics — straight from frame data, never inferred.
    this.diag = {
      framesRead: 0,
      planeModuleActive: false,
      planeWhy: 'no XR frame yet',
      planesInFrame: 0,          // size of the XRPlaneSet on the last frame
      meshModuleActive: false,
      meshDisabled: false,       // set if the mesh API errored → planes only
      meshError: '',
      meshesInFrame: 0,
      poseMisses: 0,             // planes whose getPose() returned null on the last frame
      builds: 0,
    };
  }

  get hasData() { return this.planes.size > 0 || this.meshes.size > 0; }
  /** The only condition under which the UI may claim it knows the room. */
  get knowsRoom() { return this.diag.planeModuleActive && this.planes.size > 0; }

  /** Ingest one XRFrame. Call every XR frame. */
  ingest(frame, refSpace) {
    const d = this.diag;
    d.framesRead++;

    const { active, set, why } = framePlanes(frame);
    d.planeModuleActive = active;
    d.planeWhy = active ? '' : why;
    d.planesInFrame = set ? set.size ?? [...set].length : 0;
    d.poseMisses = 0;
    if (set) {
      for (const [key, rec] of this.planes) if (!set.has(key)) {
        this.hooks.planeRemoved?.(rec); this.planes.delete(key); this.dirty = true;
      }
      for (const plane of set) {
        const space = planeSpace(plane);
        const pose = space && frame.getPose(space, refSpace);
        if (!pose) { d.poseMisses++; continue; }
        const m = pose.transform.matrix;
        let rec = this.planes.get(plane);
        if (!rec || rec.changed !== plane.lastChangedTime || moved(rec.matrix, m)) {
          if (rec) this.hooks.planeRemoved?.(rec);
          rec = makePlaneRecord(typeof plane.orientation === 'string' ? plane.orientation : undefined,
            planeLabel(plane), plane.polygon, m);
          rec.changed = plane.lastChangedTime;
          this.planes.set(plane, rec);
          this.hooks.planeAdded?.(rec);
          this.dirty = true;
        }
      }
    }

    if (!d.meshDisabled) {
      try {
        const meshes = frameMeshes(frame);
        d.meshModuleActive = !!meshes;
        d.meshesInFrame = meshes ? meshes.size ?? [...meshes].length : 0;
        if (meshes) {
          for (const key of this.meshes.keys()) if (!meshes.has(key)) { this.meshes.delete(key); this.dirty = true; }
          for (const mesh of meshes) {
            const rec = this.meshes.get(mesh);
            if (rec && rec.changed === mesh.lastChangedTime) continue;
            const pose = frame.getPose(mesh.meshSpace, refSpace);
            if (!pose) continue;
            this.meshes.set(mesh, {
              changed: mesh.lastChangedTime,
              label: String(mesh.semanticLabel || '').toLowerCase(),
              matrix: Array.from(pose.transform.matrix),
              vertices: mesh.vertices,
              indices: mesh.indices,
              points: null,
            });
            this.dirty = true;
          }
        }
      } catch (e) {
        // Mesh API misbehaved at runtime → drop meshes, carry on with planes alone.
        d.meshDisabled = true;
        d.meshModuleActive = false;
        d.meshError = String(e && e.message || e);
        if (this.meshes.size) { this.meshes.clear(); this.dirty = true; }
      }
    }
  }

  /** Call every frame. Rebuilds the nav grid (throttled) when the scan changed. */
  update(dt, player) {
    this.sinceBuild += dt;
    if (this.dirty && this.sinceBuild >= REBUILD_INTERVAL) this.rebuild(player);
  }

  rebuild(player = { x: 0, z: 0 }) {
    this.dirty = false;
    this.sinceBuild = 0;
    this.diag.builds++;
    const recs = [...this.planes.values()];
    const c = classifyPlanes(recs);
    this.floorY = c.floorY;
    this.floors = c.floors;
    this.counts = c.counts;

    const pts = [];
    for (const m of this.meshes.values()) {
      if (FURNITURE_MESH_SKIP.has(m.label)) continue;
      if (!m.points || m.floorY !== c.floorY) { m.points = sampleMesh(m, c.floorY, this.nav.cell); m.floorY = c.floorY; }
      for (let i = 0; i < m.points.length; i++) pts.push(m.points[i]);
    }
    this.nav.build({ floors: c.floors, walls: c.walls, solids: c.solids, points: pts.length ? Float32Array.from(pts) : null }, player);
    this.hooks.rebuilt?.(recs);
  }

  floorAt(x, z) {
    for (const f of this.floors) if (pointInPolyXZ(x, z, f.pts)) return f.y;
    return this.floorY;
  }
}
