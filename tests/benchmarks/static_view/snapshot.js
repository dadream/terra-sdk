'use strict'
const assert=require('assert'),fs=require('fs'),path=require('path')
const {digest}=require('../headless_scheduling/records')
function readSnapshot(file,wasm) {
  file=path.resolve(file)
  const bytes=fs.readFileSync(file),input=JSON.parse(bytes),assets={}
  for(const name of ['sdk.js','terra_worker.js','terra_sdk.wasm']) {
    const data=fs.readFileSync(path.join(path.dirname(file),'site',name)),expected=input.assets&&input.assets[name]
    assert(expected&&expected.sha256===digest(data)&&expected.bytes===data.length,'Changed SDK snapshot asset: '+name)
    assets[name]=data
  }
  assert.strictEqual(digest(assets['terra_sdk.wasm']),digest(wasm),'JS comparison requires the same verified Wasm')
  return {assets,provenance:{manifest:file,manifestSha256:digest(bytes),reportedCommit:input.commit,
    reportedSourceDiff:input.sourceDiff,assetHashes:Object.fromEntries(Object.entries(assets).map(([name,data])=>[name,digest(data)]))}}
}
module.exports={readSnapshot}
