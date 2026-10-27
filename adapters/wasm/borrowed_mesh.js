const {invariant} = require('../../sdk/js/core/terra_globe_common')
const {ownMesh,holdMeshes} = require('../../sdk/js/resources/mesh_ownership')
const {Cleanup,cleanupAfterError}=require('../../sdk/js/runtime/cleanup')

// Direct frames own host copies. A frozen Native measurement epoch separately
// borrows its C++ sources before a later terrain publication can retire them.
// This pins existing payload; NativeMeshBudget continues to count it once.
function holdNativeSurface(abi,surface) {
  const context=abi.context,releases=[holdMeshes(surface.resources.values())]
  const release=()=>{
    const cleanup=new Cleanup()
    for(const done of releases.splice(0).reverse())cleanup.run(done)
    cleanup.finish()
  }
  const check=(name,id)=>{
    const status=abi.nativeCall(name,context,id)
    if(status)throw Object.assign(new Error(`${name} failed with Terra status ${status}`),{status})
  }
  try {
    for(const id of surface.resources.keys()) {
      check('terra_acquire_mesh_resource',id)
      releases.push(()=>{if(abi.context===context&&!abi.destroyed)check('terra_release_mesh_resource',id)})
    }
    return release
  }catch(error){cleanupAfterError(error,release)}
}

// Native owns this payload. JS borrowers hold its native loan, not a second
// allocation. Never transfer these buffers: the receiver needs its own copy.
function borrowMesh(abi, draw) {
  const context = abi.context, id = draw.resourceId
  invariant(Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff, 'Invalid mesh loan ID')
  const check = (name, ...args) => {
    const status = abi.nativeCall(name, context, ...args)
    if (status !== 0) throw Object.assign(new Error(`${name} failed with Terra status ${status}`), {status})
  }
  check('terra_acquire_mesh_resource', id)
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (abi.context === context) check('terra_release_mesh_resource', id)
  }
  try {
    const view = (name, count) => {
      const pointer = abi.module.call(name, context, id)
      invariant(Number.isSafeInteger(count) && count > 0 && pointer > 0 && pointer % 4 === 0,
        'Invalid borrowed mesh view')
      let value
      return () => {
        invariant(!released && abi.context === context, 'Native mesh loan has ended')
        const memory = abi.module.refreshMemory().bytes
        invariant(pointer + count * 4 <= memory.byteLength, 'Native mesh view exceeds memory')
        if (!value || value.buffer !== memory.buffer) value = new Float32Array(memory.buffer, pointer, count)
        return value
      }
    }
    const positions = view('terra_get_mesh_position_view', draw.positionFloatCount)
    const textureUv = view('terra_get_mesh_texture_view', draw.textureFloatCount)
    const resource = {resourceId: id, textureResourceId: draw.textureResourceId}
    Object.defineProperties(resource, {
      positions: {enumerable: true, get: positions},
      textureUv: {enumerable: true, get: textureUv}
    })
    // Reference counting is shared with frame/job ownership. No ledger lease
    // is created: NativeMeshBudget already charges the one physical payload.
    return ownMesh(resource, {bytes: draw.positionFloatCount * 4,
      mark() {}, release})
  } catch (error) { release(); throw error }
}

function bindMeshModel(resource, model) {
  Object.defineProperties(model, {
    positions: {enumerable: true, get: () => resource.positions},
    uv: {enumerable: true, get: () => resource.textureUv}
  })
  return model
}

module.exports = {borrowMesh, bindMeshModel, holdNativeSurface}
