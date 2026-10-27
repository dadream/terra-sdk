const assert=require('assert'),fs=require('fs'),path=require('path')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')
const {regionError}=require('../../sdk/js/terrain/terra_surface_plan')
const {REGION_BYTES,MeasurementRows,MeasurementLoans,MeasurementKernel,adoptMeasurementRows,
  borrowMeasurementRows,writeMeasurementRow,ownMeasurements,releaseMeasurements,validateMeasurementRows}=require('../../sdk/js/terrain/measurement_rows')

function make(rows,ledger) {
  const lease=ledger.reserve('test-measurement',rows.length*REGION_BYTES)
  assert(lease,'Fixture needs funded destination')
  const data=new Uint8Array(lease.bytes),view=new DataView(data.buffer)
  try {
    rows.forEach((row,i)=>writeMeasurementRow(row,view,i*REGION_BYTES))
    return adoptMeasurementRows(data,lease)
  }catch(error){lease.release();throw error}
}
function frozen() {
  const bytes=fs.readFileSync(path.join(__dirname,'../../testdata/miniprogram/golden/region_compaction_v1.bin'))
  let offset=8
  assert.strictEqual(bytes.toString('ascii',0,8),'TERRARC1')
  const u32=()=>{const n=bytes.readUInt32LE(offset);offset+=4;return n}
  const number=()=>{const n=bytes.readDoubleLE(offset);offset+=8;return n}
  const row=()=>{
    const flags=u32(),domain=u32(),n=Array.from({length:21},number)
    const r={uv:{minimumU:n[0],minimumV:n[1],maximumU:n[2],maximumV:n[3]},pixelsPerUv:n[4]}
    if(flags&1)r.projection=n.slice(5,14)
    if(flags&2)r.triangle=[n.slice(14,16),n.slice(16,18),n.slice(18,20)]
    if(flags&4)r.numeratorBound=n[20]
    if(domain!==0xffffffff)r.domain=domain
    return r
  }
  const count=u32(),result=[]
  for(let i=0;i<count;++i) {
    const length=u32(),name=bytes.toString('utf8',offset,offset+length);offset+=length
    const before=u32(),after=u32()
    result.push({name,rows:Array.from({length:before},row)})
    result.push({name:name+'/compact',rows:Array.from({length:after},row)})
  }
  assert.strictEqual(offset,bytes.byteLength)
  return result
}
module.exports=function verifyMeasurementRows() {
  const ledger=new ResourceLedger(),kernel=new MeasurementKernel(ledger)
  let queries=0
  try {
    const scenes=frozen()
    const uv={minimumU:0,minimumV:-0,maximumU:1,maximumV:1}
    scenes.push({name:'explicit-presence',rows:[{uv,pixelsPerUv:-0,domain:0},
      {uv,pixelsPerUv:128,projection:Array(9).fill(0),triangle:[[0,0],[1,0],[0,1]],domain:335},
      {uv,pixelsPerUv:100,projection:[0,8,0,0,0,4,1,0.5,0.25],numeratorBound:9}]})
    let seed=7021
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
    scenes.push({name:'finite-and-crossing-depths',rows:Array.from({length:128},(_,i)=>({uv,pixelsPerUv:Infinity,
      projection:Array.from({length:9},(_,j)=>j===6?i%4===0?0:i%4===1?-1:0.1+random():random()*20-10),
      triangle:[[random(),random()],[random(),random()],[random(),random()]]}))})
    for(const scene of scenes) {
      const owned=make(scene.rows,ledger),rows=owned.rows
      assert(rows instanceof MeasurementRows)
      assert.strictEqual(rows.length,scene.rows.length)
      try {
        for(let i=0;i<rows.length;++i) {
          const raw=scene.rows[i],b=raw.uv
          const cells=[b,{minimumU:b.minimumU,minimumV:b.minimumV,
            maximumU:(b.minimumU+b.maximumU)/2,maximumV:(b.minimumV+b.maximumV)/2},
          {minimumU:b.maximumU,minimumV:b.maximumV,maximumU:b.maximumU+1,maximumV:b.maximumV+1}]
          assert.strictEqual(rows.domain(i),raw.domain===undefined?0xffffffff:raw.domain)
          for(const cell of cells) {
            const a=kernel.error(rows,i,cell),e=regionError(raw,cell)
            assert(Object.is(a,e),scene.name+' row '+i+' density '+a+' != '+e)
            ++queries
          }
          assert(Object.is(kernel.error(rows,i),regionError(raw,b)))
        }
      }finally{owned.release()}
    }
    const raw={uv,pixelsPerUv:128,projection:[0,8,0,0,0,4,1,0.5,0.25],triangle:[[0,0],[1,0],[0,1]]}
    const owned=make([raw],ledger),rows=owned.rows
    const copy=new Uint8Array(REGION_BYTES);rows.copyTo(copy);validateMeasurementRows(copy)
    const snapshot=ownMeasurements([{regions:rows}]),loans=new MeasurementLoans()
    loans.replace(snapshot);owned.release();releaseMeasurements(snapshot)
    assert(rows.intersects(0,0,1,1));assert(!rows.intersects(1,1,2,2))
    const expected=kernel.error(rows,0,uv)
    Object.defineProperty(raw,'projection',{get(){throw new Error('Legacy row read')}})
    assert.strictEqual(kernel.error(rows,0,uv),expected,'Packed kernel re-entered original row objects')
    loans.clear();assert.throws(()=>rows.number(0,0),/retired/)
    assert.throws(()=>loans.replace([{regions:rows}]),/retired/)
    assert.strictEqual(ledger.bytes,576)
    // A cache may surrender an idle mirror; an active display/result loan is
    // protected. Its replacement uses the same shared ledger, without GC.
    const small=new ResourceLedger(REGION_BYTES),cached=make([{uv,pixelsPerUv:64}],small)
    let releaseCache
    releaseCache=borrowMeasurementRows(cached.rows,()=>releaseCache())
    assert.strictEqual(small.reserve('too-early',1),null)
    cached.release()
    const replacement=small.reserve('replacement',REGION_BYTES)
    assert(replacement);assert.throws(()=>cached.rows.flags(0),/retired/)
    replacement.release();assert.strictEqual(small.bytes,0)
    const empty=make([],ledger);assert.strictEqual(empty.rows.length,0);empty.release()
    assert.throws(()=>new MeasurementRows(),/owning/)
    const malformed=new Uint8Array(REGION_BYTES)
    new DataView(malformed.buffer).setUint32(168,8,true)
    const lease=ledger.reserve('invalid',REGION_BYTES)
    assert.throws(()=>adoptMeasurementRows(malformed,lease),/flags/)
    assert.strictEqual(lease.bytes,REGION_BYTES,'Invalid adoption stole the caller grant');lease.release()
    console.log('Packed measurement rows:',scenes.length,'frozen/edge datasets,',queries,'local errors, exact presence, loans and shared-ledger reclamation passed')
  }finally{kernel.close()}
  assert.strictEqual(ledger.bytes,0)
}
