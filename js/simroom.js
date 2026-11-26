// Desktop-only simulated room, enabled ONLY with the ?simroom URL flag.
// It fabricates an XRFrame-shaped object (detectedPlanes + getPose) so the simulated
// room goes through exactly the same ingestion path as a real Quest frame.
//
// 7x7 m room, a full partition wall at z=0.9 (x -3.5..3.5), a couch and a table.

const H = 2.4;

// Column-major 4×4 from basis vectors X, Y (plane normal), Z and position.
const basis = (X, Y, Z, p) => new Float32Array([...X, 0, ...Y, 0, ...Z, 0, ...p, 1]);
const pt = (x, z) => ({ x, y: 0, z, w: 1 });

/** Horizontal plane (normal +Y, or -Y for a ceiling) spanning x0..x1, z0..z1 at height y. */
export function horizPlane(label, y, x0, z0, x1, z1, down = false) {
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
  const matrix = down
    ? basis([1, 0, 0], [0, -1, 0], [0, 0, -1], [cx, y, cz])   // flipped: normal points down
    : basis([1, 0, 0], [0, 1, 0], [0, 0, 1], [cx, y, cz]);
  return { label, orientation: 'horizontal', matrix, polygon: [pt(-hx, -hz), pt(hx, -hz), pt(hx, hz), pt(-hx, hz)] };
}

/** Vertical plane from (ax,az) to (bx,bz), from y0 to y1. Local +Y = horizontal normal, local Z = vertical. */
export function vertPlane(label, ax, az, bx, bz, y0 = 0, y1 = H) {
  let X = [bx - ax, 0, bz - az];
  const len = Math.hypot(X[0], X[2]);
  X = [X[0] / len, 0, X[2] / len];
  const Y = [-X[2], 0, X[0]];
  const Z = [X[1] * Y[2] - X[2] * Y[1], X[2] * Y[0] - X[0] * Y[2], X[0] * Y[1] - X[1] * Y[0]];  // X × Y
  const hy = (y1 - y0) / 2, s = Math.sign(Z[1]);
  return {
    label, orientation: 'vertical',
    matrix: basis(X, Y, Z, [(ax + bx) / 2, (y0 + y1) / 2, (az + bz) / 2]),
    polygon: [pt(-len / 2, -hy * s), pt(len / 2, -hy * s), pt(len / 2, hy * s), pt(-len / 2, hy * s)],
  };
}

/**
 * Wrap plane descriptions as fake XRPlane objects + a fake XRFrame.
 * Each XRPlane: { planeSpace, polygon, orientation, semanticLabel, lastChangedTime }.
 */
export function fakeFrame(descs, { withLabels = true, withOrientation = true } = {}) {
  const poses = new Map();
  const planes = new Set();
  descs.forEach((d, i) => {
    const space = { id: 'plane-space-' + i };
    poses.set(space, { transform: { matrix: d.matrix } });
    planes.add({
      planeSpace: space,
      polygon: Object.freeze(d.polygon.map((p) => Object.freeze({ ...p }))),
      orientation: withOrientation ? d.orientation : undefined,
      semanticLabel: withLabels ? d.label : undefined,
      lastChangedTime: 1,
    });
  });
  const frame = {
    detectedPlanes: planes,
    getPose: (space) => poses.get(space) || null,
  };
  return { frame, refSpace: { id: 'local-floor' }, planes };
}

export function simRoomDescs() {
  return [
    horizPlane('floor', 0, -3.5, -3.5, 3.5, 3.5),
    horizPlane('ceiling', H, -3.5, -3.5, 3.5, 3.5, true),
    vertPlane('wall', -3.5, -3.5, 3.5, -3.5),
    vertPlane('wall', 3.5, -3.5, 3.5, 3.5),
    vertPlane('wall', 3.5, 3.5, -3.5, 3.5),
    vertPlane('wall', -3.5, 3.5, -3.5, -3.5),
    vertPlane('wall', -3.5, 0.9, 3.5, 0.9),            // full partition, no gap
    horizPlane('couch', 0.45, -2.6, -3.1, -0.6, -2.2),
    horizPlane('table', 0.75, 0.9, -1.6, 1.9, -0.8),
  ];
}

export function makeSimFrame() { return fakeFrame(simRoomDescs()); }
