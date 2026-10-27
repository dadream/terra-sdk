// Monotone piecewise-linear X with slopes 0.6 and 1.4; Y has slope 1.
// Reversed cell order puts the larger slope at each block's reference face.
module.exports = function measurementFixture(coupled = false) {
  const positions=[],uv=[],indices=[]
  for(let y=0;y<8;y++) for(const x of [1,0,3,2,5,4,7,6]) {
    for(const corners of [[[x,y],[x+1,y],[x,y+1]],[[x+1,y],[x+1,y+1],[x,y+1]]]) {
      const first=positions.length/3
      for(const [u,v] of corners) {
        // Opposing X/Y slopes make the component-wise derivative envelope
        // conservative even when an axis-aligned piecewise surface is exact.
        const shear = coupled ? Math.floor(u/2)*0.175+(u%2)*0.175-0.35 : 0
        positions.push(Math.floor(u/2)/4+(u%2)*0.075-0.5,v/8-0.5+shear,0)
        uv.push(u/8,v/8)
      }
      if(indices.length) indices.push(indices[indices.length-1],first)
      if(indices.length%2) indices.push(first)
      indices.push(first,first+2,first+1)
    }
  }
  return {positions:new Float32Array(positions),uv:new Float32Array(uv),indices:new Uint16Array(indices)}
}
