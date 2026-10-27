// Stage an offline view of planner demand and depth-visible texture cells.
// Usage: node scripts/build_visibility_replay.js SNAPSHOT PLAN OUTPUT [WASM]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { TerraAbi } = require('../adapters/wasm/terra_abi')
const { instantiateTerraWasmBytes } = require('../adapters/wasm/terra_wasm')
const { relativeProjectionView, rowMajorToWebGlMatrix } = require('../sdk/js/core/terra_globe_common')
const {prepareSurface} = require('../sdk/js/terrain/terra_surface_plan')
const {visibilityCellBounds} = require('../sdk/js/terrain/visibility_cells')

const root = path.resolve(__dirname, '..')
const array = (value, length) => Array.from({ length }, (_, i) => value[i])
const encoded = value => Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')

function conservativeBounds(input, draws, depth) {
  if (!Number.isInteger(depth) || depth < 0 || depth > 2) throw Error('Conservative replay depth must be 0..2')
  const decoded = (text, Type) => { const b = Buffer.from(text, 'base64'); return new Type(b.buffer.slice(b.byteOffset, b.byteOffset+b.byteLength)) }
  const s = input.snapshot, indices = decoded(s.indices, Uint16Array)
  const meshes = new Map(s.meshes.map(m => [m.id, m]))
  const frame = {cameraPosition: input.camera, projectionView: s.frame ? array(s.frame.projectionView,16) : input.matrix}
  const viewport = {width:s.budget.physicalWidth,height:s.budget.physicalHeight}
  const levels = Array.from({length:depth+1}, (_,depth) => ({depth,cells:[]}))
  const started = Date.now()
  let steps = 0
  for (const draw of draws) {
    const mesh = meshes.get(draw.resourceId)
    const model = prepareSurface(decoded(mesh.positions,Float32Array),decoded(mesh.uv,Float32Array),indices,draw.firstIndex,draw.indexCount)
    for (let level=0;level<=depth;++level) {
      const factor=2**level, base=draw.imageryClipCell ? draw.imageryCellScale : 1
      for(let y=0;y<factor;++y) for(let x=0;x<factor;++x) {
        const cell={id:draw.resourceId,scale:base*factor,
          x:x-(draw.imageryClipCell?draw.imageryCellOffsetX:0)*factor,
          y:y-(draw.imageryClipCell?draw.imageryCellOffsetY:0)*factor}
        const work=visibilityCellBounds(model,draw,frame,viewport,cell)
        let next
        do { next=work.next();++steps } while(!next.done)
        levels[level].cells.push({...cell,rectangles:next.value})
      }
    }
  }
  return {depth,levels,steps,durationMs:Date.now()-started}
}

function control(tileGpuBytes) {
  const draws = [], meshes = []
  function quad(id, left, right, depth, firstIndex = 0, clipped = false) {
    meshes.push({ id,
      positions: encoded(new Float32Array([
        left, -.8, depth, left, .8, depth, right, -.8, depth, right, .8, depth])),
      uv: encoded(new Float32Array([0, 0, 0, 1, 1, 0, 1, 1])) })
    draws.push({ resourceId: id, origin: [0, 0, 0], flags: 0, firstIndex, indexCount: 4,
      texture: clipped ? { level: 1, column: 1, row: 1 } : { level: 0, column: id - 1, row: 0 },
      imageryClipCell: clipped, imageryCellScale: clipped ? 2 : 1,
      imageryCellOffsetX: clipped ? -1 : 0, imageryCellOffsetY: clipped ? -1 : 0 })
  }
  quad(1, -.9, -.1, -.2) // Front occluder.
  quad(2, -.9, -.1, .2) // Entirely behind the first quad.
  quad(3, 2, 3, 0) // Outside the frustum.
  quad(4, .1, .9, -.4, 4) // Counterclockwise, facing away.
  quad(5, .1, .9, 0, 0, true) // Only the upper-right UV child.
  return { tileGpuBytes, camera: [0, 0, 0],
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], draws,
    snapshot: { budget: { physicalWidth: 128, physicalHeight: 128 }, meshes,
      indices: encoded(new Uint16Array([0, 1, 2, 3, 0, 2, 1, 3])) },
    expected: {
      summary: { planned: 5, projected: 3, depthVisible: 2, pixelVisible: 2,
        fullyOccluded: 1, noProjectedSamples: 2 },
      tiles: { '0/0/0': [true, true], '0/1/0': [true, false],
        '0/2/0': [false, false], '0/3/0': [false, false], '1/1/1': [true, true] }
    } }
}

