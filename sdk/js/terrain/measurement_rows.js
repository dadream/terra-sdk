const {invariant} = require('../core/terra_globe_common')
const {Cleanup} = require('../runtime/cleanup')

const REGION_BYTES = 176
const storage = new WeakMap(), token = {}

// Host evidence has one private backing owner. Metadata aliases cannot keep a
// retired ArrayBuffer alive; only explicit cache/result/display loans can.
class MeasurementRows {
  constructor(key, owner, length) {
    invariant(key === token, 'Measurement rows require an owning allocation')
    storage.set(this, owner)
    this.length = length
    Object.freeze(this)
  }
  number(index, column) {
    const owner = readOwner(this, index)
    invariant(Number.isInteger(column) && column >= 0 && column < 21, 'Invalid measurement column')
    return owner.view.getFloat64(index * REGION_BYTES + column * 8, true)
  }
  flags(index) { return readOwner(this,index).view.getUint32(index*REGION_BYTES+168,true) }
  domain(index) { return readOwner(this,index).view.getUint32(index*REGION_BYTES+172,true) }
  intersects(loU, loV, hiU, hiV) {
    const owner = readOwner(this), view = owner && owner.view
    for (let i=0;i<this.length;++i) {
      const o=i*REGION_BYTES
      if (view.getFloat64(o+16,true)>loU && view.getFloat64(o,true)<hiU &&
          view.getFloat64(o+24,true)>loV && view.getFloat64(o+8,true)<hiV) return true
    }
    return false
  }
  visitIntersections(cell,visit) {
    const owner=readOwner(this),view=owner&&owner.view
    for(let i=0;i<this.length;++i) {
      const o=i*REGION_BYTES,u0=view.getFloat64(o,true),v0=view.getFloat64(o+8,true),
        u1=view.getFloat64(o+16,true),v1=view.getFloat64(o+24,true)
      if(u1>cell.minimumU&&u0<cell.maximumU&&v1>cell.minimumV&&v0<cell.maximumV)visit(i,u0,v0,u1,v1)
    }
  }
  copyTo(output, offset=0, first=0, count=this.length-first) {
    invariant(output instanceof Uint8Array && Number.isSafeInteger(offset) && offset>=0 &&
      Number.isSafeInteger(first) && first>=0 && Number.isSafeInteger(count) && count>=0 &&
      first+count<=this.length && offset+count*REGION_BYTES<=output.byteLength, 'Invalid measurement copy range')
    const owner=readOwner(this)
    if(count)output.set(owner.data.subarray(first*REGION_BYTES,(first+count)*REGION_BYTES),offset)
  }
}
const EMPTY_ROWS = new MeasurementRows(token,null,0)
function readOwner(rows,index) {
  invariant(rows instanceof MeasurementRows, 'Packed measurement rows are required')
  const owner=storage.get(rows)
  invariant(!rows.length || owner && owner.data, 'Measurement evidence has retired')
  if(index!==undefined)invariant(Number.isSafeInteger(index)&&index>=0&&index<rows.length,'Invalid measurement row')
  return owner
}

// Consumes a full backing allocation and its already-issued credit. The caller
// surrenders wire aliases. No Wasm heap, hidden prefix or borrowed subview.
function adoptMeasurementRows(data, lease, onRelease) {
  invariant(data instanceof Uint8Array && data.buffer instanceof ArrayBuffer && data.byteOffset===0 &&
    data.byteLength===data.buffer.byteLength && data.byteLength%REGION_BYTES===0 &&
    lease && lease.active && lease.bytes===data.byteLength, 'Invalid funded measurement allocation')
  validateMeasurementRows(data)
  if(!data.byteLength){lease.release();return {rows:EMPTY_ROWS,release:()=>{}}}
  const owner={data,view:new DataView(data.buffer),lease,refs:1,consumers:1,caches:new Set(),onRelease}
  lease.mark('resident')
  lease.reclaimable=()=>owner.refs>0 && owner.consumers===0
  lease.reclaim=()=>{for(const remove of [...owner.caches])remove()}
  const rows=new MeasurementRows(token,owner,data.byteLength/REGION_BYTES)
  return {rows,release:releaseOwner(owner,false)}
}
function releaseOwner(owner,cache) {
  let active=true
  return ()=>{
    if(!active)return
    active=false
    --owner.refs
    if(!cache)--owner.consumers
    if(!owner.refs) {
      owner.data=owner.view=null
      owner.lease.release()
      const notify=owner.onRelease;owner.onRelease=null
      if(notify)notify()
    } else owner.lease.availabilityChanged()
  }
}
function borrowMeasurementRows(rows, removeCache) {
  const owner=readOwner(rows)
  if(!owner)return ()=>{}
  ++owner.refs
  const cached=typeof removeCache==='function'
  const reclaim=cached?()=>removeCache():null
  if(cached)owner.caches.add(reclaim)
  else ++owner.consumers
  const release=releaseOwner(owner,cached)
  return ()=>{if(cached)owner.caches.delete(reclaim);release()}
}
function measurementLease(rows){const owner=rows instanceof MeasurementRows?readOwner(rows):null;return owner&&owner.lease}

