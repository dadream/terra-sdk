'use strict'

function install({TerraAbi}, {TerrainWorkerHost}) {
  const handle = TerrainWorkerHost.prototype.handle
  TerrainWorkerHost.prototype.handle = function (message) {
    if (message.type === 'call' && message.method === 'meshResidencyDiagnostic')
      return this.abi.meshResidencyDiagnostic()
    return handle.call(this, message)
  }
  TerraAbi.prototype.meshResidencyDiagnostic = function () {
    const words = 20, capacity = 64, pointer = this.alloc(words * capacity * 4)
    const rows = [], textures = new Map()
    let after = 0, positionBytes = 0
    try {
      for (;;) {
        const count = this.module.call('test_mesh_residency', this.context, after, capacity, pointer) >>> 0
        if (count > capacity) throw new Error('Invalid private mesh residency response')
        const view = this.module.refreshMemory().dataView
        for (let i = 0; i < count; ++i) {
          const offset = pointer + i * words * 4
          const u = n => view.getUint32(offset + n * 4, true)
          const s = n => view.getInt32(offset + n * 4, true)
          const row = {id:u(0),key:[u(1),s(2),s(3),s(4),u(5)].join('/'),
            positionBytes:u(6),uvId:u(8)+':'+u(7),uvBytes:u(9),references:u(10),
            cached:u(11),output:u(12),presented:u(13),prepared:u(14),loans:u(15),
            cacheSequence:u(16),sequence:u(17),uvReferences:u(18),replacement:u(19)}
          if (row.id <= after) throw new Error('Unordered private mesh residency response')
          after = row.id; positionBytes += row.positionBytes
          textures.set(row.uvId,row.uvBytes); rows.push(row)
        }
        if (count < capacity) break
      }
      const uvBytes = Array.from(textures.values()).reduce((a,b)=>a+b,0)
      const bytes = this.meshPayloadBytes()
      if (positionBytes + uvBytes !== bytes) throw new Error('Private residency omits Native payload')
      return {bytes,positionBytes,uvBytes,rows}
    } finally { this.free(pointer) }
  }
}

function instrumentHarness(source) {
  const sample = '      memoryReplay.samples.push({lap:'
  const end = "    check('replay_managed_residency',"
  if (source.split(sample).length !== 2 || source.split(end).length !== 2)
    throw new Error('Web memory replay layout changed')
  return source.replace(sample, `      const nativeResidency = await runtime.abi.call('meshResidencyDiagnostic')
      if (nativeResidency.bytes !== settled.resources.meshBytes) throw new Error('Residency changed after idle sample')
      memoryReplay.samples.push({nativeResidency,lap:`)
    .replace(end, "    throw new Error('Native mesh residency diagnostic collected; not release acceptance')\n" + end)
}

module.exports = {workerExtension:'('+install.toString()+')(self.TerraWebSdk.abi,self.TerraWebSdk.worker);\n',instrumentHarness}
