'use strict'
const fs=require('fs'),path=require('path'),crypto=require('crypto')
const http=require('http'),https=require('https')
const {maximumEncodedRecordBytes,isMissingTerrainRecord}=require('../../../sdk/js/terrain/terrain_record')
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
const assert=(value,message)=>{if(!value)throw new Error(message)}
const compareKeys=(a,b)=>{
  for(let i=0;i<4;++i)if(a.key[i]!==b.key[i])return a.key[i]-b.key[i]
  return 0
}
function datasetIdentity(pack) {
  return digest(Buffer.from(JSON.stringify({fixtureSha256:pack.fixtureSha256,
    manifestSha256:pack.manifestSha256||null,records:pack.records.map(({key,status,bytes,sha256})=>
      ({key,status,bytes,sha256})).sort(compareKeys)})))
}

class Records {
  constructor(root,output,config,options={}) {
    this.root=root;this.output=output;this.config=config;this.options=options
    this.records=new Map();this.used=new Set();this.sockets=new Set()
    this.network={requests:0,bytes:0,active:0};this.captureBytes=0
    this.fixture=path.join(root,'testdata/miniprogram/navigation_terrain')
    const catalogue=JSON.parse(fs.readFileSync(path.join(this.fixture,'terrain-records.json')))
    const bytes=fs.readFileSync(path.join(this.fixture,'terrain-records.bin'))
    assert(digest(bytes)===catalogue.sha256,'Terrain fixture hash mismatch')
    assert(catalogue.heightScale===config.heightScale,'Fixture height scale mismatch')
    this.fixtureSha256=catalogue.sha256
    for(const row of catalogue.records) this.records.set(row.key.join('/'),{...row,
      file:path.join(this.fixture,'terrain-records.bin'),origin:'fixture'})
    if(options.records) {
      const directory=path.dirname(path.resolve(options.records))
      const pack=JSON.parse(fs.readFileSync(options.records))
      assert(pack.schema==='terra.headless-records.v1'&&pack.fixtureSha256===catalogue.sha256,
        'Captured record pack identity mismatch')
      if(pack.datasetSha256)assert(datasetIdentity(pack)===pack.datasetSha256,'Captured dataset identity mismatch')
      this.manifest=pack.manifest;this.manifestSha256=pack.manifestSha256
      if(this.manifest)assert(digest(Buffer.from(JSON.stringify(this.manifest)))===this.manifestSha256,'Metadata hash mismatch')
      for(const row of pack.records) {
        assert([200,404].includes(row.status)&&row.key.length===4&&row.key.every(Number.isInteger)&&
          (row.status!==404||row.key[0]===2),'Invalid captured record')
        const file=row.file&&path.resolve(directory,row.file)
        assert(row.status===404||file.startsWith(directory+path.sep),'Captured path leaves its pack')
        if(row.status===200) {
          const bytes=fs.readFileSync(file)
          assert(bytes.length===row.bytes&&digest(bytes)===row.sha256,'Captured record hash mismatch')
        }
        const previous=this.records.get(row.key.join('/'))
        assert(!previous||previous.status===row.status&&previous.sha256===row.sha256,'Conflicting captured record')
        this.records.set(row.key.join('/'),{...row,file,offset:0,origin:'capture'})
      }
    }
    fs.mkdirSync(path.join(output,'records'),{recursive:true})
  }
  async request(url,maximumBytes,signal) {
    signal.throwIfAborted()
    assert(++this.network.requests<=20000,'Capture request limit reached')
    ++this.network.active
    let request,socket
    try {
      return await new Promise((resolve,reject)=>{
        const client=url.protocol==='http:'?http:https
        request=client.get(url,{agent:false,signal},response=>{
          const parts=[];let bytes=0
          response.on('data',part=>{
            bytes+=part.length
            if(bytes>maximumBytes)request.destroy(new Error('Capture response envelope exceeded'))
            else parts.push(part)
          })
          response.once('error',reject)
          response.once('end',()=>{
            this.network.bytes+=bytes
            resolve({status:response.statusCode,bytes:Buffer.concat(parts)})
          })
        })
        request.once('socket',value=>{
          socket=value;this.sockets.add(value);value.once('close',()=>this.sockets.delete(value))
        })
        request.setTimeout(10000,()=>request.destroy(new Error('Capture request timed out')))
        request.once('error',reject)
      })
    } finally {
      --this.network.active
      if(socket&&!socket.closed)await new Promise(resolve=>{socket.once('close',resolve);socket.destroy()})
      if(request)request.destroy()
    }
  }
  async connect(signal) {
    if(this.options.upstream) {
      this.upstream=new URL(this.options.upstream)
      assert(['http:','https:'].includes(this.upstream.protocol)&&!this.upstream.username&&!this.upstream.password&&
        !this.upstream.search&&!this.upstream.hash&&this.upstream.pathname==='/', 'Upstream must be an origin')
      const response=await this.request(new URL('/terra/v1/datasets/globe/manifest',this.upstream),1024*1024,signal)
      assert(response.status===200,'Terrain manifest unavailable')
      const manifest=JSON.parse(response.bytes)
      if(this.manifest)assert(digest(Buffer.from(JSON.stringify(manifest)))===this.manifestSha256,
        'Live metadata differs from the captured pack')
      this.manifest=manifest;this.manifestSha256=digest(Buffer.from(JSON.stringify(manifest)))
      this.validateManifest()
      const root=[...this.records.values()].find(row=>row.key[0]===1&&row.status===200)
      const live=await this.request(this.url(root.key),maximumEncodedRecordBytes(this.config.patchDimension,1),signal)
      assert(live.status===200&&digest(live.bytes)===root.sha256,'Live root differs from fixture')
    } else if(this.manifest)this.validateManifest()
  }
  validateManifest() {
    const m=this.manifest,c=this.config
    assert(m.dataset_id===c.datasetId&&m.transform.kind==='cylindrical'&&m.transform.radius===c.radiusMeters&&
      m.patch_dim===c.patchDimension&&m.height_scale===c.heightScale,'Terrain metadata differs from the case')
    // Terrain-only drivers do not claim imagery capability validation.
  }
  url(key) {
    const template=key[0]===1?this.manifest.endpoints.root:this.manifest.endpoints.detail
    assert(typeof template==='string','Missing terrain endpoint')
    const url=new URL(template.replace('{i}',key[1]).replace('{j}',key[2]).replace('{k}',key[3]),this.upstream)
    assert(url.origin===this.upstream.origin,'Terrain endpoint changed origin')
    return url
  }
  async serve(event,signal) {
    assert(event.type==='request'&&[1,2].includes(event.kind)&&Array.isArray(event.key)&&event.key.length===4&&
      event.key.every(Number.isInteger)&&event.key[0]>=0&&event.key.slice(1).every(v=>Math.abs(v)<=268435456),
      'Invalid native record request')
    const key=[event.kind,...event.key.slice(1)],identity=key.join('/')
    let row=this.records.get(identity)
    if(!row&&this.upstream) {
      const response=await this.request(this.url(key),maximumEncodedRecordBytes(this.config.patchDimension,event.kind),signal)
      const absent=response.status===404&&event.kind===2&&isMissingTerrainRecord(response.bytes)
      assert(response.status===200||absent,'Terrain HTTP failure: '+response.status)
      this.captureBytes+=response.bytes.length
      assert(this.captureBytes<=64*1024*1024,'Capture byte limit reached')
      row={key,status:absent?404:200,offset:0,bytes:absent?0:response.bytes.length,
        sha256:absent?null:digest(response.bytes),origin:'live'}
      if(!absent) {
        row.file=path.join(this.output,'records',key.join('_')+'.bin')
        fs.writeFileSync(row.file,response.bytes)
      }
      this.records.set(identity,row)
    }
    assert(row,'Uncaptured terrain record: '+identity)
    this.used.add(identity)
    if(row.status===404)return '404\n'
    // Verify every used encoded slice; fixture lookup never substitutes zero
    // residuals for an uncaptured key or an unsuccessful HTTP response.
    const handle=fs.openSync(row.file,'r'),bytes=Buffer.alloc(row.bytes)
    try {assert(fs.readSync(handle,bytes,0,bytes.length,row.offset)===bytes.length,'Incomplete terrain record')}
    finally {fs.closeSync(handle)}
    assert(digest(bytes)===row.sha256,'Used terrain record hash mismatch')
    return '200 '+JSON.stringify(row.file)+' '+row.offset+' '+row.bytes+'\n'
  }
  save() {
    const records=[]
    for(const row of this.records.values())if(row.origin!=='fixture') {
      const result={key:row.key,status:row.status,offset:0,bytes:row.bytes,sha256:row.sha256}
      if(row.status===200) {
        const target=path.join(this.output,'records',row.key.join('_')+'.bin')
        if(target!==row.file)fs.copyFileSync(row.file,target)
        result.file=path.relative(this.output,target)
      }
      records.push(result)
    }
    const pack={schema:'terra.headless-records.v1',fixtureSha256:this.fixtureSha256,manifest:this.manifest,
      manifestSha256:this.manifestSha256,used:[...this.used].sort(),records:records.sort(compareKeys)}
    pack.datasetSha256=datasetIdentity(pack)
    fs.writeFileSync(path.join(this.output,'records.json'),JSON.stringify(pack,null,2))
    return {fixtureSha256:this.fixtureSha256,manifestSha256:this.manifestSha256,
      datasetSha256:pack.datasetSha256,
      packSha256:digest(Buffer.from(JSON.stringify(pack))),usedRecords:this.used.size,supplementalRecords:records.length,
      sourcePolicy:this.upstream?'Explicit bounded capture; metadata and one live root verified; server has no atomic dataset version'
        :'Verified captured bytes only; uncaptured keys fail'}
  }
  async close() {
    await Promise.all([...this.sockets].map(socket=>new Promise(resolve=>{socket.once('close',resolve);socket.destroy()})))
    assert(this.network.active===0&&this.sockets.size===0,'Capture cleanup incomplete')
  }
}
module.exports={Records,digest,datasetIdentity}
