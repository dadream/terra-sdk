(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.TerraReadback = factory()
})(typeof self === 'undefined' ? this : self, function () {
  // Observe the render owner's next submission. Polling render() beside its
  // RAF can always arrive after that owner has submitted another GPU batch.
  return function nextSubmission(renderer, options) {
    const value = options || {}, render = renderer.render
    const request = value.requestFrame || requestAnimationFrame
    const cancel = value.cancelFrame || cancelAnimationFrame
    const set = value.setTimer || setTimeout, clear = value.clearTimer || clearTimeout
    return new Promise((resolve, reject) => {
      let done = false, frame = null, timer
      const finish = (error, result) => {
        if (done) return
        done = true
        if (renderer.render === observe) renderer.render = render
        if (frame !== null) cancel(frame)
        clear(timer)
        if (error) reject(error)
        else resolve(result)
      }
      function observe() {
        try {
          // Keep the owner's display slot, but require actual drawing for a
          // default-framebuffer read. Equal preparation alone is not readback.
          const result = render.call(this, true)
          // A prior readiness observation can become stale in this draw (for
          // example, a newly published surface starts an imagery fade). Accept
          // the submitted state, not readiness before awaiting its display slot.
          if (result && renderer.surfaceDrawn !== false && (!value.accept || value.accept(result))) finish(null, result)
          return result
        } catch (error) { finish(error); throw error }
      }
      renderer.render = observe
      timer = set(() => finish(new Error('Timed out waiting for submitted readback frame')), 10000)
      const drive = () => {
        frame = null
        try {
          if(renderer.advanceResources)renderer.advanceResources()
          renderer.render()
        } catch (_) { return }
        if (!done) frame = request(drive)
      }
      try {
        renderer.requestRender()
        // Standalone renderer fixtures have no runtime display clock.
        if (value.drive && !done) frame = request(drive)
      } catch (error) { finish(error) }
    })
  }
})
