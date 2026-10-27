const {transform}=require('../../sdk/js/math/projection')

function clip(points,axis,boundary,greater) {
  const output=[]
  for(let i=0;i<points.length;++i) {
    const a=points[i],b=points[(i+1)%points.length]
    const da=(a[axis]-boundary)*(greater?1:-1),db=(b[axis]-boundary)*(greater?1:-1)
    if(da>=0)output.push(a)
    if((da<0)!==(db<0))output.push(a.map((v,j)=>v+(b[j]-v)*da/(da-db)))
  }
  return output
}

// Bound the actual coarse triangles inside a source-UV cell. A geographic
// sphere box is insufficient: the coverage mesh interpolates chords. These
// CPU-only bounds never change geometry, precision or request demand.
function* coverageCellBounds(model,cell) {
  if(!model||!model.faces||!model.positions||!model.uv)return null
  const minimum=[Infinity,Infinity,Infinity],maximum=[-Infinity,-Infinity,-Infinity]
  let polygons=[],count=0
  const margin=2**-20,b=cell.bounds
  for(let f=0;f<model.faces.length;f+=3) {
    if(f%96===0)yield
    const positions=model.positions,uv=model.uv,faces=model.faces
    let points=[faces[f],faces[f+1],faces[f+2]].map(id=>
      [uv[id*2],uv[id*2+1],positions[id*3],positions[id*3+1],positions[id*3+2]])
    points=clip(points,0,b.minimumU-margin,true)
    points=clip(points,0,b.maximumU+margin,false)
    points=clip(points,1,b.minimumV-margin,true)
    points=clip(points,1,b.maximumV+margin,false)
    if(points.length&&polygons) {
      count+=points.length
      if(count>64)polygons=null
      else polygons.push(points.map(point=>point.slice(2)))
    }
    for(const point of points)for(let axis=0;axis<3;++axis) {
      minimum[axis]=Math.min(minimum[axis],point[axis+2])
      maximum[axis]=Math.max(maximum[axis],point[axis+2])
    }
  }
  return {minimum,maximum,polygons}
}

function clipPlane(points,plane) {
  const output=[]
  for(let i=0;i<points.length;++i) {
    const a=points[i],b=points[(i+1)%points.length],da=plane(a),db=plane(b)
    if(da>=0)output.push(a)
    if((da<0)!==(db<0))output.push(a.map((v,j)=>v+(b[j]-v)*da/(da-db)))
  }
  return output
}

function coverageScissor(bounds,origin,matrix,width,height) {
  if(!bounds)return null
  if(bounds.minimum[0]===Infinity)return [0,0,0,0]
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity
  if(bounds.polygons) {
    // Clip each bounded coarse polygon in homogeneous coordinates. At high
    // tilt a world AABB often straddles the eye plane although its visible
    // image cell occupies only a few pixels; treating it as full-screen makes
    // hundreds of cached images shade the same viewport.
    for(const polygon of bounds.polygons) {
      let points=polygon.map(v=>transform(matrix,v.map((p,i)=>p+origin[i])))
      for(const plane of [p=>p[3]-1e-8,p=>p[3]+p[0],p=>p[3]-p[0],p=>p[3]+p[1],p=>p[3]-p[1]])
        points=clipPlane(points,plane)
      for(const p of points) {
        const x=p[0]/p[3],y=p[1]/p[3]
        if(!Number.isFinite(x)||!Number.isFinite(y))return null
        x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y)
      }
    }
    if(x0===Infinity)return [0,0,0,0]
  } else {
  for(let n=0;n<8;++n) {
    const p=transform(matrix,bounds.minimum.map((v,i)=>(n&(1<<i)?bounds.maximum[i]:v)+origin[i]))
    // A box crossing the eye plane has no finite projected rectangle. Keep
    // its original draw, including the near-ground and horizon cases.
    if(!p.every(Number.isFinite)||p[3]<=0)return null
    const x=p[0]/p[3],y=p[1]/p[3]
    x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y)
  }
  }
  const loX=Math.max(0,Math.floor((x0+1)*width/2)-2),loY=Math.max(0,Math.floor((y0+1)*height/2)-2)
  const hiX=Math.min(width,Math.ceil((x1+1)*width/2)+2),hiY=Math.min(height,Math.ceil((y1+1)*height/2)+2)
  return [loX,loY,Math.max(0,hiX-loX),Math.max(0,hiY-loY)]
}

module.exports={coverageCellBounds,coverageScissor}
