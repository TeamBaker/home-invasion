// node --test test/
// Fabricated XRPlane objects → RoomModel.ingest (pose → polygon → room space) →
// classification → NavGrid → BFS. Same code the headset runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomModel, framePlanes, inDoor, meshIndicesOutsideDoors } from '../js/roommodel.js';
import { fakeFrame, horizPlane, vertPlane } from '../js/simroom.js';

// Two rooms split by a partition wall at z=0 with a gap between wall segments at x in [1.0, 2.0]; a table in room A.
//   room A: z < 0 (player)      room B: z > 0 (monster)
function scene() {
  return [
    horizPlane('floor', 0, -3, -3, 3, 3),
    horizPlane('ceiling', 2.5, -3, -3, 3, 3, true),
    vertPlane('wall', -3, -3, 3, -3),
    vertPlane('wall', 3, -3, 3, 3),
    vertPlane('wall', 3, 3, -3, 3),
    vertPlane('wall', -3, 3, -3, -3),
    vertPlane('wall', -3, 0, 1.0, 0),          // partition, left of the gap
    vertPlane('wall', 2.0, 0, 3, 0),           // partition, right of the gap
    horizPlane('table', 0.74, -2, -2, -1, -1.2),
  ];
}

function build(descs, opts) {
  const m = new RoomModel();
  const { frame, refSpace } = fakeFrame(descs, opts);
  m.ingest(frame, refSpace);
  m.rebuild({ x: 0, z: -1.5 });
  return m;
}

test('plane module detection is guarded', () => {
  assert.equal(framePlanes({}).active, false);
  assert.equal(framePlanes({ detectedPlanes: undefined }).active, false);
  assert.equal(framePlanes({ get detectedPlanes() { throw new Error('NotSupportedError'); } }).active, false);
  assert.equal(framePlanes({ detectedPlanes: new Set() }).active, true);
  const m = new RoomModel();
  m.ingest({ getPose: () => null }, {});
  assert.equal(m.diag.planeModuleActive, false);
  assert.equal(m.knowsRoom, false);
  m.rebuild();
  assert.equal(m.nav.ok, false, 'no planes → no grid');
});

for (const [name, opts] of [
  ['labelled planes', {}],
  ['unlabelled planes (classified from normals)', { withLabels: false, withOrientation: false }],
]) {
  test(`pipeline: ${name}`, () => {
    const m = build(scene(), opts);
    const nav = m.nav;
    assert.ok(m.diag.planeModuleActive);
    assert.ok(m.knowsRoom);
    assert.equal(m.counts.floor, 1);
    assert.equal(m.counts.wall, 6);
    assert.equal(m.counts.furniture, 1, 'table top');
    assert.ok(nav.ok);
    assert.equal(m.floorY, 0);

    // Pose → room space: the partition really is at z=0, the table at its true position.
    assert.equal(nav.passable(-1.5, 0, true), false, 'partition wall blocks');
    assert.equal(nav.passable(2.6, 0, true), false, 'partition right of gap blocks');
    assert.equal(nav.passable(1.5, 0), true, 'gap centre is walkable (even inflated)');
    assert.equal(nav.passable(-1.5, -1.6, true), false, 'table blocks');
    assert.equal(nav.passable(0.5, -1.6), true, 'open floor is walkable');
    assert.equal(nav.passable(4, 0), false, 'outside the floor polygon is blocked');

    // BFS: monster in room B must route through the gap to reach the player in room A.
    const P = { x: -1.5, z: -0.8 }, M = { x: -1.5, z: 1.5 };
    nav.setTarget(P.x, P.z);
    assert.ok(Number.isFinite(nav.pathLength(M.x, M.z)), 'reachable');
    assert.ok(nav.pathLength(M.x, M.z) > Math.hypot(P.x - M.x, P.z - M.z) + 3, 'path is a detour, not straight through');
    let x = M.x, z = M.z, crossedAt = null, steps = 0;
    for (; steps < 2000 && Math.hypot(P.x - x, P.z - z) > 0.4; steps++) {
      const wp = nav.steer(x, z, P.x, P.z);
      assert.notEqual(wp.mode, 'blocked');
      const dx = wp.x - x, dz = wp.z - z, l = Math.hypot(dx, dz) || 1;
      const [nx, nz] = nav.move(x, z, dx / l * 0.03, dz / l * 0.03);
      assert.ok(nav.passable(nx, nz, true), `never inside an obstacle (${nx.toFixed(2)},${nz.toFixed(2)})`);
      if (z > 0 && nz <= 0) crossedAt = (x + nx) / 2;
      x = nx; z = nz;
    }
    assert.ok(steps < 2000, 'monster reached the player');
    assert.ok(crossedAt !== null && crossedAt > 1.0 && crossedAt < 2.0, `crossed z=0 through the gap (x=${crossedAt})`);

    const g = nav.counts();
    assert.ok(g.blocked > 0 && g.walkable > 0 && g.reachable > 0 && g.reachable <= g.walkable);
  });
}

