// Terrain uses clockwise front faces. These predicates only reject a positive
// orientation with a rounding margin; tangent/unknown geometry stays visible.
const MARGIN = 1e-6

function facingContext(matrix) {
  return [0,1,2,3].map(omit => {
    const columns = [0,1,2,3].filter(i => i !== omit)
    const [a,b,c] = [0,4,12].map(row => columns.map(i => matrix[row+i]))
    return (omit%2 ? -1 : 1) *
      (a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]))
  })
}

// det(UV) * cross(dP/du,dP/dv) is the oriented triangle normal.
// Its interval follows from the already stored derivative radii and position
// box. Dotting it with the projection's homogeneous eye also covers orthographic
// matrices. No normals array or per-camera triangle cache is retained.
function blockFacing(block, origin, context) {
  const c = context.facing, u = block.du, v = block.dv
  const ru = block.duRadius, rv = block.dvRadius
  if (!c || !block.winding || !ru || !rv) return 0
  let value = 0, radius = 0, magnitude = 0
  for (let i=0;i<3;++i) {
    const j=(i+1)%3,k=(i+2)%3,n=u[j]*v[k]-u[k]*v[j]
    const nr=Math.abs(u[j])*rv[k]+Math.abs(v[k])*ru[j]+ru[j]*rv[k]+
      Math.abs(u[k])*rv[j]+Math.abs(v[j])*ru[k]+ru[k]*rv[j]
    const p=c[i]-c[3]*(origin[i]+(block.minimum[i]+block.maximum[i])/2)
    const pr=Math.abs(c[3])*(block.maximum[i]-block.minimum[i])/2
    value+=n*p; magnitude+=Math.abs(n*p)
    radius+=Math.abs(n)*pr+Math.abs(p)*nr+nr*pr
  }
  value*=block.winding
  const limit=radius+MARGIN*(magnitude+radius)
  return value>limit ? 1 : value < -limit ? -1 : 0
}

function backFacing(clip) {
  const [a,b,c]=clip
  const x=b[0]-a[0],y=b[1]-a[1],w=b[3]-a[3]
  const u=c[0]-a[0],v=c[1]-a[1],z=c[3]-a[3]
  const p=a[0]*(y*z-w*v),q=a[1]*(w*u-x*z),r=a[3]*(x*v-y*u)
  // Homogeneous orientation is unchanged by near-plane clipping. Include a
  // vertex-scale allowance for the renderer's float projection arithmetic.
  const scale=Math.max(Math.abs(a[0]),Math.abs(b[0]),Math.abs(c[0])) *
    Math.max(Math.abs(a[1]),Math.abs(b[1]),Math.abs(c[1])) *
    Math.max(Math.abs(a[3]),Math.abs(b[3]),Math.abs(c[3]))
  return p+q+r > MARGIN*(Math.abs(p)+Math.abs(q)+Math.abs(r)+scale)
}

module.exports = {facingContext, blockFacing, backFacing}
