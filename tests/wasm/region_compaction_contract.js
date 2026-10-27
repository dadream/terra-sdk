const assert=require('assert'),fs=require('fs')
const loader=require('../../adapters/wasm/terra_wasm')
const {TerraAbi}=require('../../adapters/wasm/terra_abi')
function fixtures(file) {
  const b=fs.readFileSync(file);let p=8
  assert.strictEqual(b.subarray(0,8).toString(),'TERRARC1')
  const n=()=>{const v=b.readUInt32LE(p);p+=4;return v},cases=[]
  const count=n()
  for(let i=0;i<count;++i) {
    const length=n(),name=b.subarray(p,p+length).toString();p+=length
    const rows=n(),out=n(),input=b.subarray(p,p+rows*176);p+=rows*176
    const expected=b.subarray(p,p+out*176);p+=out*176
    cases.push({name,rows,out,input,expected})
  }
  assert.strictEqual(p,b.length);assert.strictEqual(cases.length,23);return cases
}
async function main() {
  const imports=loader.createTerraImports();let clock=0
  // The image's older Node can provide only Date.now resolution. Drive a
  // deterministic clock so the elapsed-window contract is not a timing race.
  imports.env.terra_monotonic_milliseconds=()=>++clock
  const instantiated=await WebAssembly.instantiate(fs.readFileSync(process.argv[2]),imports)
  const module=loader.initializeTerraInstance(instantiated,imports),abi=new TerraAbi(module)
  const info=abi.alloc(24),output=abi.alloc(256*176),owned=new Set()
  let comparisons=0
  try {
    for(const c of fixtures(process.argv[3]))for(const quantum of [1,64,4096]) {
      const input=c.rows?abi.alloc(c.input.length):0
      if(input)module.refreshMemory().bytes.set(c.input,input)
      let projected=0
      for(let i=0;i<c.rows;++i)if(c.input.readUInt32LE(i*176)&1)++projected
      const quote=module.call('test_region_quote',c.rows,projected)>>>0
      const task=module.call('test_region_create',input,c.rows,quote,quote?(quantum===64?2:1):0);owned.add(task)
      const step=(n=quantum,ms=0)=>{
        module.call('test_region_step',task,n,ms,info)
        const v=module.refreshMemory().dataView
        const r=Array.from({length:6},(_,i)=>v.getUint32(info+i*4,true))
        assert(r[1]<=n);assert(r[5]<10000000);return r
      }
      try {
        assert.strictEqual(module.call('test_region_admit',task),0)
        assert.strictEqual(module.call('test_region_read',task,0,1,output),-1)
        if(c.rows>=64&&quantum===4096) {
          const timed=step(1000000,1e-9)
          assert(timed[1]>0&&timed[1]<=64,'Elapsed time did not bound validation')
        }
        let progress=step()
        while(progress[0]===0)progress=step()
        if(quote) {
          assert.strictEqual(progress[0],1);assert.strictEqual(progress[3],quote)
          assert.strictEqual(module.call('test_region_admit',task),0)
          assert.strictEqual(step()[1],0)
          module.exports.memory.grow(1)
          if(quantum===64)assert.strictEqual(module.call('test_region_admit_reserved',task),1)
          else {module.call('test_region_unblock',task);assert.strictEqual(module.call('test_region_admit',task),1)}
          progress=step()
          assert.strictEqual(progress[2],quote)
          module.exports.memory.grow(1)
          while(progress[0]===2)progress=step()
        }
        assert.strictEqual(progress[0],3,c.name);assert.strictEqual(progress[4],c.out,c.name)
        for(let first=0;first<c.out;first+=256) {
          const count=module.call('test_region_read',task,first,256,output)
          assert.strictEqual(count,Math.min(256,c.out-first))
          const view=module.refreshMemory().dataView
          for(let i=0;i<count;++i) {
            const p=output+i*176,e=(first+i)*176,domain=c.expected.readUInt32LE(e+4)
            assert.strictEqual(view.getUint32(p,true),c.expected.readUInt32LE(e))
            assert.strictEqual(view.getUint32(p+4,true),domain)
            for(let j=0;j<21;++j) {
              const expected=c.expected.readDoubleLE(e+8+j*8),actual=view.getFloat64(p+8+j*8,true)
              const exact=domain!==0xffffffff||![4,6,10].includes(j)
              assert(exact?Object.is(actual,expected):actual===expected||Number.isFinite(actual)&&Number.isFinite(expected)&&Math.abs(actual-expected)<=Math.max(1e-11,Math.abs(expected)*1e-11),c.name+' field '+j)
            }
          }
        }
        assert.strictEqual(module.call('test_region_read',task,0,257,output),-1)
        module.call('test_region_cancel',task)
        assert.strictEqual(step()[0],4);assert.strictEqual(step()[2],0)
        assert.strictEqual(module.call('test_region_read',task,0,1,output),-1)
        ++comparisons
      }finally{module.call('test_region_destroy',task);owned.delete(task);abi.free(input)}
    }
    assert.strictEqual(module.call('test_region_handles'),0)
    console.log('Wasm production compaction core:',comparisons,'frozen/quanta cases, exact grants, memory growth, bounded output and cancellation passed')
  }finally{
    for(const task of owned)module.call('test_region_destroy',task)
    abi.free(output);abi.free(info);abi.destroy()
  }
  assert.strictEqual(abi.nativeAllocations.size,0)
}
main().catch(error=>{console.error(error);process.exitCode=1})
