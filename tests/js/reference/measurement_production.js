// Explicit JS oracle for synthetic scheduling fixtures. Real CBDAM/Wasm,
// Worker/Direct candidate and browser contracts use the default Native producer.
const surface=require('../../../sdk/js/terrain/terra_surface_plan')
const {refineMeasurements}=require('./measurement_refinement')
const {NativeMeasurementLoans}=require('../../../adapters/wasm/native_surface_measurement')
const {Cleanup}=require('../../../sdk/js/runtime/cleanup')

function managedRows(rows) {
  if(rows.borrow)return rows
  let references=0
  Object.defineProperties(rows,{
    borrow:{value(){++references;let active=true;return ()=>{if(active){active=false;--references}}}},
    references:{get:()=>references}
  })
  return rows
}
class ReferenceMeasurementProduction {
  constructor(){this.loans=new NativeMeasurementLoans();this.deferred=[]}
  *measure(draw,resource,context,options) {
    const value=options.previous?
      yield* refineMeasurements(resource.model,draw.origin,context,options.previous):
      yield* surface.surfaceMeasurements(resource.model,draw.origin,context,Boolean(options.boundsOnly),Boolean(options.tight))
    managedRows(value.regions)
    return value
  }
  defer(release){this.deferred.push(release)}
  settle(values) {
    const cleanup=new Cleanup();cleanup.run(()=>this.loans.replace(Array.from(values,value=>value&&value.regions)))
    for(const release of this.deferred.splice(0))cleanup.run(release)
    cleanup.finish()
  }
  stats(){return {producer:'test-reference'}}
  destroy(){this.closed=true;this.settle([])}
}
const measurementFactory=()=>new ReferenceMeasurementProduction()
module.exports={measurementFactory,managedRows}
