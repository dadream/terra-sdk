'use strict'

const COS = require('cos-nodejs-sdk-v5')
const {
  bucketResources,
  callCos,
  clearCredential,
  objectResource,
  requestTemporaryCredential
} = require('./cos_auth')

const ALLOWED_PREFIX = 'terra-tianditu-cache/'

function parseArguments(argv) {
  const values = {}
  for (let index = 2; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument near ${name}`)
    }
    values[name.slice(2)] = value
  }
  for (const required of [
    'env', 'bucket', 'region', 'prefix', 'confirm-prefix'
  ]) {
    if (!values[required]) throw new Error(`missing --${required}`)
  }
  validateCleanupPrefix(values.prefix, values['confirm-prefix'])
  return values
}

function validateCleanupPrefix(prefix, confirmation) {
  if (prefix !== ALLOWED_PREFIX || confirmation !== ALLOWED_PREFIX) {
    throw new Error(
      `cleanup is restricted to the exact prefix ${ALLOWED_PREFIX}`)
  }
}

async function listPage(cos, options, marker) {
  return callCos(cos, 'getBucket', {
    Bucket: options.bucket,
    Region: options.region,
    Prefix: options.prefix,
    Marker: marker || '',
    MaxKeys: 1000
  })
}

async function inventory(cos, options) {
  let marker = ''
  let count = 0
  let bytes = 0
  do {
    const page = await listPage(cos, options, marker)
    const contents = page.Contents || []
    count += contents.length
    bytes += contents.reduce(
      (total, object) => total + Number(object.Size || 0), 0)
    if (page.IsTruncated !== 'true' && page.IsTruncated !== true) break
    marker = page.NextMarker || contents[contents.length - 1].Key
  } while (marker)
  return { count, bytes }
}

async function deletePrefix(cos, options) {
  let deleted = 0
  while (true) {
    const page = await listPage(cos, options, '')
    const contents = page.Contents || []
    if (contents.length === 0) break
    await callCos(cos, 'deleteMultipleObject', {
      Bucket: options.bucket,
      Region: options.region,
      Objects: contents.map(object => ({ Key: object.Key })),
      Quiet: true
    })
    deleted += contents.length
  }
  return deleted
}

async function prune(options) {
  const statements = [
    {
      effect: 'allow',
      action: ['name/cos:GetBucket'],
      resource: bucketResources(options)
    },
    {
      effect: 'allow',
      action: ['name/cos:DeleteObject'],
      resource: [objectResource(options, `${ALLOWED_PREFIX}*`)]
    }
  ]
  const credential = requestTemporaryCredential(
    options, statements, 'terra-tianditu-cache-prune', 3600)
  const cos = new COS({
    SecretId: credential.secretId,
    SecretKey: credential.secretKey,
    SecurityToken: credential.token
  })
  try {
    const before = await inventory(cos, options)
    console.log(
      `[plan] prefix=${ALLOWED_PREFIX} objects=${before.count} bytes=${before.bytes}`)
    const deleted = await deletePrefix(cos, options)
    const after = await inventory(cos, options)
    if (after.count !== 0) {
      throw new Error(
        `cache cleanup incomplete: ${after.count} objects remain`)
    }
    console.log(
      `[ok] deleted=${deleted} retained_prefix=terra-testdata/`)
  } finally {
    clearCredential(credential)
  }
}

async function main() {
  try {
    await prune(parseArguments(process.argv))
  } catch (error) {
    console.error(`[error] ${error.message || error}`)
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = {
  ALLOWED_PREFIX,
  inventory,
  validateCleanupPrefix
}
