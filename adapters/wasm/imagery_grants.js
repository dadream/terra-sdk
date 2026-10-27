const {invariant}=require('../../sdk/js/core/terra_globe_common')
const {imageryWorkKind}=require('../../sdk/js/resources/imagery_input_workspace')

// Both execution adapters retain a suspended producer while real reclamation
// runs. A grant lasts through its actual allocation receipt, including all
// cooperative turns; a capacity refusal never silently changes the policy.
async function runImageryGrants(owner,message,request,interrupted,release) {
  let result
  try {
    result=await request(message)
    while(!interrupted()&&imageryWorkKind(result)) {
      const kind=imageryWorkKind(result),quote=result[kind+'Work']
      const budget=owner[kind==='output'?'imageryOutputBudget':
        kind==='reference'?'imageryReferenceBudget':'imageryInputBudget']
      invariant(budget,'Imagery production requires a shared ledger')
      invariant(Number.isSafeInteger(quote.id)&&quote.id>0&&
        Number.isSafeInteger(quote.bytes)&&quote.bytes>0,'Invalid imagery work quote')
      invariant(quote.preferredBytes===undefined||kind==='input'&&
        Number.isSafeInteger(quote.preferredBytes)&&quote.preferredBytes>=quote.bytes,
      'Invalid preferred imagery input quote')
      const previous=result;result=null
      try {
        result=await budget.tryRun(quote.bytes,bytes=>interrupted()?{superseded:true}:
          request({...message,stream:true,[kind+'Grant']:{id:quote.id,bytes}}),
        kind==='reference'?Math.max(quote.bytes,65536):quote.preferredBytes||quote.bytes)
      } finally {release(previous.measurements)}
    }
    if(interrupted()){if(result)release(result.measurements);return {superseded:true}}
    return result
  } catch(error){if(result)release(result.measurements);throw error}
}

// Returning from a CPU slice does not end an unfinished grant. The host RPC
// pump and the Direct adapter use the same receipt predicate before refunding.
function finishImageryGrant(owner,message,value) {
  const pool=owner.measurementBatch&&owner.measurementBatch.pool
  if(message.inputGrant&&pool&&pool.id===message.inputGrant.id) {
    // The grant belongs to this streamed operation, not its individual CPU
    // slices or an interleaved control request. It remains charged while the
    // worker yields locally. Returning a quote/result must close permission
    // before the client can reconcile the actual native ownership receipt.
    const continuing=message.stream&&!message.cancelled&&owner.measurementInputWorkspace===pool&&
      value&&!value.superseded&&!value.candidateReady&&!imageryWorkKind(value)&&
      (value.pending||value.continuation)
    if(!continuing)owner.finishMeasurementGrant()
  }
  return Boolean(message.inputGrant&&owner.inputReceipted(message.inputGrant.id)||
    message.referenceGrant&&(!owner.imageryReferenceWorkspace||
      owner.imageryReferenceWorkspace.id!==message.referenceGrant.id||owner.imageryReferenceWorkspace.finished)||
    message.outputGrant&&(!owner.imageryOutputWorkspace||
      owner.imageryOutputWorkspace.id!==message.outputGrant.id||owner.imageryOutputWorkspace.finished))
}

module.exports={runImageryGrants,finishImageryGrant}
