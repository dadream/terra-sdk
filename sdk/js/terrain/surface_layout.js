// A UV layout owns only topology and UV-domain metadata. Heights, positions,
// derivatives, spatial bounds and visibility trees belong to individual meshes.
// The index template itself is already shared separately by surface preparation.
function surfaceLayout(model, vertexCount) {
  const blocks = model.blocks.map(block => ({faces: block.faces, uv: block.uv, winding: block.winding}))
  const faceCount = blocks.reduce((sum, block) => sum + block.faces.length, 0)
  return {faces: model.faces, vertexCount, bounds: model.bounds, hull: model.hull, blocks, faceCount,
    numericPayloadBytes: faceCount * 8 + blocks.length * 40 + 48 + model.hull.length * 16}
}

// Host UV arrays have explicit immutable resource ownership. A weak cache follows
// that lifetime; it cannot keep retired coordinate buffers or native loans alive.
const layouts = new WeakMap()
function getSurfaceLayout(uv, faces) {
  const values = layouts.get(uv)
  return values && values.get(faces)
}
function rememberSurfaceLayout(uv, layout) {
  let values = layouts.get(uv)
  if (!values) {values = new Map(); layouts.set(uv, values)}
  values.set(layout.faces, layout)
}

function applySurfaceLayout(model, layout) {
  model.bounds = layout.bounds
  model.hull = layout.hull
  model.blocks = model.blocks.map((block, i) => Object.assign({}, block, {
    faces: layout.blocks[i].faces, uv: layout.blocks[i].uv, winding: layout.blocks[i].winding}))
  model.layout = layout
  return model
}

module.exports = {surfaceLayout, getSurfaceLayout, rememberSurfaceLayout, applySurfaceLayout}
