const assert = require('assert')
const {PartitionGroups} = require('../../adapters/webgl/partition_groups')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ownPayload} = require('../../sdk/js/resources/mesh_ownership')
const {ImageryPresentation} = require('../../sdk/js/imagery/terra_imagery_presentation')
const {textureKeyString:key} = require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile} = require('../../sdk/js/imagery/terra_texture_tiles')
const {imageryCandidate,imageryCandidateWork} = require('../../adapters/webgl/imagery_candidate')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')

const flush = async () => { for(let i=0;i<10;++i)await Promise.resolve() }

module.exports = async function verifyCandidateWork() {
  const root={level:0,matrix:1,row:0,column:0}, children=new Map()
  for(let row=0;row<2;++row)for(let column=0;column<2;++column) {
    const tile=descendantTextureTile(root,1,row,column);children.set(key(tile),tile)
  }
  for(const outcome of ['complete','park','reclaim','cancel','source','quota','pause','input']) {
    const ledger=new ResourceLedger(1024*1024), calls=[],hull=[[0,0],[1,0],[1,1],[0,1]]
    const resource=ownPayload({positions:new Float32Array(9),textureUv:new Float32Array(6)},ledger.reserve('source',60),60)
    const cacheInput=resource.ownership.hold()
    const geometry={key:'mesh:1',resourceId:1,resource,model:{hull},partitions:new Map()}
    const owner={value:geometry}, entries=new Map([[geometry.key,owner]])
    let geometryLoans=0,imageLoans=0,wakes=0,finishPrice
    const assets=new Map([[key(root),{value:{texture:{}}}]])
    const inputs=Array.from(children.values(),texture=>({geometryKey:geometry.key,resourceId:1,textureResourceId:101,
      texture,sourceTexture:root,origin:[0,0,0]}))
    const store={generation:1,failed:new Set(),desired:new Map(children),targetDesired:new Map(children),
      retainedTargets:new Map(),coverageKeys:new Set([key(root)]),currentRoots:new Map([[key(root),root]]),
      availableKeys:new Set([key(root)]),admissionBlocked:new Set(),directTargets:true,
      resourceGroups:()=>[[key(root),children]],requiresResident:()=>true,gpuReady:id=>assets.has(id),
      cache:{entries:assets,has:id=>assets.has(id),retain:id=>{
        if(!assets.has(id))return null
        ++imageLoans;let open=true;return ()=>{if(open){open=false;--imageLoans}}
      }}}
    const r={resourceLedger:ledger,options:{imageryPixelError:1.25,createPartitionGroupPlanTask:rows=>{
      calls.push(rows)
      let cancel
      return {promise:new Promise(resolve=>{
        finishPrice=()=>resolve(new Map(rows.map(row=>[row.geometry.key,row.cells.map(cell=>({key:cell.key,bytes:6}))])))
        cancel=()=>resolve(null)
      }),cancel:()=>cancel()}
    }},current:{frame:{sequence:1},imageryPlan:{quality:{planningComplete:true}}},
      partitionGeneration:0,geometryPinnedKeys:new Set([geometry.key]),partitionUploads:[],partitionQueue:[],
      partitionCapacityBytes:65536,partitionBytes:0,partitionCpuBytes:0,partitionReservedBytes:0,
      cameraVersion:1,plannedCameraVersion:1,presentedTextures:new Map([[key(root),root]]),presentationBridges:[],
      presentation:new ImageryPresentation(),renderDraws:inputs,textures:store,
      geometry:{entries,get:id=>(entries.get(id)||{}).value,retain:id=>{
        assert(entries.has(id));++geometryLoans;let open=true;return ()=>{if(open){open=false;--geometryLoans}}
      }},
      measureDraw:()=>({visible:true,hull,regions:[{uv:{minimumU:0,maximumU:0.1,minimumV:0,maximumV:0.1}}]}),
      measureTextureDraw:()=>4,partitionCell:draw=>({key:key(draw.texture),sourceUv:true,bounds:{minimumU:0,maximumU:1,minimumV:0,maximumV:1}}),
      prunePartitions(){},requestResources(){++wakes},requestPartitionSet(){},onDiagnostic(kind,detail){throw new Error(kind+':'+detail.message)}}
    const groups=new PartitionGroups(r)
    try {
      // Pricing contains the entire fixed UV footprint despite a tiny ROI.
      const full=imageryCandidate(r,children)
      assert.strictEqual(new Set(full.map(d=>key(d.texture))).size,4,'UV quote omitted a later-visible part of the same immutable mesh')
      const work=new CooperativeTask(imageryCandidateWork(r,children),2)
      let turns=0,result
      do {
        result=work.step();++turns
        ++r.cameraVersion;r.measureDraw=()=>{throw new Error('pricing borrowed projected rows')}
      }while(!result.done)
      assert(turns>8,'A complete canonical selection monopolized one work turn')
      assert.deepStrictEqual(result.value,full)
      entries.delete(geometry.key)
      assert.strictEqual(groups.prepareImagery(children,null),'waiting')
      assert(!groups.current&&!groups.refused.size,'Missing GPU inputs became a capacity refusal or owned work')
      assert.strictEqual(groups.pricing.footprintSelections||0,0,'Missing GPU inputs restarted footprint selection')
      assert.strictEqual(ledger.bytes,60,'Input waiting allocated preparation metadata')
      entries.set(geometry.key,owner)
      let bridgeReads=0
      if(outcome==='complete')Object.defineProperty(r,'presentationBridges',{get:()=>{
        assert.strictEqual(++bridgeReads,1,'Paused selection reread a live presentation bridge after its snapshot')
        return []
      }})
      assert.strictEqual(groups.prepareImagery(children,null),'waiting')
      assert.strictEqual(calls.length,0,'Request admission synchronously computed the complete display footprint')
      assert(groups.current.selection&&wakes)
      groups.current.selection.maximumSteps=2
      if(outcome==='input')entries.delete(geometry.key)
      groups.advanceSelection()
      resource.ownership.retire()
      assert(ledger.bytes>=60,'The first paused selector lost its immutable source')
      if(['complete','park','reclaim'].includes(outcome)) {
        for(let n=0;n<1000&&groups.current&&groups.current.selection;++n) {
          ++r.cameraVersion;r.renderDraws=r.renderDraws.map(d=>({...d}))
          groups.advanceSelection();await flush()
        }
        assert.strictEqual(calls.length,1,'Equivalent camera/source copies restarted the selection or UV pricing')
        assert.strictEqual(calls[0][0].cells.length,4)
        if(outcome!=='complete')ledger.setLimit(ledger.bytes+4*6+6-1)
        finishPrice();await flush()
        if(outcome==='complete')assert(groups.current&&groups.current.pool,'Complete UV output did not receive its original shared credit')
        else {
          assert(!groups.current&&groups.quotes.size===1,'A known quote was discarded on destination refusal')
          const quote=groups.quotes.values().next().value
          assert(quote.metadata.disposable&&geometryLoans===0&&imageLoans===0,'A parked quote retained payload owners')
          assert([...quote.rows.values()].every(row=>!row.geometry&&!row.owner&&!row.partitions))
          assert.strictEqual(groups.prepareImagery(children,null),'blocked')
          if(outcome==='park') {
            ledger.setLimit(ledger.maximumBytes+1)
            assert.strictEqual(groups.prepareImagery(children,null),'ready','An affordable destination required a larger cold selection workspace')
            assert.strictEqual(calls.length,1,'One-byte capacity recovery repeated immutable UV pricing')
          } else {
            const other=ledger.reserve('real-producer',ledger.maximumBytes-60)
            assert(other&&groups.quotes.size===0,'A rejected quote blocked another producer')
            other.release()
          }
        }
        if(outcome==='complete')assert.strictEqual(groups.prepareImagery(children,null),'ready')
      } else if(outcome==='input') {
        await flush()
        assert(!groups.current&&!groups.refused.size,'A source disappearing before its first borrow became a capacity refusal')
        const selections=groups.pricing.footprintSelections
        assert.strictEqual(groups.prepareImagery(children,null),'waiting')
        assert.strictEqual(groups.pricing.footprintSelections,selections,'Missing input wait polled another selector')
        entries.set(geometry.key,owner)
        assert.strictEqual(groups.prepareImagery(children,null),'waiting')
        for(let n=0;n<1000&&groups.current&&groups.current.selection;++n){groups.advanceSelection();await flush()}
        assert.strictEqual(calls.length,1,'Input arrival did not recover without a camera/capacity change')
        finishPrice();await flush()
        assert(groups.current&&groups.current.pool,'Recovered input did not fund its complete output')
      } else if(outcome==='quota') {
        groups.current.metadata.resize(groups.current.metadataUsed)
        ledger.setLimit(ledger.bytes)
        for(let n=0;n<1000&&groups.current;++n){groups.advanceSelection();await flush()}
        assert(!groups.current,'A refused selector kept ownership or spun on its own refund')
        assert.strictEqual(calls.length,0)
      } else {
        if(outcome==='source')++store.generation
        else if(outcome==='pause')r.paused=true
        else groups.clear()
        groups.advanceSelection();await flush()
        assert(!groups.current,'Cancelled or obsolete selection survived its completion receipt')
        assert.strictEqual(calls.length,0)
      }
    } finally {groups.clear();await flush();resource.ownership.retire();cacheInput()}
    assert.strictEqual(geometryLoans,0);assert.strictEqual(imageLoans,0)
    assert.strictEqual(ledger.bytes,0,'Finished candidate preparation retained source/workspace ownership')
  }
  console.log('World UV candidate: bounded selection, complete immutable footprints, camera continuity, actual quota and cancellation passed')
}
