'use strict'
const assert=require('assert')
const installGeometry=require('./reference/geometry_payload')
const {FakeGl,FakeCanvas}=require('./support/webgl_fixture')

function verify(Renderer) {
  for(const interrupt of ['destroy','restore'])for(const retired of [false,true]) {
    const gl=new FakeGl(),renderer=new Renderer(new FakeCanvas(gl),{urlForTile:()=>''})
    const draw={resourceId:1,textureResourceId:4294967297,geometryKey:'mesh:1',vertexCount:3}
    const allocation=renderer.resourceLedger.reserve('partition-gpu',66);allocation.mark('resident')
    const buffer=gl.createBuffer(),position=gl.createBuffer()
    const geometry={key:'mesh:1',resourceId:1,positionBuffer:position,
      partitions:new Map([['cell',{byteSize:66,indexBuffer:buffer,allocation}]]),partitionBytes:66}
    installGeometry(renderer,draw,geometry);renderer.partitionBytes=66
    // A cancelled asynchronous producer still owns this immutable destination
    // until its terminal reply. Its GL handles cannot outlive renderer teardown.
    const release=renderer.geometry.retain('mesh:1')
    if(retired)renderer.geometry.delete('mesh:1')
    if(interrupt==='restore') {renderer.contextWasLost();renderer.contextWasRestored()}
    else renderer.destroy()
    release()
    assert.strictEqual(renderer.partitionBytes,0,'Retired geometry kept its partition accounting')
    assert.strictEqual(allocation.active,false,'Late geometry release orphaned a GPU partition lease')
    for(const handle of [buffer,position]) {
      const deletes=gl.calls.filter(c=>c.name==='deleteBuffer'&&c.args[0]===handle)
      assert.strictEqual(deletes.length,interrupt==='destroy'?1:0,
        'GPU handles were leaked, deleted twice or passed into a restored context')
    }
    if(interrupt==='restore')renderer.destroy()
    assert.strictEqual(renderer.resourceLedger.bytes,0,'Asynchronous reader failed to release its remaining ownership')
  }
}
if(require.main===module) {
  verify(require('../../adapters/webgl/terra_webgl_renderer').TerraWebGlRenderer)
  console.log('Retired geometry releases partition leases and GL handles across destroy/restore')
}
module.exports=verify
