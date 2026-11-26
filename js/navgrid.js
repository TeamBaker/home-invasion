// Occupancy grid + flow field for monster navigation. Pure JS (no three.js, no DOM)
// so it can be tested under node.
//
// All coordinates are on the XZ plane of "room space" (the WebXR reference space).
//
//   raw[]   0 = walkable floor, 1 = obstacle (wall / furniture / mesh), 2 = outside the floor
//   block[] raw obstacles inflated by the monster's radius → where its *centre* may not go
//   dist[]  BFS steps from the target (player) cell, -1 = unreachable

const FREE = 0, OBSTACLE = 1, OUTSIDE = 2;

function pointInPoly(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function polyArea(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j].x + pts[i].x) * (pts[j].z - pts[i].z);
  return Math.abs(s) / 2;
}

// 8-neighbourhood: [dx, dz]
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export class NavGrid {
  constructor(opts = {}) {
    this.cell = 0.15;       // metres per cell
    this.radius = 0.25;     // monster body radius (obstacle inflation)
    this.maxSize = 30;      // metres; grids larger than this are cropped around the player
    this.margin = 1.0;      // metres of padding around the detected geometry
    Object.assign(this, opts);
    this.ok = false;
    this.version = 0;
    this.path = [];         // last planned path (array of {x,z}) — for debug drawing
    this.targetCell = -1;
    this.targetVersion = -1;
    this.targetIsPlayer = false;
    this.lastTargetCell = -1;
    this.lastTargetX = 0;
    this.lastTargetZ = 0;
  }

  /**
   * @param room {floors:[{pts:[{x,z}]}], walls:[[x0,z0,x1,z1]], solids:[{pts:[{x,z}]}], points?:Float32Array(x,z,...),
   *              open?:[{pts:[{x,z}]}]}  open = doorway footprints: walkable floor, nothing rasterizes inside them
   * @param focus {x,z} a point that must be inside the grid (the player)
   */
  build(room, focus = { x: 0, z: 0 }) {
    const { floors = [], walls = [], solids = [], points = null, open = [] } = room;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const grow = (x, z) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    };
    for (const f of floors) for (const p of f.pts) grow(p.x, p.z);
    for (const s of solids) for (const p of s.pts) grow(p.x, p.z);
    for (const w of walls) { grow(w[0], w[1]); grow(w[2], w[3]); }
    for (const o of open) for (const p of o.pts) grow(p.x, p.z);
    if (points) for (let i = 0; i < points.length; i += 2) grow(points[i], points[i + 1]);

    if (minX === Infinity) { this.ok = false; return false; }   // no room data at all
    grow(focus.x, focus.z);
    minX -= this.margin; minZ -= this.margin; maxX += this.margin; maxZ += this.margin;
    const half = this.maxSize / 2;
    minX = Math.max(minX, focus.x - half); maxX = Math.min(maxX, focus.x + half);
    minZ = Math.max(minZ, focus.z - half); maxZ = Math.min(maxZ, focus.z + half);

    const c = this.cell;
    this.minX = minX; this.minZ = minZ;
    this.w = Math.max(1, Math.ceil((maxX - minX) / c));
    this.h = Math.max(1, Math.ceil((maxZ - minZ) / c));
    const n = this.w * this.h;
    const raw = this.raw = new Uint8Array(n);

    // Floor: Meta's floor polygon is authoritative — any detected floor makes everything
    // outside it off-limits (no invented minimum-area threshold).
    const floorArea = floors.reduce((s, f) => s + polyArea(f.pts), 0);
    this.outsideBlocked = floorArea > 0;
    if (this.outsideBlocked) {
      raw.fill(OUTSIDE);
      for (const f of floors) this._fillPoly(f.pts, FREE);
    }
    for (const s of solids) { this._fillPoly(s.pts, OBSTACLE); this._strokePoly(s.pts); }
    for (const w of walls) this._stroke(w[0], w[1], w[2], w[3]);
    if (points) for (let i = 0; i < points.length; i += 2) {
      const k = this.cellOf(points[i], points[i + 1]);
      if (k >= 0) raw[k] = OBSTACLE;
    }
    // Doorways last: the floor polygons of the two rooms stop at their walls (the doorway
    // threshold is outside both), and furniture planes / jamb strokes reach into it.
    for (const o of open) this._fillPoly(o.pts, FREE, true);

    // Inflate by the monster's radius.
    const block = this.block = new Uint8Array(n);
    const r = Math.ceil(this.radius / c);
    const offs = [];
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if ((dx * dx + dz * dz) * c * c <= this.radius * this.radius) offs.push(dx, dz);
    }
    for (let z = 0; z < this.h; z++) for (let x = 0; x < this.w; x++) {
      if (raw[z * this.w + x] === FREE) continue;
      for (let i = 0; i < offs.length; i += 2) {
        const xx = x + offs[i], zz = z + offs[i + 1];
        if (xx >= 0 && zz >= 0 && xx < this.w && zz < this.h) block[zz * this.w + xx] = 1;
      }
    }

    this.dist = new Int32Array(n).fill(-1);
    this.queue = new Int32Array(n);
    this.targetCell = -1;
    this.ok = true;
    this.version++;
    return true;
  }

  // ── rasterizers ──
  _fillPoly(pts, value, force = false) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    const c = this.cell;
    const cx0 = Math.max(0, Math.floor((x0 - this.minX) / c)), cx1 = Math.min(this.w - 1, Math.floor((x1 - this.minX) / c));
    const cz0 = Math.max(0, Math.floor((z0 - this.minZ) / c)), cz1 = Math.min(this.h - 1, Math.floor((z1 - this.minZ) / c));
    for (let z = cz0; z <= cz1; z++) for (let x = cx0; x <= cx1; x++) {
      const k = z * this.w + x;
      if (value === FREE && !force && this.raw[k] === OBSTACLE) continue;
      if (pointInPoly(this.minX + (x + 0.5) * c, this.minZ + (z + 0.5) * c, pts)) this.raw[k] = value;
    }
  }
  _stroke(ax, az, bx, bz) {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (this.cell * 0.5)));
    for (let i = 0; i <= steps; i++) {
      const k = this.cellOf(ax + (bx - ax) * i / steps, az + (bz - az) * i / steps);
      if (k >= 0) this.raw[k] = OBSTACLE;
    }
  }
  _strokePoly(pts) {
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) this._stroke(pts[j].x, pts[j].z, pts[i].x, pts[i].z);
  }

  // ── cell helpers ──
  cellOf(x, z) {
    const cx = Math.floor((x - this.minX) / this.cell), cz = Math.floor((z - this.minZ) / this.cell);
    return cx < 0 || cz < 0 || cx >= this.w || cz >= this.h ? -1 : cz * this.w + cx;
  }
  centerX(k) { return this.minX + ((k % this.w) + 0.5) * this.cell; }
  centerZ(k) { return this.minZ + (Math.floor(k / this.w) + 0.5) * this.cell; }

  /** Can the monster's centre be here? raw=true ignores inflation (only real obstacles). */
  passable(x, z, raw = false) {
    if (!this.ok) return true;
    const k = this.cellOf(x, z);
    if (k < 0) return !this.outsideBlocked;
    return raw ? this.raw[k] === FREE : this.block[k] === 0;
  }

  /** Straight line a→b stays passable. Samples within `skipEnd` metres of b are ignored. */
  lineFree(ax, az, bx, bz, raw = false, skipEnd = 0) {
    if (!this.ok) return true;
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(len / (this.cell * 0.5));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if ((1 - t) * len < skipEnd) break;
      if (!this.passable(ax + (bx - ax) * t, az + (bz - az) * t, raw)) return false;
    }
    return true;
  }

  /** Closest non-blocked cell within maxR metres, or -1. */
  nearestFreeCell(x, z, maxR = 2) {
    if (!this.ok) return -1;
    const c = this.cell, r = Math.ceil(maxR / c);
    const cx = Math.floor((x - this.minX) / c), cz = Math.floor((z - this.minZ) / c);
    let best = -1, bestD = Infinity;
    for (let zz = Math.max(0, cz - r); zz <= Math.min(this.h - 1, cz + r); zz++) {
      for (let xx = Math.max(0, cx - r); xx <= Math.min(this.w - 1, cx + r); xx++) {
        const k = zz * this.w + xx;
        if (this.block[k]) continue;
        const d = (this.centerX(k) - x) ** 2 + (this.centerZ(k) - z) ** 2;
        if (d < bestD && d <= maxR * maxR) { bestD = d; best = k; }
      }
    }
    return best;
  }

  // ── flow field ──
  /** BFS outward from the target (player). Cheap to call every frame: only recomputes on change. */
  setTarget(x, z) {
    if (!this.ok) return;
    let k = this.cellOf(x, z);
    let isPlayer = false;
    if (k >= 0 && !this.block[k]) {
      isPlayer = true;
    } else {
      k = this.nearestFreeCell(x, z, 1.5);
      if (k < 0 && this.lastTargetCell >= 0) {
        // Player is in unmapped space: keep chasing the last known target (by position,
        // since cell indices change when the grid rebuilds). Drop it if now blocked.
        const lk = this.cellOf(this.lastTargetX, this.lastTargetZ);
        if (lk >= 0 && !this.block[lk]) k = lk;
        else this.lastTargetCell = -1;
      }
    }
    if (k >= 0) {
      this.lastTargetCell = k;
      this.lastTargetX = this.centerX(k);
      this.lastTargetZ = this.centerZ(k);
    }
    if (k === this.targetCell && this.targetVersion === this.version && isPlayer === this.targetIsPlayer) return;
    this.targetIsPlayer = isPlayer;
    this.targetCell = k;
    this.targetVersion = this.version;
    const { dist, queue, block, w, h } = this;
    dist.fill(-1);
    if (k < 0) return;
    let head = 0, tail = 0;
    dist[k] = 0; queue[tail++] = k;
    while (head < tail) {
      const cur = queue[head++];
      const x0 = cur % w, z0 = (cur - x0) / w, d = dist[cur] + 1;
      for (const [dx, dz] of NB) {
        const xx = x0 + dx, zz = z0 + dz;
        if (xx < 0 || zz < 0 || xx >= w || zz >= h) continue;
        const nk = zz * w + xx;
        if (block[nk] || dist[nk] >= 0) continue;
        if (dx && dz && (block[z0 * w + xx] || block[zz * w + x0])) continue;  // no corner cutting
        dist[nk] = d; queue[tail++] = nk;
      }
    }
  }

  /** Approximate walking distance (m) from here to the target, Infinity if unreachable.
   *  A point inside the body-radius margin (wall corners, floor-polygon corners) is
   *  measured from the nearest cell the monster's centre can occupy within that radius. */
  pathLength(x, z) {
    if (!this.ok) return Math.hypot(x, z);
    let k = this.cellOf(x, z);
    if (k < 0) return Infinity;
    if (this.block[k]) {
      const f = this.nearestFreeCell(x, z, this.radius + this.cell);
      if (f < 0 || this.dist[f] < 0) return Infinity;
      return this.dist[f] * this.cell + Math.hypot(this.centerX(f) - x, this.centerZ(f) - z);
    }
    return this.dist[k] < 0 ? Infinity : this.dist[k] * this.cell;
  }

  /**
   * Where should a monster at (mx,mz) head next to reach the target at (tx,tz)?
   * Returns {x, z, mode}:
   *   'direct'  — clear line to the target, go straight
   *   'path'    — farthest visible point along the flow-field path
   *   'escape'  — monster is inside an obstacle's margin, get out first
   *   'blocked' — no route exists; head straight and let collision slide it
   */
  steer(mx, mz, tx, tz, out = {}) {
    this.path.length = 0;
    const set = (x, z, mode) => { out.x = x; out.z = z; out.mode = mode; return out; };
    if (!this.ok) return set(tx, tz, 'direct');
    const mk = this.cellOf(mx, mz);
    if (mk >= 0 && this.block[mk]) {
      const f = this.nearestFreeCell(mx, mz, 3);
      if (f >= 0) return set(this.centerX(f), this.centerZ(f), 'escape');
    }
    if (this.lineFree(mx, mz, tx, tz, false, this.radius + this.cell)) {
      this.path.push({ x: mx, z: mz }, { x: tx, z: tz });
      return set(tx, tz, 'direct');
    }
    if (mk < 0 || this.dist[mk] < 0) return set(tx, tz, 'blocked');

    // Follow the gradient down to the target, then string-pull to the farthest visible point.
    const { w, h, dist, block } = this;
    const cells = [mk];
    let cur = mk;
    for (let i = 0; i < 120 && dist[cur] > 0; i++) {
      const x0 = cur % w, z0 = (cur - x0) / w;
      let best = -1, bestD = dist[cur], bestE = Infinity;
      for (const [dx, dz] of NB) {
        const xx = x0 + dx, zz = z0 + dz;
        if (xx < 0 || zz < 0 || xx >= w || zz >= h) continue;
        const nk = zz * w + xx;
        if (block[nk] || dist[nk] < 0) continue;
        if (dx && dz && (block[z0 * w + xx] || block[zz * w + x0])) continue;
        const e = (this.centerX(nk) - tx) ** 2 + (this.centerZ(nk) - tz) ** 2;  // tie-break toward target
        if (dist[nk] < bestD || (dist[nk] === bestD && best >= 0 && e < bestE)) { best = nk; bestD = dist[nk]; bestE = e; }
      }
      if (best < 0) break;
      cells.push(best); cur = best;
    }
    for (const k of cells) this.path.push({ x: this.centerX(k), z: this.centerZ(k) });
    this.path[0] = { x: mx, z: mz };
    if (dist[cur] === 0) this.path.push({ x: tx, z: tz });

    for (let i = this.path.length - 1; i > 0; i--) {
      const p = this.path[i];
      const isTarget = i === this.path.length - 1 && dist[cur] === 0;
      if (this.lineFree(mx, mz, p.x, p.z, false, isTarget ? this.radius + this.cell : 0)) {
        return set(p.x, p.z, 'path');
      }
    }
    const p = this.path[Math.min(1, this.path.length - 1)];
    return set(p.x, p.z, 'path');
  }

  /** Move with axis-separated sliding collision. Returns [x, z]. */
  move(x, z, dx, dz, raw = false) {
    if (!this.ok) return [x + dx, z + dz];
    if (this.passable(x + dx, z + dz, raw)) return [x + dx, z + dz];
    if (dx && this.passable(x + dx, z, raw)) return [x + dx, z];
    if (dz && this.passable(x, z + dz, raw)) return [x, z + dz];
    return [x, z];
  }

  /**
   * Pick a reachable spawn point around `desired` metres from the player, preferring
   * directions opposite (fx,fz) — i.e. behind them. Call setTarget(player) first.
   */
  pickSpawn(px, pz, fx, fz, desired, minD = 1.8) {
    if (!this.ok || this.targetCell < 0) return null;
    let best = -1, bestS = -Infinity, far = -1, farD = 0;
    for (let k = 0; k < this.dist.length; k++) {
      if (this.dist[k] < 0) continue;
      const x = this.centerX(k) - px, z = this.centerZ(k) - pz;
      const d = Math.hypot(x, z);
      if (d > farD) { farD = d; far = k; }
      if (d < minD) continue;
      const behind = -(x * fx + z * fz) / d;     // 1 = directly behind
      const s = behind * 2 - Math.abs(d - desired) * 0.5 + Math.random() * 0.4;
      if (s > bestS) { bestS = s; best = k; }
    }
    const k = best >= 0 ? best : far;
    return k >= 0 ? { x: this.centerX(k), z: this.centerZ(k) } : null;
  }

  /**
   * Cell counts for diagnostics:
   *   obstacle  — cells occupied by a wall / furniture / mesh point
   *   blocked   — cells the monster's centre may not enter (obstacles inflated + outside the floor)
   *   walkable  — cells it may enter
   *   reachable — walkable cells connected to the current target (needs setTarget)
   */
  counts() {
    if (!this.ok) return { obstacle: 0, blocked: 0, walkable: 0, reachable: 0, total: 0 };
    let obstacle = 0, blocked = 0, reachable = 0;
    const n = this.raw.length;
    for (let k = 0; k < n; k++) {
      if (this.raw[k] === OBSTACLE) obstacle++;
      if (this.block[k]) blocked++;
      if (this.dist[k] >= 0) reachable++;
    }
    return { obstacle, blocked, walkable: n - blocked, reachable, total: n };
  }

  /** Cell indices of raw obstacles — for debug drawing. */
  obstacleCells() {
    const out = [];
    if (this.ok) for (let k = 0; k < this.raw.length; k++) if (this.raw[k] === OBSTACLE) out.push(k);
    return out;
  }
}