class MeasurementLoans {
  constructor(){this.owners=new Map()}
  replace(values) {
    const needed=new Map()
    for(const value of values) {
      const rows=value && value.regions,owner=rows instanceof MeasurementRows?readOwner(rows):null
      if(owner)needed.set(owner,rows)
    }
    const acquired=new Map()
    try {
      for(const [owner,rows] of needed)if(!this.owners.has(owner))acquired.set(owner,borrowMeasurementRows(rows))
    }catch(error){for(const release of acquired.values())release();throw error}
    for(const [owner,release] of this.owners)if(!needed.has(owner)){release();this.owners.delete(owner)}
    for(const [owner,release] of acquired)this.owners.set(owner,release)
  }
  clear(){for(const release of this.owners.values())release();this.owners.clear()}
}
const snapshots=new WeakMap()
function ownMeasurements(values) {
  invariant(!snapshots.has(values),'Measurement snapshot already owns a loan')
  const loans=new MeasurementLoans();loans.replace(values);snapshots.set(values,{loans,after:new Set()});return values
}
function releaseMeasurements(values) {
  const owned=values && snapshots.get(values)
  if(owned) {
    snapshots.delete(values)
    const cleanup=new Cleanup()
    for(const callback of owned.after)cleanup.run(callback)
    cleanup.run(()=>owned.loans.clear());cleanup.finish()
  }
}
function onMeasurementsReleased(values,callback) {
  const owned=values&&snapshots.get(values)
  if(owned)owned.after.add(callback)
}

// Same v4 schema as canonical Native input. Production calls this only after
// funding the destination; it does not allocate per-row arrays or projections.
function writeMeasurementRow(region,output,offset) {
  const view=output instanceof DataView?output:new DataView(output.buffer,output.byteOffset,output.byteLength)
  const p=region.projection,t=region.triangle,b=region.uv
  const flags=Number(Boolean(p))|Number(Boolean(t))<<1|Number(region.numeratorBound!==undefined)<<2
  invariant(!p||p.length===9,'Invalid projection transport matrix')
  invariant(!t||t.length===3&&t.every(point=>point.length===2),'Invalid projection transport triangle')
  const domain=region.domain===undefined?0xffffffff:region.domain
  invariant(Number.isInteger(domain)&&domain>=0&&domain<=0xffffffff,'Invalid measurement domain')
  view.setFloat64(offset,b.minimumU,true);view.setFloat64(offset+8,b.minimumV,true)
  view.setFloat64(offset+16,b.maximumU,true);view.setFloat64(offset+24,b.maximumV,true)
  view.setFloat64(offset+32,region.pixelsPerUv,true)
  for(let i=0;i<9;++i)view.setFloat64(offset+40+i*8,p?p[i]:0,true)
  for(let i=0;i<3;++i)for(let a=0;a<2;++a)view.setFloat64(offset+112+i*16+a*8,t?t[i][a]:0,true)
  view.setFloat64(offset+160,flags&4?region.numeratorBound:-1,true)
  view.setUint32(offset+168,flags,true);view.setUint32(offset+172,domain,true)
}
function validateMeasurementRows(data) {
  invariant(data instanceof Uint8Array && data.byteOffset===0 && data.byteLength===data.buffer.byteLength &&
    data.byteLength%REGION_BYTES===0,'Invalid measurement transport')
  const view=new DataView(data.buffer)
  for(let o=0;o<data.byteLength;o+=REGION_BYTES) {
    const flags=view.getUint32(o+168,true)
    invariant(flags<=7,'Invalid measurement transport flags')
    const bound=view.getFloat64(o+160,true)
    invariant(!(flags&1)||flags&2||flags&4&&bound>=0,'Invalid measurement support')
    for(let i=0;i<4;++i)invariant(Number.isFinite(view.getFloat64(o+i*8,true)),'Invalid measurement UV')
    invariant(view.getFloat64(o,true)<=view.getFloat64(o+16,true)&&view.getFloat64(o+8,true)<=view.getFloat64(o+24,true),'Invalid measurement UV range')
    const pixels=view.getFloat64(o+32,true)
    invariant(!Number.isNaN(pixels)&&pixels>=0,'Invalid measurement density')
    if(flags&1)for(let i=0;i<9;++i)invariant(Number.isFinite(view.getFloat64(o+40+i*8,true)),'Invalid measurement projection')
    if(flags&2)for(let i=0;i<6;++i)invariant(Number.isFinite(view.getFloat64(o+112+i*8,true)),'Invalid measurement triangle')
    invariant(!(flags&4)||Number.isFinite(bound)&&bound>=-1,'Invalid measurement numerator')
  }
}

