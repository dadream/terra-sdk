const {invariant} = require('../core/terra_globe_common')

// Share the dependency boundary between host batching, RPC streaming and the
// client grant dispatcher. Every allocation kind must stop local advancement.
function imageryWorkKind(value) {
  return !value ? null : value.outputWork ? 'output' : value.referenceWork ? 'reference' :
    value.inputWork ? 'input' : null
}

// One native imagery allocation transaction (input, reference growth or output).
// The producer advertises its minimum before allocating; only its matching
// receipt can retire the grant. Reference growth may accept a larger batch.
class ImageryInputWorkspace {
  constructor(id) { this.id = id; this.bytes = 0; this.granted = 0; this.finished = false; this.active = false }
  reserve(bytes) {
    invariant(!this.finished && !this.active && Number.isSafeInteger(bytes) && bytes > 0 &&
      (!this.bytes || this.bytes === bytes), 'Invalid imagery input workspace')
    this.bytes = bytes
    if (!this.granted) return null
    invariant(bytes <= this.granted, 'Imagery input exceeds its grant')
    this.active = true
    return {release: () => { this.active = false; this.finished = true }}
  }
  grant(value) {
    if (value.id !== this.id || this.finished) return false
    invariant(this.bytes && !this.granted && Number.isSafeInteger(value.bytes) && value.bytes >= this.bytes,
      'Invalid imagery input grant')
    this.granted = value.bytes
    return true
  }
  quote() { return this.bytes && !this.granted && !this.finished ? {id:this.id, bytes:this.bytes} : null }
}

module.exports = {ImageryInputWorkspace, imageryWorkKind}
