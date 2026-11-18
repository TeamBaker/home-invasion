// Room sensing, three.js side: wraps RoomModel (pure pipeline in roommodel.js) and
// draws a faint debug overlay of "what the monster sees".
//
// Everything here lives in *room space* = the XR reference space = the dolly's local
// space. `group` is parented to the dolly so the overlay lines up with passthrough.

import * as THREE from 'three';
import { RoomModel } from './roommodel.js';
import { makeSimFrame } from './simroom.js';

const COLORS = { floor: 0x7a1010, wall: 0x9a9aa0, solid: 0xff7a00, cells: 0xff1a1a, path: 0xffe066 };

function gridTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 2;
  g.strokeRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 4);  // ShapeGeometry UVs are in metres → one grid square per 25 cm
  return t;
}

// Writes depth only: invisible itself, hides whatever is behind it. Pushed back slightly
// so overlay lines / feet touching a surface don't z-fight with it.
const OCCLUDER_MAT = new THREE.MeshBasicMaterial({
  colorWrite: false, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4,
});

export class RoomSense {
  constructor(parent) {
    this.group = new THREE.Group();
    parent.add(this.group);
    this.source = 'none';      // 'xr' | 'sim' | 'none'
    this.sim = null;
    // Overlay OFF by default on the headset: its grid-textured walls look exactly like Quest's
    // own boundary and read as a second, game-made one. X / G toggles it. (?simroom turns it on.)
    this.debug = false;
    this.tex = gridTexture();
    this.model = new RoomModel({
      planeAdded: (r) => this._buildViz(r),
      planeRemoved: (r) => this._disposeViz(r),
      rebuilt: (recs) => { for (const r of recs) this._styleViz(r); this._updateCells(); this._updateOccluders(); },
    });

    // Debug: obstacle cells as flat red tiles, and the monster's planned path.
    this.cellsMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: COLORS.cells, transparent: true, opacity: 0.22, depthWrite: false }),
      20000,
    );
    this.cellsMesh.count = 0;
    this.cellsMesh.frustumCulled = false;
    this.group.add(this.cellsMesh);
    this.pathGeo = new THREE.BufferGeometry();
    this.pathGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(128 * 3), 3));
    this.pathLine = new THREE.Line(this.pathGeo, new THREE.LineBasicMaterial({ color: COLORS.path, transparent: true, opacity: 0.7 }));
    this.pathLine.frustumCulled = false;
    this.group.add(this.pathLine);
    
    // Depth-only occluders (real geometry as a depth mask) — see _updateOccluders.
    this.occluderGroup = new THREE.Group();
    this.group.add(this.occluderGroup);
    // Light-only occluders: classified planes (walls + furniture tops) — the
    // dynamic room mesh. The flashlight casts against ONLY these when
    // SHINE THRU FURNITURE is on; scene-mesh cubes are ignored entirely.
    this.lightOccGroup = new THREE.Group();
    this.group.add(this.lightOccGroup);
    this.meshOcc = new Map();   // mesh record → occluder
    
    this.setDebug(this.debug);
  }

  get nav() { return this.model.nav; }
  get floorY() { return this.model.floorY; }
  get hasData() { return this.model.hasData; }
  get knowsRoom() { return this.model.knowsRoom; }
  get diag() { return this.model.diag; }
  get counts() { return this.model.counts; }
  floorAt(x, z) { return this.model.floorAt(x, z); }

  setDebug(on) {
    this.debug = on;
    this.cellsMesh.visible = this.pathLine.visible = on;
    for (const r of this.model.planes.values()) this._styleViz(r);
  }

  reset() {
    this.model.reset();
    this.cellsMesh.count = 0;
    this.pathGeo.setDrawRange(0, 0);
    this.source = 'none';
    this.sim = null;
    for (const m of [...this.occluderGroup.children]) this._dropOcc(m);
    for (const m of [...this.lightOccGroup.children]) this._dropLightOcc(m);
    this.meshOcc.clear();
  }

  /** Real headset: ingest this XRFrame's planes/meshes. Call every XR frame. */
  updateXR(frame, refSpace) {
    this.source = 'xr';
    this.model.ingest(frame, refSpace);
  }

  /** Desktop ?simroom only: a fabricated XRFrame fed through the same ingestion path. */
  loadSim() {
    this.reset();
    this.source = 'sim';
    this.sim = makeSimFrame();
    this.setDebug(true);
    this.model.ingest(this.sim.frame, this.sim.refSpace);
  }

  /** Call every frame. Rebuilds the nav grid (throttled) when the scan changed. */
  update(dt, playerLocal) {
    if (this.sim) this.model.ingest(this.sim.frame, this.sim.refSpace);
    this.model.update(dt, playerLocal);
  }

  rebuild(playerLocal) { this.model.rebuild(playerLocal); }

  // ───────────── visualization ─────────────
  _buildViz(rec) {
    const shape = new THREE.Shape(rec.polygon.map((p) => new THREE.Vector2(p.x, -p.z)));
    const geo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);   // shape (x,-z) → plane space (x,0,z)
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: this.tex, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false,
    }));
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(rec.polygon.map((p) => new THREE.Vector3(p.x, 0.003, p.z))),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.5 }),
    );
    const g = new THREE.Group();
    g.add(fill, outline);
    g.matrixAutoUpdate = false;
    g.matrix.fromArray(rec.matrix);
    g.visible = false;     // shown once classified
    rec.viz = g; rec.fill = fill; rec.outline = outline;
    this.group.add(g);
  }

  _styleViz(rec) {
    if (!rec.viz) return;
    const color = COLORS[rec.kind];
    rec.viz.visible = !!color && (this.debug || this.source === 'sim');
    if (!color) return;
    const sim = this.source === 'sim';
    rec.fill.material.color.setHex(color);
    rec.outline.material.color.setHex(color);
    rec.fill.material.opacity = sim ? (rec.kind === 'wall' ? 0.28 : 0.4) : (rec.kind === 'floor' ? 0.1 : 0.14);
  }

  _disposeViz(rec) {
    if (rec.occ) { this._dropOcc(rec.occ); rec.occ = null; }
    if (rec.locc) { this._dropLightOcc(rec.locc); rec.locc = null; }
    if (!rec.viz) return;
    this.group.remove(rec.viz);
    rec.fill.geometry.dispose(); rec.fill.material.dispose();
    rec.outline.geometry.dispose(); rec.outline.material.dispose();
    rec.viz = null;
  }

  _updateCells() {
    const nav = this.nav, m = new THREE.Matrix4();
    const cells = nav.obstacleCells();
    const n = Math.min(cells.length, this.cellsMesh.instanceMatrix.count);
    const s = nav.cell * 0.85;
    for (let i = 0; i < n; i++) {
      const k = cells[i];
      m.makeScale(s, 1, s).setPosition(nav.centerX(k), this.floorY + 0.01, nav.centerZ(k));
      this.cellsMesh.setMatrixAt(i, m);
    }
    this.cellsMesh.count = n;
    this.cellsMesh.instanceMatrix.needsUpdate = true;
  }

  // ───────────── occlusion (depth mask) ─────────────
  // Real-world geometry is drawn depth-only (colorWrite:false) before everything else, so
  // the monster's fragments behind a real couch/wall fail the depth test and passthrough
  // shows through. Scene mesh (Quest 3) is preferred; if the session delivered no meshes,
  // classified planes stand in: walls as quads, furniture tops extruded down to the floor.
  // Geometry is built once per plane/mesh version (lastChangedTime) and cached.
  _updateOccluders() {
    const meshes = this.model.meshes;
    for (const [rec, occ] of this.meshOcc) if (meshes.get(occ.userData.key) !== rec) {
      this._dropOcc(occ); this.meshOcc.delete(rec);
    }
    for (const [key, rec] of meshes) {
      if (this.meshOcc.has(rec) || !rec.vertices || !rec.indices) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(rec.vertices, 3));
      geo.setIndex(new THREE.BufferAttribute(rec.indices, 1));
      const occ = this._addOcc(geo, rec.matrix);
      occ.userData.key = key;
      this.meshOcc.set(rec, occ);
    }
    const usePlanes = this.meshOcc.size === 0;
    const floorY = this.floorY;
    for (const rec of this.model.planes.values()) {
      const want = usePlanes && (rec.kind === 'wall' || rec.kind === 'solid');
      if (rec.occ && (!want || rec.occFloor !== floorY)) { this._dropOcc(rec.occ); rec.occ = null; }
      if (!want || rec.occ) continue;
      const shape = new THREE.Shape(rec.polygon.map((p) => new THREE.Vector2(p.x, -p.z)));
      const h = rec.y - floorY;
      const geo = rec.kind === 'solid' && h > 0.05
        ? new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, -h, 0)
        : new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
      rec.occ = this._addOcc(geo, rec.matrix);
      rec.occFloor = floorY;
    }
    this._syncLightOccluders();
  }

  // Light-only occluders: WALLS only. SHINE THRU FURNITURE means the beam
  // ignores furniture entirely — scene-mesh cubes AND solid planes — so the
  // light passes through it and lands on the wall behind.
  _syncLightOccluders() {
    const floorY = this.floorY;
    for (const rec of this.model.planes.values()) {
      const want = rec.kind === 'wall';
      if (rec.locc && (!want || rec.loccFloor !== floorY)) { this._dropLightOcc(rec.locc); rec.locc = null; }
      if (!want || rec.locc) continue;
      const shape = new THREE.Shape(rec.polygon.map((p) => new THREE.Vector2(p.x, -p.z)));
      const geo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
      rec.locc = this._addOcc(geo, rec.matrix, this.lightOccGroup);
      rec.loccFloor = floorY;
    }
  }

  _addOcc(geo, matrix, target) {
    const m = new THREE.Mesh(geo, OCCLUDER_MAT);
    m.renderOrder = -100;           // opaque pass, before the monster and everything else
    m.matrixAutoUpdate = false;
    m.matrix.fromArray(matrix);
    (target || this.occluderGroup).add(m);
    return m;
  }

  _dropOcc(m) { this.occluderGroup.remove(m); m.geometry.dispose(); }
  _dropLightOcc(m) { this.lightOccGroup.remove(m); m.geometry.dispose(); }

  /** Draw the monster's current plan (room-space points). */
  drawPath(path) {
    const a = this.pathGeo.attributes.position;
    const n = Math.min(path.length, 128);
    for (let i = 0; i < n; i++) a.setXYZ(i, path[i].x, this.floorAt(path[i].x, path[i].z) + 0.03, path[i].z);
    a.needsUpdate = true;
    this.pathGeo.setDrawRange(0, n);
  }

  /** One-line status. Never claims room knowledge without real plane data. */
  summary() {
    const c = this.counts;
    const counts = `${c.floor} floor · ${c.wall} walls · ${c.furniture} furniture`;
    if (this.source === 'sim') return `SIMULATED room (?simroom): ${counts}`;
    if (!this.knowsRoom) return 'NO ROOM SCAN — it walks straight through everything';
    return `room scan: ${counts}${this.model.meshes.size ? ` · ${this.model.meshes.size} meshes` : ''}`;
  }
}