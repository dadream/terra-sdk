// Camera-independent summaries of an explicitly selected set of triangles.
// Results own numeric metadata/face IDs; borrowed views are refreshed per slice.
function* surfaceBlockSteps(source, bounds, dimension, selectedFaces, layout) {
  const faces = source.faces
  const blocks = new Array(dimension * dimension)
  const count = layout ? layout.faceCount : selectedFaces ? selectedFaces.length : faces.length / 3
  const scaleU = dimension / Math.max(1e-12, bounds.maximumU - bounds.minimumU)
  const scaleV = dimension / Math.max(1e-12, bounds.maximumV - bounds.minimumV)
  let positions, uv, layoutIndex = 0, layoutFace = 0
  for (let i = 0; i < count; ++i) {
    if (i % 64 === 0) {
      if (i) yield
      positions = source.positions; uv = source.uv
    }
    if (layout && layoutFace === layout.blocks[layoutIndex].faces.length) {++layoutIndex; layoutFace = 0}
    const shared = layout && layout.blocks[layoutIndex]
    const f = shared ? shared.faces[layoutFace++] : selectedFaces ? selectedFaces[i] : i * 3
    const a = faces[f], b = faces[f + 1], c = faces[f + 2]
    const u0 = uv[a * 2], v0 = uv[a * 2 + 1]
    const u1 = uv[b * 2], v1 = uv[b * 2 + 1]
    const u2 = uv[c * 2], v2 = uv[c * 2 + 1]
    const du1 = u1 - u0, dv1 = v1 - v0, du2 = u2 - u0, dv2 = v2 - v0
    const det = du1 * dv2 - du2 * dv1
    if (Math.abs(det) < 1e-16) continue
    const x0 = positions[a * 3], y0 = positions[a * 3 + 1], z0 = positions[a * 3 + 2]
    const x1 = positions[b * 3], y1 = positions[b * 3 + 1], z1 = positions[b * 3 + 2]
    const x2 = positions[c * 3], y2 = positions[c * 3 + 1], z2 = positions[c * 3 + 2]
    const ux = ((x1 - x0) * dv2 - (x2 - x0) * dv1) / det
    const uy = ((y1 - y0) * dv2 - (y2 - y0) * dv1) / det
    const uz = ((z1 - z0) * dv2 - (z2 - z0) * dv1) / det
    const vx = ((x2 - x0) * du1 - (x1 - x0) * du2) / det
    const vy = ((y2 - y0) * du1 - (y1 - y0) * du2) / det
    const vz = ((z2 - z0) * du1 - (z1 - z0) * du2) / det
    const column = shared ? 0 : Math.max(0, Math.min(dimension - 1, Math.floor(((u0 + u1 + u2) / 3 - bounds.minimumU) * scaleU)))
    const row = shared ? 0 : Math.max(0, Math.min(dimension - 1, Math.floor(((v0 + v1 + v2) / 3 - bounds.minimumV) * scaleV)))
    const key = shared ? layoutIndex : row * dimension + column
    let block = blocks[key]
    if (!block) {
      block = { minimum: [Infinity, Infinity, Infinity],
        maximum: [-Infinity, -Infinity, -Infinity],
        winding: shared ? shared.winding : Math.sign(det),
        faces: shared ? shared.faces : [],
        // During construction these four arrays hold component minima/maxima.
        // Finalize them as interval centres/radii before publishing the block.
        du: [ux, uy, uz], dv: [vx, vy, vz], deviation: 0,
        duRadius: [ux, uy, uz], dvRadius: [vx, vy, vz],
        uv: shared ? shared.uv : { minimumU: Infinity, minimumV: Infinity, maximumU: -Infinity, maximumV: -Infinity } }
      blocks[key] = block
    }
    if (!shared) {
      block.faces.push(f)
      if(block.winding!==Math.sign(det)) block.winding=0
    }
    ;[ux, uy, uz].forEach((v, i) => {
      block.du[i] = Math.min(block.du[i], v); block.duRadius[i] = Math.max(block.duRadius[i], v)
    })
    ;[vx, vy, vz].forEach((v, i) => {
      block.dv[i] = Math.min(block.dv[i], v); block.dvRadius[i] = Math.max(block.dvRadius[i], v)
    })
    block.minimum[0] = Math.min(block.minimum[0], x0, x1, x2)
    block.minimum[1] = Math.min(block.minimum[1], y0, y1, y2)
    block.minimum[2] = Math.min(block.minimum[2], z0, z1, z2)
    block.maximum[0] = Math.max(block.maximum[0], x0, x1, x2)
    block.maximum[1] = Math.max(block.maximum[1], y0, y1, y2)
    block.maximum[2] = Math.max(block.maximum[2], z0, z1, z2)
    if (!shared) {
      block.uv.minimumU = Math.min(block.uv.minimumU, u0, u1, u2)
      block.uv.maximumU = Math.max(block.uv.maximumU, u0, u1, u2)
      block.uv.minimumV = Math.min(block.uv.minimumV, v0, v1, v2)
      block.uv.maximumV = Math.max(block.uv.maximumV, v0, v1, v2)
    }
  }
  return blocks.filter(Boolean).map(block => {
    // A first-face anchor plus a symmetric deviation charges the complete
    // slope range again when the anchor is already its maximum. Midpoints
    // enclose the same triangles without depending on their iteration order.
    // The radius uses both endpoints to preserve enclosure after rounding.
    for (const [centre, radius] of [[block.du, block.duRadius], [block.dv, block.dvRadius]]) {
      for (let i=0;i<3;++i) {
        const low=centre[i], high=radius[i], middle=low+(high-low)/2
        centre[i]=middle; radius[i]=Math.max(high-middle,middle-low)
      }
    }
    // Every residual matrix lies in this component box, hence its Frobenius
    // norm is bounded by the radius norm. No extra retained metadata is needed.
    block.deviation = Math.hypot(...block.duRadius, ...block.dvRadius)
    return block
  })
}

function surfaceBlocks(positions, uv, faces, bounds) {
  const work = surfaceBlockSteps({positions, uv, faces}, bounds, 4, null)
  let result
  do { result = work.next() } while (!result.done)
  return result.value
}

function* splitSurfaceBlock(surface, block) {
  const children = yield* surfaceBlockSteps(surface, block.uv, 2, block.faces)
  return children.length > 1 ? children : null
}

module.exports = {surfaceBlockSteps, surfaceBlocks, splitSurfaceBlock}
