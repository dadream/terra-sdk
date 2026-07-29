'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  collectionDirectories,
  directoryMarkerKey,
  isTransientCosError,
  retryCollectionOperation
} = require('./upload')

test('classifies retryable network and service failures', () => {
  assert.equal(isTransientCosError({ code: 'ECONNRESET' }), true)
  assert.equal(isTransientCosError({ statusCode: 429 }), true)
  assert.equal(isTransientCosError({ statusCode: 503 }), true)
  assert.equal(isTransientCosError({ statusCode: 403 }), false)
  assert.equal(isTransientCosError({ statusCode: 404 }), false)
})

test('retries a transient collection operation', async () => {
  let attempts = 0
  const value = await retryCollectionOperation(() => {
    attempts += 1
    if (attempts < 3) {
      const error = new Error('read ECONNRESET')
      error.code = 'ECONNRESET'
      throw error
    }
    return 'ok'
  }, 'tiles/1/2/3.jpg', {
    maximumAttempts: 5,
    initialDelayMilliseconds: 1
  })
  assert.equal(value, 'ok')
  assert.equal(attempts, 3)
})

test('does not retry a permanent failure and includes the object key',
  async () => {
    let attempts = 0
    await assert.rejects(
      retryCollectionOperation(() => {
        attempts += 1
        const error = new Error('access denied')
        error.statusCode = 403
        throw error
      }, 'tiles/1/2/3.jpg', {
        maximumAttempts: 5,
        initialDelayMilliseconds: 1
      }),
      /tiles\/1\/2\/3\.jpg: access denied/)
    assert.equal(attempts, 1)
  })

test('builds COS directory markers for every collection parent', () => {
  const directories = collectionDirectories([
    { relative: '02/0000/0003/0000/0003.jpg' },
    { relative: '02/0000/0002/0000/0001.jpg' }
  ])
  assert.deepEqual(directories, [
    '',
    '02',
    '02/0000',
    '02/0000/0002',
    '02/0000/0002/0000',
    '02/0000/0003',
    '02/0000/0003/0000'
  ])
  assert.equal(directoryMarkerKey('datasets/imagery', ''),
    'datasets/imagery/')
  assert.equal(directoryMarkerKey('datasets/imagery', '02/0000'),
    'datasets/imagery/02/0000/')
})
