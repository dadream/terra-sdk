(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.TerraCanvasPresentation = factory()
})(typeof self === 'undefined' ? this : self, function () {
  'use strict'

  function inspect(canvas, viewport) {
    const document = canvas.ownerDocument, view = document.defaultView
    const require = (condition, reason) => {if (!condition) throw Error('Navigation canvas ' + reason)}
    require(canvas.isConnected, 'is not connected')
    require(document.visibilityState === 'visible', 'document is not visible')
    const rect = canvas.getBoundingClientRect()
    require(rect.left >= 0 && rect.top >= 0 && rect.right <= view.innerWidth && rect.bottom <= view.innerHeight,
      'is outside the viewport')
    require(Math.abs(rect.width - viewport.width) < 0.01 && Math.abs(rect.height - viewport.height) < 0.01,
      'CSS size differs from the SDK viewport')
    const ratio = viewport.devicePixelRatio || 1
    require(canvas.width === Math.round(viewport.width * ratio) && canvas.height === Math.round(viewport.height * ratio),
      'backing size differs from the SDK viewport')
    for (let node = canvas; node; node = node.parentElement) {
      const style = view.getComputedStyle(node)
      require(style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) !== 0 &&
        style.contentVisibility !== 'hidden', 'or its ancestor is hidden')
    }
    const points = [[0.5,0.5], [0.01,0.01], [0.99,0.01], [0.01,0.99], [0.99,0.99]]
    require(points.every(([x,y]) => document.elementFromPoint(rect.left + rect.width*x,
      rect.top + rect.height*y) === canvas), 'is obscured at a sampled point')
    return {connected: true, documentVisibility: document.visibilityState,
      left: rect.left, top: rect.top, cssWidth: rect.width, cssHeight: rect.height,
      windowWidth: view.innerWidth, windowHeight: view.innerHeight,
      bufferWidth: canvas.width, bufferHeight: canvas.height, devicePixelRatio: ratio,
      displayDevicePixelRatio: view.devicePixelRatio,
      sampledUnobscured: true}
  }

  // Presentation is owned by the browser fixture, never by the SDK scheduler.
  // Restore the caller's exact DOM location/style on both success and failure.
  function mount(canvas, viewport) {
    const document = canvas.ownerDocument, parent = canvas.parentNode, next = canvas.nextSibling
    const style = canvas.getAttribute('style')
    let active = true
    const release = () => {
      if (!active) return
      active = false
      if (style === null) canvas.removeAttribute('style')
      else canvas.setAttribute('style', style)
      if (parent) parent.insertBefore(canvas, next && next.parentNode === parent ? next : null)
      else canvas.remove()
    }
    try {
      canvas.style.cssText = 'position:fixed;left:8px;top:8px;display:block;visibility:visible;opacity:1;' +
        'z-index:2147483647;margin:0;border:0;padding:0;transform:none;clip-path:none;box-sizing:content-box;' +
        'width:' + viewport.width + 'px;height:' + viewport.height + 'px'
      document.body.appendChild(canvas)
      inspect(canvas, viewport)
      return {inspect() {if (!active) throw Error('Navigation canvas presentation is closed');return inspect(canvas, viewport)}, release}
    } catch (error) {release(); throw error}
  }

  return {mount, inspect}
})