// A single funded, non-reentrant clipping workspace. Dense host queries reuse
// it instead of materializing each row's triangle, matrix and clipped polygons.
class MeasurementKernel {
  constructor(ledger) {this.ledger=ledger;this.closed=false}
  allocate() {
    invariant(!this.closed,'Measurement kernel has closed')
    if(this.lease)return
    this.lease=this.ledger.reserve('imagery-measurement-kernel',576)
    if(!this.lease)throw Object.assign(new Error('Measurement kernel capacity is occupied'),{status:9})
    try {this.a=new Float64Array(24);this.b=new Float64Array(24);this.depths=new Float64Array(12);this.norms=new Float64Array(12)}
    catch(error){this.close();throw error}
    this.lease.mark('resident')
  }
  close(){this.closed=true;this.a=this.b=this.depths=this.norms=null;if(this.lease)this.lease.release();this.lease=null}
  error(rows,index,cell) {
    invariant(!this.closed,'Measurement kernel has closed')
    const view=readOwner(rows,index).view,o=index*REGION_BYTES,flags=view.getUint32(o+168,true)
    const density=view.getFloat64(o+32,true)
    if(!(flags&1))return density
    const u0=view.getFloat64(o,true),v0=view.getFloat64(o+8,true),u1=view.getFloat64(o+16,true),v1=view.getFloat64(o+24,true)
    const loU=cell?cell.minimumU:u0,loV=cell?cell.minimumV:v0,hiU=cell?cell.maximumU:u1,hiV=cell?cell.maximumV:v1
    const c0=view.getFloat64(o+40,true),c1=view.getFloat64(o+48,true),c2=view.getFloat64(o+56,true),
      c3=view.getFloat64(o+64,true),c4=view.getFloat64(o+72,true),c5=view.getFloat64(o+80,true),
      c6=view.getFloat64(o+88,true),c7=view.getFloat64(o+96,true),c8=view.getFloat64(o+104,true)
    const numerator=view.getFloat64(o+160,true)
    if(flags&4 && numerator>=0) {
      const a=Math.max(loU,u0),b=Math.min(hiU,u1),c=Math.max(loV,v0),d=Math.min(hiV,v1)
      if(a>=b||c>=d)return 0
      const w=c6+Math.min(c7*a,c7*b)+Math.min(c8*c,c8*d)
      return Math.min(density,w>0?numerator/(w*w):Infinity)
    }
    this.allocate()
    let points=this.a,scratch=this.b,count=3
    for(let i=0;i<6;++i)points[i]=view.getFloat64(o+112+i*8,true)
    for(let edge=0;edge<4&&count;++edge) {
      const axis=edge>>1,sign=edge%2?-1:1,bound=edge===0?loU:edge===1?hiU:edge===2?loV:hiV
      let next=0
      for(let i=0;i<count;++i) {
        const j=(i+1)%count,da=sign*(points[i*2+axis]-bound),db=sign*(points[j*2+axis]-bound)
        if(da>=0){scratch[next*2]=points[i*2];scratch[next*2+1]=points[i*2+1];++next}
        if((da<0)!==(db<0)) {
          const t=da/(da-db)
          scratch[next*2]=points[i*2]+t*(points[j*2]-points[i*2])
          scratch[next*2+1]=points[i*2+1]+t*(points[j*2+1]-points[i*2+1]);++next
        }
      }
      count=next;const old=points;points=scratch;scratch=old
    }
    let minimumW=Infinity,maximum=0,area=0
    for(let i=0;i<count;++i) {
      const u=points[i*2],v=points[i*2+1],x=c0+c1*u+c2*v,y=c3+c4*u+c5*v,w=c6+c7*u+c8*v
      minimumW=Math.min(minimumW,w)
      const a=c1*w-x*c7,b=c2*w-x*c8,d=c4*w-y*c7,e=c5*w-y*c8
      const aa=a*a+b*b,bb=d*d+e*e,ab=a*d+b*e
      const norm=Math.sqrt(Math.max(0,0.5*(aa+bb+Math.hypot(aa-bb,2*ab))))
      this.depths[i]=w;this.norms[i]=norm
      if(w>0)maximum=Math.max(maximum,norm/(w*w))
      if(i>1)area+=Math.abs((points[(i-1)*2]-points[0])*(v-points[1])-(points[(i-1)*2+1]-points[1])*(u-points[0]))
    }
    if(!area)return 0
    if(!(minimumW>0))return Infinity
    for(let i=0;i<count;++i)for(let j=i+1;j<count;++j) {
      const w=this.depths[i],n=this.norms[i],dw=this.depths[j]-w,dn=this.norms[j]-n
      if(dw===0||dn/dw<=0)continue
      const critical=2*(w-n*dw/dn)
      if(critical>Math.min(w,this.depths[j])&&critical<Math.max(w,this.depths[j])) {
        const t=(critical-w)/dw
        maximum=Math.max(maximum,(n+t*dn)/(critical*critical))
      }
    }
    return maximum
  }
}

module.exports={REGION_BYTES,MeasurementRows,EMPTY_ROWS,MeasurementLoans,MeasurementKernel,
  adoptMeasurementRows,borrowMeasurementRows,ownMeasurements,releaseMeasurements,onMeasurementsReleased,
  writeMeasurementRow,validateMeasurementRows,measurementLease}
