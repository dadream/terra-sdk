// Synchronous teardown drains independent owners even when one callback fails.
// Async producers still require their own termination receipt before refunds.
class Cleanup {
  constructor(){this.failed=false;this.errors=0}
  capture(error) {
    ++this.errors
    if(!this.failed){this.failed=true;this.error=error}
    else if(this.error&&typeof this.error==='object'&&this.error!==error) {
      try {if(!('cleanupError' in this.error))this.error.cleanupError=error}catch(ignored){}
    }
  }
  run(action){try{return action()}catch(error){this.capture(error)}}
  finish(){if(this.failed)throw this.error}
}

function cleanupAfterError(error,action) {
  const cleanup=new Cleanup()
  cleanup.capture(error);cleanup.run(action);cleanup.finish()
}

module.exports={Cleanup,cleanupAfterError}
