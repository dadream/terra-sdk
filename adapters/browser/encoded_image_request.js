const {monotonicNow}=require('../../sdk/js/diagnostics/timing')

// Transport owns a bounded body only after its caller acquires an envelope.
// Local admission waits do not consume the network timeout.
function requestEncodedImage(request,url,encodedLimit,acquire) {
  const controller=new AbortController()
  let timedOut=false,waiting=null,timer=null,remainingMs=15000,startedAt=0
  const stopTimer=()=>{
    if(timer!==null){remainingMs=Math.max(0,remainingMs-(monotonicNow()-startedAt));clearTimeout(timer);timer=null}
  }
  const abort=()=>{stopTimer();controller.abort();if(waiting&&waiting.cancel)waiting.cancel()}
  const startTimer=()=>{startedAt=monotonicNow();timer=setTimeout(()=>{timedOut=true;abort()},remainingMs)}
  startTimer()
  const promise=Promise.resolve().then(()=>request(url,{signal:controller.signal})).then(async response=>{
    stopTimer()
    if(!response.ok) {
      if(response.body)await response.body.cancel().catch(()=>{})
      throw Object.assign(new Error(`Texture returned HTTP ${response.status}`),{status:response.status})
    }
    if(!response.body||typeof response.body.getReader!=='function')throw new Error('Texture response requires a readable body')
    try {
      if(controller.signal.aborted)throw new Error('Texture request cancelled')
      waiting=acquire();await waiting.promise;waiting=null
      if(controller.signal.aborted)throw new Error('Texture request cancelled')
      startTimer()
    }catch(error){await response.body.cancel().catch(()=>{});throw error}
    const reader=response.body.getReader(),chunks=[]
    let size=0,complete=false
    try {
      for(;;) {
        const next=await reader.read()
        if(controller.signal.aborted)throw Object.assign(new Error('Texture request cancelled'),{name:'AbortError'})
        if(next.done){complete=true;break}
        size+=next.value.byteLength
        if(size>encodedLimit)throw new Error('Encoded texture exceeds the bounded tile input')
        chunks.push(next.value)
      }
    }finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock()}
    return new Blob(chunks,{type:response.headers.get('content-type')||''})
  }).catch(error=>{if(timedOut)throw new Error('Texture image request timed out');throw error}).finally(stopTimer)
  return {promise,abort}
}
module.exports={requestEncodedImage}
