'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { ALLOWED_PREFIX, validateCleanupPrefix } = require('./prune')

test('accepts only the exact Tianditu cache prefix twice', () => {
  assert.doesNotThrow(() => {
    validateCleanupPrefix(ALLOWED_PREFIX, ALLOWED_PREFIX)
  })
  assert.throws(
    () => validateCleanupPrefix('terra-testdata/', 'terra-testdata/'),
    /restricted/)
  assert.throws(
    () => validateCleanupPrefix(ALLOWED_PREFIX, 'terra-tianditu-cache'),
    /restricted/)
})