test('sealing the gap -> no route (BLOCKED)', () => {
  const descs = scene();
  descs.push(vertPlane('wall', 1.0, 0, 2.0, 0));
  const nav = build(descs).nav;
  nav.setTarget(-1.5, -0.8);
  assert.equal(nav.pathLength(-1.5, 1.5), Infinity);
  assert.equal(nav.steer(-1.5, 1.5, -1.5, -0.8).mode, 'blocked');
});

test('plane removal and change are picked up frame-to-frame', () => {
  const m = new RoomModel();
  const { frame, refSpace, planes } = fakeFrame(scene());
  m.ingest(frame, refSpace); m.rebuild();
  assert.equal(m.planes.size, 9);
  const table = [...planes].find((p) => p.semanticLabel === 'table');
  planes.delete(table);
  m.ingest(frame, refSpace);
  assert.ok(m.dirty);
  m.rebuild();
  assert.equal(m.counts.furniture, 0);
  assert.equal(m.nav.passable(-1.5, -1.6, true), true, 'table gone → floor free');
});

test('mesh: knee-to-head band only, runtime errors disable meshes', () => {
  // A 1 m cube "couch volume" at x∈[-2,-1], z∈[1,2], y∈[0,1] as a mesh; and a 0.3 m-high footstool.
  const box = (x0, z0, x1, z1, y0, y1) => {
    const v = [], idx = [];
    for (const y of [y0, y1]) for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) v.push(x, y, z);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; idx.push(i, j, j + 4, i, j + 4, i + 4); }
    return { vertices: new Float32Array(v), indices: new Uint32Array(idx) };
  };
  const { frame, refSpace } = fakeFrame(scene());
  const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const ms = { id: 'mesh-space' };
  const getPose = frame.getPose;
  frame.getPose = (s, r) => (s === ms ? { transform: { matrix: I } } : getPose(s, r));
  frame.detectedMeshes = new Set([
    { meshSpace: ms, ...box(-2, 1, -1, 2, 0, 1), semanticLabel: 'couch', lastChangedTime: 1 },
    { meshSpace: ms, ...box(1, 1.5, 1.4, 1.9, 0, 0.3), semanticLabel: 'other', lastChangedTime: 1 },
  ]);
  const m = new RoomModel();
  m.ingest(frame, refSpace); m.rebuild();
  assert.ok(m.diag.meshModuleActive);
  assert.equal(m.diag.meshesInFrame, 2);
  assert.equal(m.nav.passable(-1, 1.5, true), false, 'couch side (knee-head band) blocks');
  assert.equal(m.nav.passable(1.0, 1.7, true), true, 'footstool below knee height ignored');

  Object.defineProperty(frame, 'detectedMeshes', { get() { throw new Error('mesh boom'); } });
  m.ingest(frame, refSpace);
  assert.ok(m.diag.meshDisabled);
  assert.match(m.diag.meshError, /mesh boom/);
  assert.equal(m.meshes.size, 0);
  m.ingest(frame, refSpace);   // no throw, planes still flow
  assert.equal(m.planes.size, 9);
});

