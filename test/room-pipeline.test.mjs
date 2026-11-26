// node --test test/
// Fabricated XRPlane objects → RoomModel.ingest (pose → polygon → room space) →
// classification → NavGrid → BFS. Same code the headset runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomModel, framePlanes } from '../js/roommodel.js';
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
