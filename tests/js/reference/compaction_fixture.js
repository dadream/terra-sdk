function grid(dimension, mode = 'uniform', duplicates = false, shuffled = false) {
  const regions = []
  let area = 0
  for (let y=0;y<dimension;++y) for(let x=0;x<dimension;++x) {
    if(mode==='hole' && x>=dimension/3 && x<2*dimension/3 && y>=dimension/3 && y<2*dimension/3)continue
    const gap=mode==='separated'?2:1,u=x*gap/dimension,v=y*gap/dimension,d=1/dimension
    const points=[[u,v],[u+d,v],[u+d,v+d],[u,v+d]]
    for(const indices of [[0,1,2],[0,2,3]]) {
      const triangle=indices.map(i=>points[i])
      const projection=mode==='varying'?[0,80+(x%3)*17,0,0,0,70+(y%5)*11,1,x/dimension,y/dimension]:[0,128,0,0,0,128,1,0,0]
      const uv={minimumU:u,minimumV:v,maximumU:u+d,maximumV:v+d}
      regions.push({triangle,projection,pixelsPerUv:1024,uv})
      area+=d*d/2
      if(duplicates && regions.length%7===0)regions.push({triangle:[triangle[2],triangle[0],triangle[1]],projection:projection.slice(),pixelsPerUv:2048,uv:{...uv}})
    }
  }
  if(shuffled) {
    let seed=918273
    for(let i=regions.length-1;i>0;--i) {
      seed=(Math.imul(seed,1664525)+1013904223)>>>0
      const j=seed%(i+1),value=regions[i];regions[i]=regions[j];regions[j]=value
    }
  }
  return {regions,area}
}
module.exports={grid}
