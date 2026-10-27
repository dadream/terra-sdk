// Actual PNG decoding, GPU completion, orientation and scheduled context recovery.
// This fixture owns no network service and closes its GL context in all paths.
// These stage assertions deliver both clocks explicitly through advanceResources
// and render. Suppress
// the standalone renderer's independent timer so download-only waits stay put.
window.verifyEncodedResidency = async function (sdk) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32
  const source = document.createElement('canvas'); source.width = source.height = 256
  const context = source.getContext('2d')
  context.fillStyle = '#f02010'; context.fillRect(0,0,256,128)
  context.fillStyle = '#1030e0'; context.fillRect(0,128,256,128)
  const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'))
  const gl = canvas.getContext('webgl2', {antialias: false})
  const lose = gl.getExtension('WEBGL_lose_context')
  let renderer, requests = 0, frameBuffer, maximumDecodedBytes = 0
  let releaseDownloads
  const downloadsReady = new Promise(resolve => { releaseDownloads = resolve })
  const clientWait = gl.clientWaitSync.bind(gl)
  const require = (value, message) => { if (!value) throw Error(message) }
  const until = async (predicate, message) => {
    const deadline = performance.now() + 10000
    while (performance.now() < deadline) {
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw Error(message)
  }
  const tile = {level: 0, matrix: 0, row: 0, column: 0}, key = '0/0/0/0'
  const second = {...tile, column: 1}, secondKey = '0/0/0/1'
  const pump = () => {
    renderer.advanceResources(); renderer.render(false)
    maximumDecodedBytes = Math.max(maximumDecodedBytes, renderer.textures.stats().decodedBytes)
  }
  const read = texture => {
    frameBuffer = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    require(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, 'Texture framebuffer incomplete')
    const top = new Uint8Array(4), bottom = new Uint8Array(4)
    gl.readPixels(64,64,1,1,gl.RGBA,gl.UNSIGNED_BYTE,top)
    gl.readPixels(64,192,1,1,gl.RGBA,gl.UNSIGNED_BYTE,bottom)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(frameBuffer); frameBuffer = null
    return [...top,...bottom]
  }
  try {
    require(lose, 'Context loss extension unavailable')
    renderer = new sdk.webgl.TerraWebGlRenderer(canvas, {gl, requestResources() {}, mode: 'height', managedResources: true, scheduledImagery: true,
      createTextureStore: sdk.testTextures.createTextureStore,
      textureDescriptor: {kind: 'global-geodetic', tile_size: 256}, directTextureTargets: true, prefetchTextureAncestors: false,
      textureCacheBytes: 4*1024*1024, maximumTextureEntries: 16,
      maximumResourceBytes: 36*1024*1024,
      urlForTile: () => 'https://fixture.invalid/imagery.png',
      fetchTextures: async () => {
        ++requests; await downloadsReady
        return new Response(blob, {headers: {'content-type': 'image/png'}})
      }})
    const store = renderer.textures
    require(store instanceof sdk.testEncoded.EncodedTextureStore, 'Browser factory bypassed encoded residency')
    renderer.setMeshFrame({sequence: 1, coverageComplete: true,
      projectionView: new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]), cameraPosition: [0,0,2]},
    [tile,second].map((texture,i) => ({resourceId:i+1, textureResourceId:4294967296 + (i+1), flags: 0, key: {level: 0, i, j: 0, k: 0}, fragment: 0,
      texture, origin: [0,0,0], firstIndex: 0, indexCount: 4, vertexCount: 4})),
    new Map([0,1].map(i => [i+1, {resourceId: i+1,
      positions: new Float32Array([i-1,-1,0,i,-1,0,i-1,1,0,i,1,0]),
      textureUv: new Float32Array([0,0,1,0,0,1,1,1])}])), new Uint16Array([1,0,3,2]), {modelRevision: 1})
    store.sync([{texture: tile}, {texture: second}], [])
    await until(() => requests === 2, 'Encoded downloads did not start')
    await until(() => { pump(); return renderer.pendingSubmission && renderer.pendingSubmission.drawn &&
      !renderer.submissions.uploading },
      'Terrain draw did not enter a GPU submission')
    const drawSubmission = renderer.pendingSubmission
    require(!drawSubmission.items.some(item => item.label === 'imagery texture'), 'Draw already uploaded an image')
    gl.clientWaitSync = () => gl.TIMEOUT_EXPIRED
    releaseDownloads()
    await until(() => store.cache.entries.size === 2, 'Encoded downloads did not complete')
    require(store.stats().decodedBytes === 0 && !store.preparations.size, 'Downloads ran the decoder ahead of uploads')
    await until(() => { pump(); return store.stats().decodedBytes >= 262144 },
      'Image decoding waited for an unrelated GPU draw receipt')
    for (let i = 0; i < 8; ++i) { pump(); await new Promise(resolve => setTimeout(resolve, 5)) }
    require(renderer.pendingSubmission === drawSubmission && !store.gpuReady(key) && !store.gpuReady(secondKey),
      'Pending GPU work published imagery without its own completion receipt')
    require(renderer.submissions.batches.length === 2 && renderer.submissions.batches[1].items.some(item => item.label === 'imagery texture'),
      'An unrelated draw blocked the admitted image upload')
    require(store.stats().decodedBytes <= 524288, 'Pending draw exceeded the upload plus decode input window')
    for (let i = 0; i < 8; ++i) { pump(); await new Promise(resolve => setTimeout(resolve, 5)) }
    require(store.stats().decodedBytes >= 262144 && store.stats().decodedBytes <= 524288,
      'GPU upload and one next decode did not stay bounded: ' + store.stats().decodedBytes)
    gl.clientWaitSync = clientWait
    await until(() => { pump(); return store.gpuReady(key) && store.gpuReady(secondKey) }, 'PNG images did not reach GPU')
    const entry = store.cache.entries.get(key), bytes = entry.byteSize, pixels = read(entry.value.texture)
    require(pixels.join(',') === '240,32,16,255,16,48,224,255', 'Decoded orientation/color changed: '+pixels)
    require(!entry.value.image && !entry.value.blob, 'GPU receipt retained CPU imagery inputs')
    require(bytes === 349524 && !store.cache.reservedBytes && store.inputBytes === 0,
      'GPU residency differs from actual payload')
    require(store.inputHighWaterBytes <= store.maximumInputBytes, 'Inputs exceeded the aggregate window')
    renderer.presentedTextures.set(key,tile); store.refreshProtection()
    renderer.presentedTextures.set(secondKey,second); store.refreshProtection()
    const fetched = requests
    lose.loseContext()
    await until(() => renderer.contextLost, 'Context loss event missing')
    lose.restoreContext()
    await until(() => !renderer.contextLost, 'Context did not restore')
    await until(() => { pump(); return store.gpuReady(key) && store.gpuReady(secondKey) }, 'Encoded images did not restore')
    const restored = store.cache.entries.get(key)
    require(read(restored.value.texture).join(',') === pixels.join(','), 'Restored pixels changed')
    require(!restored.value.image && !restored.value.blob && restored.byteSize === bytes && requests === fetched + 2,
      'Recovery did not re-enter source scheduling or retained CPU inputs')
    require(gl.getError() === gl.NO_ERROR, 'Encoded recovery produced a GL error')
    require(maximumDecodedBytes <= 524288, 'Decode/upload overlap exceeded two bitmaps')
    const replacementGroup = await verifyReplacementImageryGroup(sdk, blob)
    const imageResidency = await verifyImageResidency(sdk, blob)
    return {recovered: true, preparedDuringDraw: true, replacementGroup, imageResidency, requests, imageCount: 2, maximumDecodedBytes,
      inputHighWaterBytes: store.inputHighWaterBytes, maximumInputBytes: store.maximumInputBytes,
      encodedBytes: store.stats().encodedBytes, residentBytes: bytes, pixels}
  } finally {
    releaseDownloads()
    gl.clientWaitSync = clientWait
    if (frameBuffer) gl.deleteFramebuffer(frameBuffer)
    if (renderer) renderer.destroy()
    if (lose && !gl.isContextLost()) lose.loseContext()
    canvas.remove(); source.remove()
    if (renderer) await until(() => renderer.resourceLedger.bytes === 0,
      'Encoded fixture left resource ownership after teardown')
  }
}

