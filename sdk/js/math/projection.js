const PLANES = [p => p[3]+p[0], p => p[3]-p[0], p => p[3]+p[1],
  p => p[3]-p[1], p => p[3]+p[2], p => p[3]-p[2]]
function dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2] }
function spectral(a, b) {
  const aa=dot(a,a), bb=dot(b,b), ab=dot(a,b)
  return Math.sqrt(Math.max(0,(aa+bb+Math.hypot(aa-bb,2*ab))/2))
}
function spectral2(a, b, c, d) {
  const aa=a*a+b*b, bb=c*c+d*d, ab=a*c+b*d
  return Math.sqrt(Math.max(0,(aa+bb+Math.hypot(aa-bb,2*ab))/2))
}
function transform(m,p) {
  const x=p[0],y=p[1],z=p[2]
  return [m[0]*x+m[1]*y+m[2]*z+m[3],m[4]*x+m[5]*y+m[6]*z+m[7],
    m[8]*x+m[9]*y+m[10]*z+m[11],m[12]*x+m[13]*y+m[14]*z+m[15]]
}

module.exports = {PLANES, dot, spectral, spectral2, transform}