test('lost player in unmapped space keeps the last target instead of dying', () => {
  const nav = build(scene()).nav;
  const reachable = () => nav.dist.some((d) => d >= 0);
  nav.setTarget(0, -1);
  assert.equal(nav.targetIsPlayer, true);
  assert.ok(reachable(), 'player on free floor -> reachable set non-empty');
  const k0 = nav.cellOf(0, -1);
  const want = nav.cellOf(nav.centerX(k0), nav.centerZ(k0));
  nav.setTarget(6, 0);
  assert.equal(nav.targetIsPlayer, false);
  assert.ok(reachable(), 'unmapped player -> field kept');
  assert.equal(nav.targetCell, want);
});

// Vertical plane along +X from (ax, z) to (bx, z) whose polygon is given as (x, h)
// pairs in world terms. Same basis and sign handling as simroom vertPlane: local Z
// is X x Y, so world h = cy + s * localZ with s = sign(Z.y).
function vertPolyPlane(label, ax, bx, z, y0, y1, outline) {
  const X = [1, 0, 0], Y = [0, 0, 1];
  const Z = [X[1] * Y[2] - X[2] * Y[1], X[2] * Y[0] - X[0] * Y[2], X[0] * Y[1] - X[1] * Y[0]];
  const cx = (ax + bx) / 2, cy = (y0 + y1) / 2, s = Math.sign(Z[1]);
  const matrix = new Float32Array([...X, 0, ...Y, 0, ...Z, 0, cx, cy, z, 1]);
  return { label, orientation: 'vertical', matrix, polygon: outline.map(([x, h]) => ({ x: x - cx, y: 0, z: (h - cy) * s, w: 1 })) };
}

test('overhead geometry does not block: an opening under a lintel stays walkable', () => {
  const descs = scene().filter((_, i) => i !== 6 && i !== 7);   // drop the two partition segments
  descs.push(vertPolyPlane('wall', -3, 3, 0, 0, 2.4, [
    [-3, 0], [1.0, 0], [1.0, 2.1], [2.0, 2.1], [2.0, 0], [3, 0], [3, 2.4], [-3, 2.4],
  ]));
  const m = build(descs);
  const nav = m.nav;
  assert.equal(m.counts.wall, 5);
  assert.equal(nav.passable(1.5, 0, true), true, 'opening under the lintel is walkable');
  assert.equal(nav.passable(-1.5, 0, true), false, 'solid wall left of the opening blocks');
  assert.equal(nav.passable(2.6, 0, true), false, 'solid wall right of the opening blocks');

  const P = { x: -1.5, z: -0.8 }, M = { x: -1.5, z: 1.5 };
  nav.setTarget(P.x, P.z);
  assert.ok(Number.isFinite(nav.pathLength(M.x, M.z)), 'reachable');
  let x = M.x, z = M.z, crossedAt = null, steps = 0;
  for (; steps < 2000 && Math.hypot(P.x - x, P.z - z) > 0.4; steps++) {
    const wp = nav.steer(x, z, P.x, P.z);
    assert.notEqual(wp.mode, 'blocked');
    const dx = wp.x - x, dz = wp.z - z, l = Math.hypot(dx, dz) || 1;
    const [nx, nz] = nav.move(x, z, dx / l * 0.03, dz / l * 0.03);
    assert.ok(nav.passable(nx, nz, true), `never inside an obstacle (${nx.toFixed(2)},${nz.toFixed(2)})`);
    if (z > 0 && nz <= 0) crossedAt = (x + nx) / 2;
    x = nx; z = nz;
  }
  assert.ok(steps < 2000, 'monster reached the player');
  assert.ok(crossedAt !== null && crossedAt > 1.0 && crossedAt < 2.0, `crossed z=0 through the opening (x=${crossedAt})`);
});