// Four real images and their root fit the steady budget plus a serial workspace.
// Shared spare bytes may fund overlap, within one bounded replacement ceiling.
async function verifyReplacementImageryGroup(sdk, blob) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32
  const gl = canvas.getContext('webgl2', {antialias: false})
  const lose = gl.getExtension('WEBGL_lose_context')
  const gpu = 349524, pipeline = 1048576, budget = 5 * gpu + pipeline, peakBudget = budget + 4*gpu
  let renderer, requests = 0, peak = 0
  const require = (value, message) => { if (!value) throw Error(message) }
  const until = async (predicate, message) => {
    const deadline = performance.now() + 10000
    while (performance.now() < deadline) {
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw Error(message)
  }
  const tiles = Array.from({length: 4}, (_,i) => ({level: 1, matrix: 1, row: i >> 1, column: i & 1}))
  try {
    renderer = new sdk.webgl.TerraWebGlRenderer(canvas, {gl, requestResources() {}, mode: 'height', managedResources: true, scheduledImagery: true,
      createTextureStore: sdk.testTextures.createTextureStore,
      textureDescriptor: {kind: 'global-geodetic', tile_size: 256}, directTextureTargets: true,
      textureCacheBytes: budget, maximumTextureEntries: 32, maximumTextureRequests: 4,
      maximumResourceBytes: 32*1024*1024 + budget,
      urlForTile: () => 'https://fixture.invalid/serial.png',
      fetchTextures: async () => { ++requests; return new Response(blob, {headers: {'content-type': 'image/png'}}) }})
    const store = renderer.textures, ledger = renderer.resourceLedger, reserve = ledger.reserve
    ledger.reserve = function (...args) {
      const result = reserve.apply(this, args)
      const owners = this.stats().owners
      const bytes = ['imagery-gpu', 'imagery-production'].reduce((n, key) => {
        const owner = owners[key]; return n + (owner ? owner.reserved + owner.resident + owner.retired : 0)
      }, 0)
      peak = Math.max(peak, bytes)
      // Observe only: throwing after reserve succeeds would orphan the returned
      // lease before its caller receives ownership and mask a test assertion.
      return result
    }
    store.setSource(() => 'https://fixture.invalid/serial.png', [])
    require(store.targetCapacity() === 4, 'Replacement reserve still reduces feasible steady detail')
    const sharedLimit = ledger.maximumBytes
    renderer.setMeshFrame({sequence: 1, coverageComplete: true,
      projectionView: new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]), cameraPosition: [0,0,2]},
    tiles.map((texture,i) => ({resourceId:i+1, textureResourceId:4294967296 + (i+1), flags: 0, key: {level: 1, i: i & 1, j: i >> 1, k: 0}, fragment: 0,
      texture, origin: [0,0,0], firstIndex: 0, indexCount: 4, vertexCount: 4})),
    new Map(tiles.map((tile,i) => [i+1, {resourceId: i+1,
      positions: new Float32Array([tile.column-1,tile.row-1,0, tile.column,tile.row-1,0,
        tile.column-1,tile.row,0, tile.column,tile.row,0]),
      textureUv: new Float32Array([0,0,1,0,0,1,1,1])}])), new Uint16Array([1,0,3,2]), {modelRevision: 1})
    store.sync(tiles.map(texture => ({texture})), [])
    await until(() => {
      renderer.advanceResources(); renderer.render(false)
      require(peak <= peakBudget, 'Shared production crossed the bounded replacement peak')
      require(ledger.maximumBytes === sharedLimit, 'Replacement raised the shared resource limit')
      return tiles.every(tile => store.gpuReady([tile.level,tile.matrix,tile.row,tile.column].join('/')))
    }, 'Replacement group did not finish within its funded peak')
    require(requests === 5, 'Group redownloaded a root or sibling')
    require(store.pipelineBytes() === 0 && store.inputBytes === 0 && !store.cache.reservedBytes,
      'Completed group retained its shared workspace')
    require(store.cache.bytes === 5 * gpu && peak >= budget && peak <= peakBudget,
      'Group cost differs from its admitted destinations/peak')
    require(store.stats().replacementBorrowedBytes === 0, 'Completed group retained borrowed peak bytes')
    require(gl.getError() === gl.NO_ERROR, 'Replacement group produced a GL error')
    return {requests, peakBytes: peak, peakBudget, steadyBudget: budget, sharedLimit,
      gpuBytes: store.cache.bytes, serialWorkspaceBytes: pipeline}
  } finally {
    if (renderer) renderer.destroy()
    if (lose && !gl.isContextLost()) lose.loseContext()
    canvas.remove()
    if (renderer) await until(() => renderer.resourceLedger.bytes === 0, 'Replacement group retained ownership after teardown')
  }
}

