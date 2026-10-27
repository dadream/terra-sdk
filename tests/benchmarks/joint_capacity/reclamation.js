(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.TerraJointReclamation = factory()
})(typeof self === 'undefined' ? this : self, function () {
  'use strict'
  const assert = (value, message) => {if (!value) throw new Error(message)}
  const ownerBytes = (snapshot, owner) => snapshot.leases.reduce((sum, lease) =>
    sum + (lease.owner === owner ? lease.bytes : 0), 0)
  const settled = q => q.current && q.covered && q.terrainMet && !q.busy.length &&
    (q.terminal === 'ready' && q.imageryMet === true && !q.reasons.length || q.terminal === 'data-limited' &&
      q.reasons.length === 1 && q.reasons[0] === 'source-level')
  function comparePixels(before, after) {
    let changedBytes = 0, changedPixels = 0, maximumDifference = 0
    assert(before.bytes.length === after.bytes.length, 'Framebuffer dimensions changed')
    for (let i = 0; i < before.bytes.length; i += 4) {
      let changed = false
      for (let channel = 0; channel < 4; ++channel) {
        const difference = Math.abs(before.bytes[i + channel] - after.bytes[i + channel])
        if (difference) {++changedBytes; changed = true; maximumDifference = Math.max(maximumDifference, difference)}
      }
      if (changed) ++changedPixels
    }
    return {changedBytes, changedPixels, maximumDifference}
  }

  // This experiment is deliberately after the primary trajectory. Never
  // pause/reset the runtime or clear the visible renderer to obtain a refund.
  async function run({runtime, snapshot, analyze, observation, quality, capture, waitIdle, publish = () => {}}) {
    const abi = runtime.abi, ledger = runtime.resourceLedger
    const initial = observation(), frame = runtime.meshFrames.presented
    assert(settled(quality(initial)), 'Idle reclamation requires a settled display')
    const control = await capture(); await waitIdle()
    const pixelsBefore = await capture(); await waitIdle()
    const before = snapshot(), stages = [], pixelStages = []
    const controlComparison = comparePixels(control, pixelsBefore)
    publish({status:'running', before, stages, pixelStages, controlComparison})
    const native = [
      ['imagery-input-native', bytes => abi.reclaimMeasurementInputs(bytes)],
      ['imagery-reference-native', bytes => abi.reclaimImageryReferences(bytes)],
      ['terrain-record-native', bytes => abi.send({type:'trim-records', needed:bytes})],
      ['terrain-height-native', bytes => abi.send({type:'trim-heights', needed:bytes})],
      ['mesh-native', bytes => abi.send({type:'trim-native', needed:bytes})]
    ]
    // One explicit pass, followed by a no-progress audit. If references only
    // become free after another owner retires, retain the second pass receipts.
    for (let pass = 0; pass < 2; ++pass) {
      const passBefore = ledger.bytes
      for (const [owner, trim] of native) {
        const prior = snapshot(), bytes = ownerBytes(prior, owner)
        const releasedBytes = bytes ? await trim(bytes) : 0
        const after = snapshot()
        stages.push({pass, owner, requestedBytes:bytes, releasedBytes,
          ownerBeforeBytes:bytes, ownerAfterBytes:ownerBytes(after, owner),
          before:prior, after})
      }
      const nativePixels = await capture(); await waitIdle()
      pixelStages.push({pass, stage:'native', pixels:nativePixels.summary, ...comparePixels(pixelsBefore, nativePixels)})
      const prior = snapshot(), closure = analyze(prior)
      const roots = Array.from(ledger.leases).filter(lease => lease.reclaimable && lease.reclaimable())
      assert(ledger.makeRoom(0, roots), 'Declared idle eviction was refused')
      const after = snapshot()
      stages.push({pass, owner:'synchronous-closure', requestedBytes:closure.eligibleBytes,
        releasedBytes:prior.ledger.bytes - after.ledger.bytes, before:prior, after})
      const synchronousPixels = await capture(); await waitIdle()
      pixelStages.push({pass, stage:'synchronous', pixels:synchronousPixels.summary, ...comparePixels(pixelsBefore, synchronousPixels)})
      if (ledger.bytes === passBefore) break
    }
    const pixelsAfter = await capture()
    // Readback observes a new submitted frame. Its GPU fence/frame-clock
    // receipt can still be pending; observe completion before requiring idle.
    const drainMs = await waitIdle()
    const final = observation(), after = snapshot()
    const pixelComparison = comparePixels(pixelsBefore, pixelsAfter)
    const result = {before, after, stages, pixelStages, controlComparison, pixelComparison, afterEvictionClosure:analyze(after),
      sameFrame:frame === runtime.meshFrames.presented,
      sameSets:JSON.stringify(initial.sets) === JSON.stringify(final.sets),
      beforeQuality:quality(initial), afterQuality:quality(final), drainMs,
      beforePixels:pixelsBefore.summary, afterPixels:pixelsAfter.summary,
      samePixels:pixelComparison.changedBytes === 0,
      remainingNativeBytes:{mesh:abi.nativeBudget.actual, height:abi.nativeHeightBytes,
        record:abi.nativeRecordBytes, imageryInput:abi.imageryInputPayloadBytes()},
      fixedPoint:stages.filter(stage => stage.pass === 1).length === 6 &&
        stages.filter(stage => stage.pass === 1).every(stage => stage.before.ledger.bytes === stage.after.ledger.bytes),
      scope:'Actual current-policy idle refunds; remaining is a sufficient settled residency, not a global minimum or transition bound'}
    publish(result)
    validate(result)
    return result
  }

  function validate(result) {
    assert(!result.controlComparison || result.controlComparison.changedBytes === 0,
      'Pixels already changed between control submissions without reclamation')
    assert(result.sameFrame && result.sameSets, 'Idle reclamation changed the displayed frame or spatial sets')
    assert(settled(result.beforeQuality) && settled(result.afterQuality), 'Idle reclamation changed settled quality')
    assert(result.beforeQuality.terminal === result.afterQuality.terminal &&
      JSON.stringify(result.beforeQuality.reasons) === JSON.stringify(result.afterQuality.reasons), 'Idle reclamation changed limitations')
    assert(result.samePixels && result.beforePixels.fnv1a32 === result.afterPixels.fnv1a32 &&
      result.beforePixels.width === result.afterPixels.width && result.beforePixels.height === result.afterPixels.height &&
      result.beforePixels.sampledColorCount > 1, 'Idle reclamation changed or blanked pixels')
    for (const stage of result.stages) {
      assert(Number.isSafeInteger(stage.releasedBytes) && stage.releasedBytes >= 0, 'Invalid idle refund')
      if (stage.owner === 'synchronous-closure')
        assert(stage.releasedBytes === stage.requestedBytes, 'Declared closure and actual refund differ')
      else assert(stage.ownerBeforeBytes - stage.ownerAfterBytes === stage.releasedBytes,
        'Native receipt and owned payload differ')
    }
    return result
  }
  return {run, validate, comparePixels}
})