async function main() {
  const [snapshotFile, planFile, destination, wasmFile, boundsDepth] = process.argv.slice(2)
  if (!snapshotFile || !planFile || !destination) {
    throw new Error('Usage: node scripts/build_visibility_replay.js SNAPSHOT PLAN OUTPUT [WASM]')
  }
  const snapshotBytes = fs.readFileSync(snapshotFile)
  const snapshot = JSON.parse(snapshotBytes), input = JSON.parse(fs.readFileSync(planFile))
  if (snapshot.schema !== 'terra.measurement-replay.v1') throw new Error('Unknown snapshot schema')
  if (JSON.stringify(snapshot.view) !== JSON.stringify(input.state.view) ||
      snapshot.frame.sequence !== input.state.frame.sequence) {
    throw new Error('Snapshot and planner input must describe the same fixed view and frame')
  }
  const sourceDraws = new Map(snapshot.draws.map(draw => [draw.resourceId, draw]))
  for (const draw of input.draws) {
    const source = sourceDraws.get(draw.resourceId)
    if (!source || JSON.stringify(source.origin) !== JSON.stringify(draw.origin) ||
        JSON.stringify(source.texture) !== JSON.stringify(draw.texture) ||
        source.firstIndex !== draw.firstIndex || source.indexCount !== draw.indexCount) {
      throw new Error('Snapshot and planner draw differ: ' + draw.resourceId)
    }
  }
  const wasm = fs.readFileSync(wasmFile || path.join(root, 'workspace_old/build/wasm/terra_sdk.wasm'))
  const abi = new TerraAbi(await instantiateTerraWasmBytes(wasm))
  try {
    // This diagnostic currently accepts the globe geographic dataset only.
    if (snapshot.view.mode !== 'globe') throw new Error('Globe snapshot required')
    abi.loadManifest({ formatVersion: 1, patchDimension: 64, transform: 'cylindrical',
      heightScale: 1 / 512, minimumU: -180, minimumV: -90, maximumU: 180, maximumV: 90,
      radius: 6378000, texture: input.options.descriptor })
    const measurements = new Map(input.measurements), capacities = []
    let plan
    for (const maximumTextures of [214, 256, 320, 512, 1024]) {
      plan = abi.planImagery(input.draws, draw => measurements.get(draw.resourceId), {
        ...input.options, maximumTextures, detached: true, maximumDraws: 8192, resetHistory: true
      })
      capacities.push({ maximumTextures, quality: plan.quality })
    }
    const meshes = new Map(snapshot.meshes.map(mesh => [mesh.id, mesh]))
    const indices = Buffer.from(snapshot.indices, 'base64')
    for (const draw of plan.draws) {
      if (!meshes.has(draw.resourceId) || draw.flags & 1 || draw.firstIndex < 0 ||
          (draw.firstIndex + draw.indexCount) * 2 > indices.byteLength) {
        throw new Error('Invalid replay geometry: ' + draw.resourceId)
      }
    }
    const camera = array(snapshot.frame.cameraPosition, 3)
    const matrix = Array.from(rowMajorToWebGlMatrix(relativeProjectionView(
      array(snapshot.frame.projectionView, 16), camera)))
    let tileGpuBytes = 0
    const width = input.options.descriptor.tile_size
    if (!Number.isInteger(width) || width < 1) throw new Error('Invalid tile size')
    for (let size = width; ; size = Math.max(1, Math.floor(size / 2))) {
      tileGpuBytes += size * size * 4
      if (size === 1) break
    }
    const hash = value => crypto.createHash('sha256').update(value).digest('hex')
    const output = path.resolve(destination)
    fs.mkdirSync(output, { recursive: true })
    const replay = { snapshot, draws: plan.draws, sourceDraws: input.draws,
      camera, matrix, capacities, tileGpuBytes, snapshotSha256: hash(snapshotBytes), wasmSha256: hash(wasm) }
    const fixture = control(tileGpuBytes)
    if (boundsDepth !== undefined) {
      replay.uvBounds = conservativeBounds(replay,input.draws,Number(boundsDepth))
      fixture.uvBounds = conservativeBounds(fixture,fixture.draws,Number(boundsDepth))
    }
    fs.writeFileSync(path.join(output, 'replay.json'), JSON.stringify(replay))
    fs.writeFileSync(path.join(output, 'control.json'), JSON.stringify(fixture))
    fs.copyFileSync(path.join(root, 'tests/web_sdk/visibility_replay.js'), path.join(output, 'raster.js'))
    fs.copyFileSync(path.join(root, 'tests/web_sdk/visible_uv_replay.js'), path.join(output, 'visible_uv.js'))
    fs.copyFileSync(path.join(root, 'tests/web_sdk/triangle_visibility_replay.js'), path.join(output, 'triangle_visibility.js'))
    fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8">' +
      '<link rel="icon" href="data:,"><title>Offline terrain visibility</title>' +
      '<canvas></canvas><pre id="visibility-evidence"></pre><script src="visible_uv.js"></script>' +
      '<script src="triangle_visibility.js"></script><script src="raster.js"></script>')
    console.log(JSON.stringify({ output, capacities, draws: plan.draws.length, tileGpuBytes }))
  } finally { abi.destroy() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