// HTMLImage fallback uses real PNG decoding and the same GPU-only ownership.
// Its two admitted pixel slots must remain charged through a stalled receipt.
async function verifyImageResidency(sdk, blob) {
  const canvas=document.createElement('canvas'); canvas.width=canvas.height=32
  const gl=canvas.getContext('webgl2',{antialias:false}), lose=gl.getExtension('WEBGL_lose_context')
  const url=URL.createObjectURL(blob), images=[]
  canvas.createImage=()=>{const image=new Image(); images.push(image); return image}
  const tile={level:0,matrix:0,row:0,column:0}, key='0/0/0/0'
  const gpu=349524, pixels=262144, budget=gpu+pixels
  const clientWait=gl.clientWaitSync.bind(gl)
  let renderer, frameBuffer, before
  const require=(condition,message)=>{if(!condition)throw Error(message)}
  const until=async(predicate,message)=>{
    const deadline=performance.now()+10000
    while(performance.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5))}
    throw Error(message)
  }
  const read=texture=>{
    frameBuffer=gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER,frameBuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0)
    require(gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE,'Image framebuffer incomplete')
    const bottom=new Uint8Array(4),top=new Uint8Array(4)
    gl.readPixels(64,64,1,1,gl.RGBA,gl.UNSIGNED_BYTE,bottom)
    gl.readPixels(64,192,1,1,gl.RGBA,gl.UNSIGNED_BYTE,top)
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(frameBuffer);frameBuffer=null
    return [...bottom,...top]
  }
  try {
    renderer=new sdk.webgl.TerraWebGlRenderer(canvas,{gl,requestResources(){},mode:'height',managedResources:true,scheduledImagery:true,
      createTextureStore:sdk.testTextures.createTextureStore,fetchTextures:false,
      textureDescriptor:{kind:'global-geodetic',tile_size:256},prefetchTextureAncestors:false,
      textureCacheBytes:budget,maximumResourceBytes:32*1024*1024+budget,urlForTile:()=>url})
    const store=renderer.textures
    store.setSource(()=>url,[])
    renderer.setMeshFrame({sequence:1,coverageComplete:true,
      projectionView:new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),cameraPosition:[0,0,2]},
    [{resourceId:1, textureResourceId:4294967296 + (1), flags:0,key:{level:0,i:0,j:0,k:0},fragment:0,texture:tile,
      origin:[0,0,0],firstIndex:0,indexCount:4,vertexCount:4}],
    new Map([[1,{resourceId:1,positions:new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),
      textureUv:new Float32Array([0,0,1,0,0,1,1,1])}]]),new Uint16Array([1,0,3,2]),{modelRevision:1})
    store.sync([{texture:tile}],[])
    await until(()=>store.cache.has(key),'HTML image did not decode')
    require(store.stats().decodedBytes===pixels && store.pipelineBytes()===pixels,'Image decoder has no bounded pixel owner')
    gl.clientWaitSync=()=>gl.TIMEOUT_EXPIRED
    await until(()=>{renderer.advanceResources(); renderer.render(false);return renderer.pendingSubmission},'HTML image did not submit')
    for(let i=0;i<8;++i){renderer.advanceResources(); renderer.render(false);await new Promise(resolve=>setTimeout(resolve,5))}
    require(store.cache.entries.get(key).value.image===images[0] && !store.gpuReady(key),
      'Image pixels released before the GPU receipt')
    gl.clientWaitSync=clientWait
    await until(()=>{renderer.advanceResources(); renderer.render(false);return store.gpuReady(key)},'HTML image GPU receipt missing')
    const entry=store.cache.entries.get(key)
    before=read(entry.value.texture)
    require(before.join(',')==='240,32,16,255,16,48,224,255','HTML image orientation/color changed: '+before)
    require(!entry.value.image && entry.byteSize===gpu && !store.pipelineBytes() && !store.inputBytes,
      'Completed HTML image retained CPU ownership')
    require(images[0].getAttribute('src')==='','Completed HTML image retained its source')
    renderer.presentedTextures.set(key,tile)
    store.sync([],[]) // The recovery requirement is absent from the current plan.
    lose.loseContext(); await until(()=>renderer.contextLost,'Image context loss missing')
    lose.restoreContext(); await until(()=>!renderer.contextLost,'Image context restore missing')
    await until(()=>{renderer.advanceResources(); renderer.render(false);return store.gpuReady(key)},'Displayed HTML image did not re-enter scheduling')
    require(images.length===2 && read(store.cache.entries.get(key).value.texture).join(',')===before.join(','),
      'HTML image recovery missed the actual display or changed its pixels')
    require(!store.stats().decodedBytes && !store.inputBytes && !store.cache.reservedBytes,'Recovery retained CPU inputs')
    require(gl.getError()===gl.NO_ERROR,'HTML image recovery produced a GL error')
    return {recovered:true,requests:images.length,residentBytes:gpu,serialWorkspaceBytes:pixels,pixels:before}
  } finally {
    gl.clientWaitSync=clientWait
    if(frameBuffer)gl.deleteFramebuffer(frameBuffer)
    if(renderer)renderer.destroy()
    if(lose && !gl.isContextLost())lose.loseContext()
    URL.revokeObjectURL(url);canvas.remove()
    if(renderer)await until(()=>renderer.resourceLedger.bytes===0,'HTML image fixture retained resources after teardown')
  }
}
