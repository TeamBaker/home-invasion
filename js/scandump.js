// Scan dump: RoomModel -> plain JSON-able object describing exactly what Quest reported
// (planes + meshes, in room space = the XR reference space). Pure JS (no three.js, no DOM)
// so it is exercised by `node --test test/`. Uploaded by the SAVE SCAN settings row.

export const SCAN_DECIMALS = 3;                 // mm precision
export const SCAN_MESH_VALUE_CAP = 1500000;     // total mesh numbers (vertex coords + indices) kept, ~10 MB JSON

const round = (v, k) => Math.round(v * k) / k;
const roundArr = (a, k) => Array.from(a, (v) => round(v, k));
const roundPt = (p, k) => ({ x: round(p.x, k), y: round(p.y || 0, k), z: round(p.z, k) });

/**
 * model: RoomModel. opts: { now: Date, source, userAgent, decimals, meshValueCap }.
 * Meshes are written in iteration order until the value cap is reached; later meshes keep
 * label/pose/counts but get vertices/indices = null and truncated = true.
 */
export function serializeScan(model, opts = {}) {
  const k = Math.pow(10, opts.decimals ?? SCAN_DECIMALS);
  const cap = opts.meshValueCap ?? SCAN_MESH_VALUE_CAP;
  const now = opts.now || new Date();

  const planes = [];
  for (const r of model.planes.values()) {
    planes.push({
      label: r.label,
      orientation: r.orientation,
      facing: r.facing,
      kind: r.kind,
      changed: r.changed ?? null,
      matrix: roundArr(r.matrix, 1e6),
      polygon: r.polygon.map((p) => roundPt(p, k)),     // plane-local (planeSpace)
      points: r.pts.map((p) => roundPt(p, k)),          // room space
    });
  }

  let used = 0, truncated = 0;
  const meshes = [];
  for (const m of model.meshes.values()) {
    const nv = m.vertices ? m.vertices.length : 0;
    const ni = m.indices ? m.indices.length : 0;
    const fits = used + nv + ni <= cap;
    if (fits) used += nv + ni; else truncated++;
    meshes.push({
      label: m.label,
      changed: m.changed ?? null,
      matrix: roundArr(m.matrix, 1e6),
      vertexCount: nv / 3,
      triangleCount: ni / 3,
      truncated: !fits,
      vertices: fits && m.vertices ? roundArr(m.vertices, k) : null,   // mesh-local xyz triples
      indices: fits && m.indices ? Array.from(m.indices) : null,
    });
  }

  return {
    meta: {
      format: 'home-invasion-scan/1',
      timestamp: now.toISOString(),
      source: opts.source ?? null,
      userAgent: opts.userAgent ?? null,
      floorY: round(model.floorY || 0, k),
      planeCount: planes.length,
      meshCount: meshes.length,
      meshesTruncated: truncated,
      meshValuesKept: used,
      meshValueCap: cap,
      decimals: Math.round(Math.log10(k)),
      counts: model.counts || null,
      diag: model.diag || null,
      doorZones: model.doorZones || [],
    },
    planes,
    meshes,
  };
}
