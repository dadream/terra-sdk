#!/usr/bin/env node
'use strict'
const assert=require('assert'),fs=require('fs'),path=require('path'),{execFileSync}=require('child_process')
const {compareExecution,resourceReader}=require('../tests/benchmarks/headless_scheduling/execution_comparison')
const {digest}=require('../tests/benchmarks/headless_scheduling/records')

function main(argv=process.argv.slice(2)) {
  assert.strictEqual(argv.length,3,'Usage: analyze_scheduling_execution.js <wasm-report> <native-report> <new-output.json>')
  const root=path.resolve(__dirname,'..'),mount=path.join(root,'viewer_verify_output')
  execFileSync('mountpoint',['-q',mount])
  const [executionFile,referenceFile,output]=argv.map(file=>path.resolve(file))
  assert(output.startsWith(mount+path.sep)&&!fs.existsSync(output),'Output must be new and on the data mount')
  assert(fs.realpathSync(path.dirname(output)).startsWith(fs.realpathSync(mount)+path.sep),'Output leaves the data mount')
  const executionBytes=fs.readFileSync(executionFile),referenceBytes=fs.readFileSync(referenceFile)
  const execution=JSON.parse(executionBytes),reference=JSON.parse(referenceBytes)
  assert(execution.inputsUnchanged&&['collected','diagnostic'].includes(execution.status),'Incomplete execution evidence')
  assert.strictEqual(execution.reference.sha256,digest(referenceBytes),'Different Native reference')
  assert.deepStrictEqual(execution.cleanup,{activeRequests:0,liveSockets:0,networkRequests:0})
  for(const backend of execution.backends) {
    assert(backend.cleanup.ownerDestroyed&&backend.cleanup.ledgerBytes===0&&backend.cleanup.errors.length===0,
      'Execution owner has not closed')
    if(backend.backend==='worker')assert(backend.cleanup.workerTerminated)
  }
  const result=compareExecution(reference,execution,resourceReader(path.dirname(referenceFile)))
  result.provenance={execution:{file:path.relative(root,executionFile),sha256:digest(executionBytes),sourceSha256:execution.sourceSha256,
    wasmSha256:execution.wasmSha256},reference:{file:path.relative(root,referenceFile),sha256:digest(referenceBytes),
    sourceSha256:reference.sourceSha256,binarySha256:reference.binarySha256},
    analysisSha256:digest(Buffer.concat([fs.readFileSync(__filename),fs.readFileSync(path.join(root,
      'tests/benchmarks/headless_scheduling/execution_comparison.js'))]))}
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'})
  console.log(JSON.stringify({output,counts:result.counts,allProgressiveTargetsMatched:result.allProgressiveTargetsMatched,
    allFixedTargetsMatched:result.allFixedTargetsMatched}))
  if(result.rows.some(row=>row.classification==='unexplained'))process.exitCode=2
}
if(require.main===module)main()
module.exports={main}
