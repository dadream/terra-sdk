// Replay source contracts against the actual distributed, minified dependency graph.
const fs = require('fs')
const path = require('path')
const Module = require('module')
const root = path.resolve(__dirname, '../..')
const packaged = path.join(root, 'workspace_old/package/miniprogram')
const resolve = Module._resolveFilename
Module._resolveFilename = function (...args) {
  const file = resolve.apply(this, args)
  const relative = path.relative(root, file)
  if (relative.startsWith('sdk/js/') || relative.startsWith('adapters/')) {
    const target = path.join(packaged, relative)
    if (!fs.existsSync(target)) throw new Error('Packaged SDK module missing: ' + relative)
    return target
  }
  return file
}
