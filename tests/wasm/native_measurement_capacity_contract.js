const assert=require('assert')

// An oblique display can retain old published, current bounds and exact rows
// at once. Byte credit alone must not accept a working set that a hidden
// 4096-handle table refuses, restarting the entire projection forever.
module.exports=async function(abi,draw,context,planId) {
  const before=abi.imageryInputPayloadBytes(),rows=[],ids=new Set()
  const model=await abi.createNativeSurfaceModelTask(draw,{planId}).run()
  let loan
  try {
    for(let i=0;i<6144;++i) {
      const value=await abi.createNativeSurfaceMeasurementTask(model,context,
        {boundsOnly:true,viewRevision:1,sourceRevision:1}).run()
      rows.push(value.regions)
      const id=value.regions.state().handle.id
      assert(!ids.has(id),'Live measurement handles alias');ids.add(id)
    }
    loan=rows[0].borrow()
    for(const row of rows)row.close()
    assert(rows[0].state().handle.id,'Retiring other snapshots closed a borrowed measurement')
    loan();loan=null
    assert.throws(()=>rows[0].state(),/loan has ended/)
  } catch(error) {
    error.message+=' (retained measurements='+rows.length+', input bytes='+abi.imageryInputPayloadBytes()+')'
    throw error
  } finally {
    if(loan)loan()
    for(const row of rows)row.close()
    model.close();abi.observeImageryInput()
  }
  assert.strictEqual(abi.imageryInputPayloadBytes(),before,'Concurrent measurements retained input bytes')
  console.log('6144 simultaneous canonical measurements fit credited Web working sets and retire completely')
}