// Real Quest layout: each room reports its partition as a FULL rectangle spanning the
// doorway (room A's at z=0, room B's 12 cm away at z=0.12), plus a 'door frame' plane
// at x 1.0..2.0, and the global mesh contains the propped-open door slab.
test('doorways are empty space: walls, frame, door slab and mesh never block or occlude there', () => {
  const descs = scene().filter((_, i) => i !== 6 && i !== 7);
  descs.push(vertPlane('wall', -3, 0, 3, 0), vertPlane('wall', 3, 0.12, -3, 0.12));
  descs.push(vertPlane('door frame', 1.0, 0, 2.0, 0, 0, 2.1));
  const box = (x0, z0, x1, z1, y0, y1) => {
    const v = [], idx = [];
    for (const y of [y0, y1]) for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) v.push(x, y, z);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; idx.push(i, j, j + 4, i, j + 4, i + 4); }
    return { vertices: new Float32Array(v), indices: new Uint32Array(idx) };
  };
  const { frame, refSpace } = fakeFrame(descs);
  const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const ms = { id: 'mesh-space' };
  const getPose = frame.getPose;
  frame.getPose = (s, r) => (s === ms ? { transform: { matrix: I } } : getPose(s, r));
  const slab = box(1.0, -0.9, 1.05, 0, 0.01, 2.0);           // door swung open 90 deg into room A
  const couch = box(-2, 1, -1, 2, 0, 1);
  frame.detectedMeshes = new Set([
    { meshSpace: ms, ...slab, semanticLabel: 'global mesh', lastChangedTime: 1 },
    { meshSpace: ms, ...box(1.0, -0.05, 2.0, 0.05, 0, 2.1), semanticLabel: 'door frame', lastChangedTime: 1 },
    { meshSpace: ms, ...couch, semanticLabel: 'couch', lastChangedTime: 1 },
  ]);
  const m = new RoomModel();
  m.ingest(frame, refSpace); m.rebuild({ x: 0, z: -1.5 });
  const nav = m.nav;
  assert.equal(m.doorZones.length, 1);
  assert.equal(m.counts.wall, 6, 'both partition rectangles are still walls');

  // Pathfinding / movement: the doorway is open floor; the walls around it still block.
  for (const z of [-0.5, 0, 0.06, 0.12, 0.5]) assert.equal(nav.passable(1.5, z, true), true, `doorway free at z=${z}`);
  assert.equal(nav.passable(-1.5, 0, true), false, 'wall left of the door blocks');
  assert.equal(nav.passable(2.7, 0.12, true), false, 'wall right of the door blocks');
  assert.equal(nav.passable(-1, 1.5, true), false, 'couch still blocks');
  nav.setTarget(-1.5, -0.8);
  assert.ok(Number.isFinite(nav.pathLength(0, 1.5)), 'monster in room B reaches room A through the door');
  assert.notEqual(nav.steer(0, 1.5, -1.5, -0.8).mode, 'blocked');

  // Occlusion / camera / flashlight: wall pieces have a hole exactly at the doorway.
  const walls = [...m.planes.values()].filter((r) => r.kind === 'wall' && r.pieces);
  assert.equal(walls.length, 2, 'only the two partition walls are cut');
  const covered = (x, y, z) => walls.some((r) => r.pieces.some((q) => {
    const xs = q.map((p) => p.x), ys = q.map((p) => p.y), zs = q.map((p) => p.z);
    return x >= Math.min(...xs) && x <= Math.max(...xs) && y >= Math.min(...ys) && y <= Math.max(...ys)
      && Math.abs(z - zs[0]) < 1e-3;
  }));
  for (const z of [0, 0.12]) {
    for (const y of [0.05, 1.0, 1.7, 2.1]) assert.equal(covered(1.5, y, z), false, `no wall in the doorway (y=${y}, z=${z})`);
    assert.equal(covered(1.5, 2.3, z), true, 'lintel above the door still occludes');
    assert.equal(covered(-1.5, 1.0, z), true, 'wall beside the door still occludes');
  }
  assert.ok(inDoor({ x: 1.5, y: 1.6, z: 0.06 }, m.doorZones), 'head in the doorway is inside the zone');
  assert.ok(!inDoor({ x: -1.5, y: 1.0, z: -1.5 }, m.doorZones));

  // Scene mesh occluders: door slab triangles dropped, couch untouched.
  assert.equal(meshIndicesOutsideDoors(couch.vertices, couch.indices, I, m.doorZones, 0), null, 'couch untouched');
  const kept = meshIndicesOutsideDoors(slab.vertices, slab.indices, I, m.doorZones, 0);
  assert.ok(kept && kept.length === 0, 'propped-open door slab removed from the depth mask');
});
