const assert = require('assert')
const eye = require('../../sdk/js/camera/eye_view')
const {TerrainWalk} = require('../../sdk/js/camera/terrain_walk')
const {cameraSnapshot} = require('../../sdk/js/camera/terra_camera_snapshot')
const {TerraGlobeRuntime} = require('../../adapters/wasm/terra_globe_runtime')
const radius = 6378000
const initial = () => ({schema: eye.SCHEMA, mode: 'globe', position: {
  longitudeDegrees: 116.5623, latitudeDegrees: 40.74863, heightMeters: 510}, headingDegrees: 0, pitchDegrees: 0})
const sample = height => ({available: true, heightMeters: height, status: 'limited', reasons: ['no-data'], sampleSpacingMeters: 152})
const settle = async () => { for (let i = 0; i < 12; ++i) await Promise.resolve() }

function fixture() {
  let time = 0, serial = 0, view = initial(), cached = true
  const frames = new Map(), work = new Map(), requests = [], shown = []
  const runtime = {options: {}, manifest: {radius}, groundDemands: {options: {sampleSpacingMeters: 30}},
    getView: () => JSON.parse(JSON.stringify(view)),
    assignView: value => { view = JSON.parse(JSON.stringify(value)); shown.push(view) },
    previewCamera() {}, scheduleRefresh() {}, cameraEvent() {}, publishState() {}, frameClock: {now: () => time,
      request: (_, fn) => {frames.set(++serial, fn);return serial}, cancel: id => frames.delete(id),
      enqueueWork: (key, fn) => work.set(key, fn)},
    heightQueries: {peek: () => cached ? sample(500 - shown.length * 0.1) : null,
      query: (u, v, options) => new Promise((resolve, reject) => requests.push({u,v,...options,resolve,reject}))}}
  const walk = new TerrainWalk(runtime)
  return {runtime, walk, frames, requests, shown, cache: value => {cached = value},
    frame: async (ms = 16) => {time += ms; const jobs = [...frames.values(), ...work.values()];
      frames.clear();work.clear();jobs.forEach(fn => fn());await settle()}}
}

async function main() {
  for (const heading of [0,90,180,270]) for (const pitch of [-89,0,89]) {
    const view = eye.normalize({...initial(), headingDegrees: heading, pitchDegrees: pitch},radius)
    const value = cameraSnapshot({transform:'cylindrical',radius},eye.toCamera(view),{width:640,height:360,fovRadians:0.6})
    assert(Math.abs(Math.hypot(...value.cameraPosition)-radius-510)<1e-6)
    const lon = view.position.longitudeDegrees*Math.PI/180, lat=view.position.latitudeDegrees*Math.PI/180
    const up=[Math.sin(lon)*Math.cos(lat),Math.sin(lat),Math.cos(lon)*Math.cos(lat)]
    assert(value.cameraPosition.every((v,i)=>Math.abs(v-(radius+510)*up[i])<1e-6))
    assert.equal(value.nearPlane,0.1);assert.equal(value.distance,0)
    assert(Math.abs(eye.fromCamera(eye.toCamera(view)).pitchDegrees-pitch)<1e-12)
  }
  const crossed=eye.offset({...initial(),position:{longitudeDegrees:179.999999,latitudeDegrees:0,heightMeters:510},headingDegrees:90},10,0,radius)
  assert(crossed.position.longitudeDegrees<0,'Metre movement did not cross the longitude seam')
  const rotated=eye.offset({...initial(),headingDegrees:90,pitchDegrees:89},10,0,radius)
  assert(rotated.position.longitudeDegrees>initial().position.longitudeDegrees)
  assert.throws(()=>eye.normalize({...initial(),pitchDegrees:90},radius),/pitch/)
  const f=fixture(), done=f.walk.start({forwardMeters:4,speedMetersPerSecond:4})
  for(let i=0;i<100&&f.walk.active;i++)await f.frame()
  const result=await done
  assert.equal(result.distanceMeters,4);assert.equal(result.terrain.terrainStatus,'limited')
  assert(f.shown.length>50 && !f.frames.size)
  assert(f.shown[f.shown.length-1].position.heightMeters<f.shown[0].position.heightMeters,'Walking never descended with ground')
  assert(f.shown.every(v=>v.schema===eye.SCHEMA && v.pitchDegrees===0))

  const wait=fixture();wait.cache(false)
  const moving=wait.walk.start({forwardMeters:2,speedMetersPerSecond:2})
  await wait.frame()
  assert.equal(wait.walk.state().state,'terrain-wait');assert.equal(wait.shown.length,0)
  await wait.frame(2000);assert.equal(wait.requests.length,1)
  wait.cache(true);wait.requests[0].resolve(sample(500));await settle()
  assert(wait.walk.state().distanceMeters<0.04,'Waiting caused a large catch-up jump')
  await wait.frame(10000)
  assert(wait.walk.state().distanceMeters<0.14,'Display delay caused a large movement')
  for(let i=0;i<100&&wait.walk.active;i++)await wait.frame()
  await moving

  const absent=fixture();absent.cache(false)
  const unavailable=assert.rejects(absent.walk.start({rightMeters:2}),e=>e.code==='camera_walk_terrain_unavailable')
  await absent.frame();absent.requests[0].resolve({available:false,reasons:['no-data']});await unavailable
  assert.equal(absent.shown.length,0);assert.equal(absent.frames.size,0)

  const cancel=fixture();cancel.cache(false)
  const rejected=assert.rejects(cancel.walk.start({forwardMeters:1}),e=>e.code==='camera_walk_cancelled')
  await cancel.frame();cancel.walk.cancel()
  assert(cancel.requests[0].signal.aborted && cancel.walk.state().pending)
  cancel.requests[0].resolve(sample(2000));await rejected
  assert.equal(cancel.shown.length,0);assert(!cancel.walk.state().pending && !cancel.frames.size)

  const replaced=fixture();replaced.cache(false)
  const old=assert.rejects(replaced.walk.start({forwardMeters:1}),e=>e.code==='camera_walk_cancelled')
  await replaced.frame();const next=replaced.walk.start({rightMeters:1})
  await replaced.frame();assert.equal(replaced.requests.length,1)
  replaced.cache(true);replaced.requests[0].resolve(sample(500));await old;await settle()
  for(let i=0;i<100&&replaced.walk.active;i++)await replaced.frame()
  assert.equal((await next).distanceMeters,1)

  // Runtime look uses the eye model in both ordinary and pointer APIs.
  const runtime=Object.create(TerraGlobeRuntime.prototype)
  Object.assign(runtime,{camera:eye.toCamera(initial()),manifest:{transform:'cylindrical',radius},options:{},
    budget:{physicalWidth:640,physicalHeight:360,devicePixelRatio:1},fovRadians:0.6,
    cancelAnimation(){},previewCamera(){return true},scheduleInteractionRefresh(){}})
  runtime.panBy({xPixels:100,yPixels:20});runtime.orbitBy({headingDegrees:15,tiltDegrees:5})
  assert.deepStrictEqual(runtime.getView().position,initial().position,'Turning translated the eye')
  assert(runtime.getView().pitchDegrees>0)
  assert.throws(()=>runtime.zoomBy(2),/orbit view/)
  console.log('Fixed eye pose, metric walking, terrain waits, bounded steps, descent and cancellation receipts passed')
}
main().catch(e=>{console.error(e.stack);process.exitCode=1})
