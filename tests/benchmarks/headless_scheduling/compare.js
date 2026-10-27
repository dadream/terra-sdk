'use strict'

function difference(a,b) {
  const first=new Set(a),second=new Set(b)
  if (first.size!==a.length || second.size!==b.length) throw new Error('Duplicate fragment identities')
  return {first:a.length,second:b.length,onlyFirst:a.filter(key=>!second.has(key)),onlySecond:b.filter(key=>!first.has(key))}
}
function compare(first,second) {
  if (first.id!==second.id || first.threshold!==second.threshold ||
      JSON.stringify([first.projection,first.view,first.position])!==JSON.stringify([second.projection,second.view,second.position]))
    throw new Error('Backend camera or precision inputs differ')
  const sets={all:difference(first.allKeys,second.allKeys),visible:difference(first.visibleKeys,second.visibleKeys)}
  return {id:first.id,firstStatus:first.status,secondStatus:second.status,
    bothReady:first.status==='ready'&&second.status==='ready',
    bothTargetsMet:first.targetMet===true&&second.targetMet===true,sets,
    sameSets:Object.values(sets).every(value=>!value.onlyFirst.length&&!value.onlySecond.length)}
}
function roundtrip(rows,poses) {
  const checks=[]
  for (let index=0;index<poses.length;++index) {
    const previous=poses.findIndex((p,i)=>i<index&&p.rangeMeters===poses[index].rangeMeters&&
      p.tiltDegrees===poses[index].tiltDegrees&&p.headingDegrees===poses[index].headingDegrees)
    if (previous<0 || !rows[index] || !rows[previous]) continue
    const a=rows[previous],b=rows[index]
    const sets={all:difference(a.allKeys,b.allKeys),visible:difference(a.visibleKeys,b.visibleKeys)}
    checks.push({first:a.id,second:b.id,sets,sameSets:Object.values(sets).every(s=>!s.onlyFirst.length&&!s.onlySecond.length)})
  }
  return checks
}
module.exports={compare,roundtrip,difference}
