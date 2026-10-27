'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  parseArguments,
  shellQuote,
  toWslPath
} = require('./sync_lighthouse')

test('validates the fixed-shape Lighthouse sync arguments', () => {
  const options = parseArguments([
    'node', 'sync_lighthouse.js',
    '--env', 'example-env',
    '--bucket', 'example-1234567890',
    '--region', 'ap-shanghai',
    '--host', 'terra'
  ])
  assert.equal(options.destination, '/srv/terra/data/datasets')
  assert.equal(options.host, 'terra')
  assert.throws(() => parseArguments([
    'node', 'sync_lighthouse.js',
    '--env', 'example-env',
    '--bucket', 'example-1234567890',
    '--region', 'ap-shanghai',
    '--host', 'terra;bad'
  ]), /invalid/)
})

test('quotes shell values and maps WSL UNC paths', () => {
  assert.equal(shellQuote("a'b"), "'a'\"'\"'b'")
  if (process.platform === 'win32') {
    assert.equal(
      toWslPath(
        '\\\\wsl.localhost\\Ubuntu-22.04\\home\\holo\\file',
        'Ubuntu-22.04'),
      '/home/holo/file')
  }
})
