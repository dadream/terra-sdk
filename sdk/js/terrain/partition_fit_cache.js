const surfacePlan = require('./terra_surface_plan')

// One completed fit for one immutable draw snapshot. No geometry/model loans
// survive a fit; the caller owns those only while the generator is running.
class PartitionFitCache {
  clear() { this.entry = null }

  *fit(initial, options, modelFor) {
    const key = [options.maximumPartitionBytes, options.targetPixelError, options.sourceUvScale,
      initial.quality.limitedByBudget, initial.quality.limitedByPartitionBudget]
    const old = this.entry
    if (old && old.input === initial.draws && key.every((value, i) => Object.is(value, old.key[i]))) {
      return {...initial, draws: old.draws, quality: {...initial.quality, ...old.quality}}
    }
    const result = yield* surfacePlan.fitPartitionSteps(initial, options, modelFor)
    const quality = {}
    for (const name of Object.keys(result.quality)) {
      if (!Object.is(result.quality[name], initial.quality[name])) quality[name] = result.quality[name]
    }
    // Cancellation and exceptions cannot publish an incomplete price. Progress
    // fields are not cached: they still come from the latest native response.
    this.entry = {input: initial.draws, key, draws: result.draws, quality}
    return result
  }
}

module.exports = {PartitionFitCache}
