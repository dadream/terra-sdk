const assert = require('assert')
const {PartitionPublication} = require('../../adapters/webgl/partition_publication')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')

module.exports = function verifyDependencies() {
  const geometry = new Map(), images = new Set(['ready'])
  const publication = new PartitionPublication(id => geometry.get(id), id => images.has(id), draw => draw.group)
  const tile = column => ({level: 1, matrix: 1, row: 0, column})
  const draw = (id, cell, group) => ({geometryKey: id, texture: tile(cell), imageryClipCell: true,
    imageryTarget: tile(cell), group})
  const mesh = id => {const value = {partitions: new Map()}; geometry.set(id, value); return value}
  const a = mesh('generation1:a'), b = mesh('generation1:b'), c = mesh('generation1:c')
  const draws = [draw('generation1:a',0,'shared'), draw('generation1:b',0,'shared'),
    draw('generation1:a',1,'adjacent'), draw('generation1:c',2,'independent')]
  draws.forEach(d => images.add(key(d.imageryTarget)))
  publication.prepare(draws)
  a.partitions.set(key(tile(0)), {}); b.partitions.set(key(tile(0)), {})
  assert(!publication.advance(), 'A world group bypassed the remaining cells of its mesh footprint')
  c.partitions.set(key(tile(2)), {})
  images.delete(key(tile(2)))
  assert(!publication.advance(), 'A group published without its target image')
  images.add(key(tile(2)))
  assert(publication.advance() && publication.ready('independent'))
  assert(!publication.ready('shared') && !publication.ready('adjacent'))
  a.partitions.set(key(tile(1)), {})
  assert(publication.advance() && publication.ready('shared') && publication.ready('adjacent'))
  assert(!publication.advance(), 'An unchanged readiness state repeatedly woke display')
  publication.setHandoff([draw('generation1:a',3,'handoff')])
  publication.prepare([draw('generation1:a',4,'display')])
  assert(publication.wanted('generation1:a',key(tile(3))) && publication.wanted('generation1:a',key(tile(4))))
  assert(!publication.wanted('generation1:a',key(tile(0))), 'Visible mesh retained a superseded UV request')
  publication.setHandoff([])
  assert(!publication.wanted('generation1:a',key(tile(3))), 'Retired handoff kept its requests')
  publication.prepare([draw('generation2:a',0,'replacement')])
  assert(!publication.advance(), 'A retired generation satisfied its successor')
  mesh('generation2:a').partitions.set(key(tile(0)), {})
  publication.clear()
  assert(!publication.advance(), 'Disposed view dependencies survived cancellation or reset')
  assert.strictEqual(publication.pending.size, 0)
  assert.strictEqual(publication.meshes.size, 0)
  assert(!publication.wanted('generation1:a',key(tile(4))), 'Cancelled presentation retained demand')
  verifyReceiptScope()
}

function verifyReceiptScope() {
  const geometry=new Map(), images=new Set(), visited=[]
  const publication=new PartitionPublication(id=>{visited.push(id);return geometry.get(id)},
    id=>images.has(id),draw=>draw.group)
  const tile=column=>({level:9,matrix:9,row:0,column})
  const draws=Array.from({length:512},(_,i)=>({geometryKey:'mesh:'+i,group:'group:'+i,
    texture:tile(i),imageryTarget:tile(i),imageryClipCell:true}))
  for(const draw of draws)geometry.set(draw.geometryKey,{partitions:new Map([[key(draw.texture),{}]])})
  publication.prepare(draws)
  visited.length=0
  assert(!publication.needsAdvance())
  assert(!publication.advance())
  assert.strictEqual(visited.length,0,'Unchanged image waits rescanned terrain footprints')
  images.add(key(tile(271)))
  assert(publication.needsAdvance())
  visited.length=0
  assert(publication.advance()&&publication.ready('group:271'))
  assert.deepStrictEqual(visited,['mesh:271'],'One image receipt rescanned unrelated mesh footprints')
  assert.strictEqual(publication.pending.size,511)

  // A retained image wait is not permanent proof that its previous UV still
  // exists. Recheck the whole recovered group before acknowledging it.
  const target=draws[18],part=key(target.texture)
  geometry.get(target.geometryKey).partitions.delete(part)
  images.add(part)
  assert(!publication.advance()&&!publication.ready(target.group))
  images.delete(part)
  geometry.get(target.geometryKey).partitions.set(part,{})
  assert(publication.needsAdvance())
  assert(!publication.advance()&&!publication.ready(target.group))
  images.add(part)
  assert(publication.advance()&&publication.ready(target.group))

  // Display and producer share the same publication state after adoption.
  const adopted=new PartitionPublication(id=>geometry.get(id),id=>images.has(id),draw=>draw.group)
  adopted.adopt(publication)
  images.add(key(tile(19)))
  assert(adopted.needsAdvance()&&adopted.advance())
  assert(publication.ready('group:19')&&publication.states.get('group:19').ready)
  assert(!publication.needsAdvance(),'Consumed dependency receipt woke another scan')
}
