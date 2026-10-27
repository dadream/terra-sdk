const assert = require('assert')
const {NetworkReplay} = require('./network_replay')
const {outcome} = require('./network_navigation')
const tick = async () => { for (let i=0;i<12;++i) await Promise.resolve() }

async function main() {
  let time=0, next=0
  const timers=new Map(), order=[]
  const network=new NetworkReplay({setTimer(fn,ms) { const id=++next;timers.set(id,{fn,at:time+ms});return id },
    clearTimer: id=>timers.delete(id), rule: (kind,key,attempt)=>({latencyMs:key.includes('slow')?100:10,
      chunkDelayMs:5,chunkBytes:2,fail:attempt===1&&key.includes('retry')})})
  const advance=async ms=>{time+=ms;for(const [id,timer] of [...timers]) if(timer.at<=time){timers.delete(id);timer.fn()};await tick()}
  const source=()=>({promise:Promise.resolve({statusCode:200,data:new ArrayBuffer(4)}),abort(){}})
  const request=path=>network.terrain(source,{url:'https://fixture.invalid/'+path})
  const slow=request('slow'),fast=request('fast')
  slow.promise.then(()=>order.push('slow'));fast.promise.then(()=>order.push('fast'))
  await advance(10);await advance(90);await Promise.all([slow.promise,fast.promise])
  assert.deepStrictEqual(order,['fast','slow']);assert.strictEqual(network.snapshot().reordered,1)
  const failure=request('retry');await advance(10);assert.strictEqual((await failure.promise).statusCode,503)
  const recovery=request('retry');await advance(10);assert.strictEqual((await recovery.promise).statusCode,200)
  assert.strictEqual(network.snapshot().retrySuccess,1)
  const cancelled=request('cancel'), rejected=assert.rejects(cancelled.promise,{name:'AbortError'})
  cancelled.abort();await rejected;assert.strictEqual(timers.size,0)
  let called=false
  const race=network.terrain(()=>{called=true;return source()},{url:'https://fixture.invalid/race'})
  const raceRejection=assert.rejects(race.promise,{name:'AbortError'})
  const [id,timer]=[...timers][0];timers.delete(id);timer.fn();race.abort()
  await raceRejection;assert.strictEqual(called,false,'Cancelled timer delivery started the source')

  const signal=new AbortController(), bytes=new Uint8Array([1,2,3,4,5])
  const fetch=network.imagery('https://fixture.invalid/image',{signal:signal.signal},bytes)
  await advance(10);const response=await fetch,reader=response.body.getReader()
  const first=reader.read();await advance(5);assert.deepStrictEqual((await first).value,new Uint8Array([1,2]))
  const pending=reader.read(), aborted=assert.rejects(pending,{name:'AbortError'})
  signal.abort();await aborted;reader.releaseLock()
  assert.strictEqual(network.snapshot().bodyBytes,2)
  assert.strictEqual(network.snapshot().active,0);assert.strictEqual(timers.size,0)

  const complete=network.imagery('https://fixture.invalid/whole',{},bytes)
  await advance(10);const all=(await complete).arrayBuffer()
  for(let i=0;i<4;++i)await advance(5)
  assert.deepStrictEqual(new Uint8Array(await all),bytes)
  const live=request('live'),stop=assert.rejects(live.promise,{name:'AbortError'})
  network.close();await stop
  assert.strictEqual(network.snapshot().active,0);assert.strictEqual(timers.size,0)
  assert.throws(()=>request('after-close'),/closed/)
  // Fault schedules do not depend on request arrival order.
  const a=new NetworkReplay(),b=new NetworkReplay()
  for(const key of ['/a','/b','/root/0']) for(const kind of ['terrain','imagery'])
    assert.deepStrictEqual(a.rule(kind,key,1),b.rule(kind,key,1))
  const state={quality:{covered:true,quiescent:true,cameraCurrent:true,planningComplete:true,
    terrainSelectionCurrent:true,state:'limited',limitedByTextureBudget:true,limitationReasons:['texture-budget'],
    targetMet:false,feasiblePixelError:1.4,resolvedMaxPixelError:1.4,targetPixelError:1.25,missingCount:0},
    textures:{targetMissing:0,active:0,queued:0},memory:{overBudgetBytes:0},selection:{presentedSequence:3}}
  const result={status:'failed',failedPhase:'settlement',settlement:{status:'timeout',durationMs:30000,
    pendingReasons:['imagery-target'],final:state,samples:[29000,29250,29500,29750].map(timeMs=>
      ({timeMs,pendingReasons:['imagery-target'],state}))}}
  assert.strictEqual(outcome(result),'capacity-limited')
  assert.strictEqual(result.status,'failed','Network acceptance must not rewrite strict precision failure')
  for(const change of [r=>r.failedPhase='preparation',r=>r.settlement.samples=[],
    r=>r.settlement.final.quality.resolvedMaxPixelError=1.5,r=>r.settlement.final.quality.limitedByTextureBudget=false,
    r=>r.settlement.final.textures.targetMissing=1,r=>r.settlement.final.memory.overBudgetBytes=1,
    r=>r.settlement.pendingReasons.push('ground-demand'),r=>r.settlement.samples[0].state.selection.presentedSequence=2]) {
    const invalid=JSON.parse(JSON.stringify(result));change(invalid);assert.strictEqual(outcome(invalid),null)
  }
  console.log('Keyed network faults, out-of-order delivery, retry, streamed bodies and cancellation cleanup passed')
}
main().catch(error=>{console.error(error);process.exitCode=1})
