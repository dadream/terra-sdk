window.verifyCanvasPresentation = function () {
  const {mount, inspect} = window.TerraCanvasPresentation
  const require = (condition, reason) => {if (!condition) throw Error(reason)}
  const rejects = (callback, reason) => {
    let error
    try {callback()} catch (value) {error = value}
    require(error && error.message.includes(reason), 'Canvas presentation did not reject ' + reason)
  }
  const parent = document.createElement('div'), canvas = document.createElement('canvas')
  const next = document.createElement('span'), overlay = document.createElement('div')
  const style = 'position:fixed;left:-10000px;top:0'
  canvas.width = 120;canvas.height = 80;canvas.setAttribute('style', style)
  parent.append(canvas, next);document.body.append(parent)
  const viewport = {width: 120, height: 80, devicePixelRatio: 1}
  let lease, freshLease
  const fresh = document.createElement('canvas');fresh.width = 120;fresh.height = 80
  try {
    rejects(() => inspect(fresh, viewport), 'not connected')
    rejects(() => inspect(canvas, viewport), 'outside the viewport')
    lease = mount(canvas, viewport)
    const first = lease.inspect()
    require(first.connected && first.sampledUnobscured && first.bufferWidth === 120, 'Mounted canvas was not presented')
    overlay.style.cssText = 'position:fixed;left:8px;top:8px;width:120px;height:80px;z-index:2147483647'
    document.body.append(overlay)
    rejects(() => lease.inspect(), 'obscured')
    overlay.remove()
    canvas.style.left = '-130px';rejects(() => lease.inspect(), 'outside the viewport');canvas.style.left = '8px'
    canvas.style.opacity = '0';rejects(() => lease.inspect(), 'hidden');canvas.style.opacity = '1'
    canvas.width = 121;rejects(() => lease.inspect(), 'backing size');canvas.width = 120
    lease.release();lease.release()
    require(canvas.parentNode === parent && canvas.nextSibling === next && canvas.getAttribute('style') === style,
      'Canvas location or exact style was not restored')
    rejects(() => lease.inspect(), 'closed')
    freshLease = mount(fresh, viewport);freshLease.release()
    require(!fresh.isConnected && fresh.getAttribute('style') === null, 'Fresh canvas retained DOM or style')
    rejects(() => mount(canvas, {width: innerWidth + 20, height: 80}), 'outside the viewport')
    require(canvas.parentNode === parent && canvas.nextSibling === next && canvas.getAttribute('style') === style,
      'Failed acquisition did not restore the canvas')
    return {restored: true, rejectsDetached: true, rejectsOffscreen: true,
      rejectsOccluded: true, rejectsHidden: true, rejectsWrongResolution: true}
  } finally {
    if (lease) lease.release()
    if (freshLease) freshLease.release()
    overlay.remove();fresh.remove();parent.remove()
  }
}
