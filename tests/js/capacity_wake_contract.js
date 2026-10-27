const assert=require('assert')
module.exports=async({createRuntime,FakeAbi,settle})=>{
 for(const event of ['scratch','refund','eligibility','limit']) {
  const abi=new FakeAbi();abi.getRequests=()=>[]
  const {runtime}=await createRuntime({abi,canvas:{requestAnimationFrame:()=>1}})
  await settle(3)
  const ledger=runtime.resourceLedger,occupied=ledger.reserve('old-native-payload',64)
  const update=abi.updateStep.bind(abi),advance=abi.advanceTerrain.bind(abi)
  let publications=0,recoveries=0
  abi.updateStep=(...args)=>{
   if(++publications===1)throw Object.assign(new Error('unfunded production'),{status:9,requests:[],modelRevision:1})
   return update(...args)
  }
  abi.advanceTerrain=(...args)=>{
   ++recoveries
   const scratch=ledger.reserve('height-work',32);assert(scratch);scratch.release()
   if(event==='refund')occupied.release()
   if(event==='eligibility'){occupied.reclaimable=()=>true;occupied.reclaim=()=>occupied.release();occupied.availabilityChanged()}
   if(event==='limit')ledger.setLimit(ledger.maximumBytes+64)
   return advance(...args)
  }
  try {
   await runtime.refresh();await settle(10)
   assert.strictEqual(recoveries,1)
   if(event==='scratch') {
    assert.strictEqual(publications,1,'Unchanged coarsening woke physical production using its own scratch refund')
    assert(runtime.meshCapacityBlocked)
    occupied.release();await settle(10)
   }
   assert.strictEqual(publications,2,'Coarsening consumed a real capacity event: '+event)
   assert(!runtime.meshCapacityBlocked)
  } finally {occupied.release();runtime.destroy();assert.strictEqual(ledger.bytes,0)}
 }
 const abi=new FakeAbi();abi.getRequests=()=>[]
 const {runtime}=await createRuntime({abi,canvas:{requestAnimationFrame:()=>1}})
 await settle(3)
 const before=runtime.meshFrames.presented,occupied=runtime.resourceLedger.reserve('old-native-payload',64)
 const update=abi.updateStep.bind(abi),advance=abi.advanceTerrain.bind(abi)
 let publications=0,recoveries=0
 abi.updateStep=(...args)=>{
  if(++publications===1){occupied.release();throw Object.assign(new Error('late refusal'),{status:9,requests:[],modelRevision:1})}
  return update(...args)
 }
 abi.advanceTerrain=(...args)=>{++recoveries;return advance(...args)}
 try{
  await runtime.refresh()
  assert.strictEqual(runtime.meshFrames.presented,before)
  await settle(10)
  assert.strictEqual(recoveries,1)
  assert.strictEqual(publications,2,'An unchanged coarsening round consumed the real capacity refund')
  assert(!runtime.meshCapacityBlocked)
 }finally{occupied.release();runtime.destroy();assert.strictEqual(runtime.resourceLedger.bytes,0)}
 console.log('Capacity wakes: self refunds park; predecessor refunds, eligibility and limit changes resume publication')
}
