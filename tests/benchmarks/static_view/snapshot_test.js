'use strict'
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path')
const {digest}=require('../headless_scheduling/records'),{readSnapshot}=require('./snapshot')
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'terra-sdk-snapshot-')),file=path.join(folder,'inputs.json'),wasm=Buffer.from('fixture-wasm')
try {
  fs.mkdirSync(path.join(folder,'site'))
  const assets={'sdk.js':Buffer.from('browser'),'terra_worker.js':Buffer.from('worker'),'terra_sdk.wasm':wasm}
  for(const [name,data]of Object.entries(assets))fs.writeFileSync(path.join(folder,'site',name),data)
  fs.writeFileSync(file,JSON.stringify({commit:'fixture',sourceDiff:'',assets:Object.fromEntries(Object.entries(assets)
    .map(([name,data])=>[name,{bytes:data.length,sha256:digest(data)}]))}))
  assert.deepStrictEqual(readSnapshot(file,wasm).assets,assets)
  assert.throws(()=>readSnapshot(file,Buffer.from('another-wasm')),/same verified Wasm/)
  fs.writeFileSync(path.join(folder,'site/sdk.js'),'changed')
  assert.throws(()=>readSnapshot(file,wasm),/Changed SDK snapshot asset/)
} finally {fs.rmSync(folder,{recursive:true,force:true})}
console.log('Pinned SDK snapshots reject changed scripts and mixed Wasm before browser startup')
