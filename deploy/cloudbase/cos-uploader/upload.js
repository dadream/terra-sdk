'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const COS = require('cos-nodejs-sdk-v5')

function fail(message) {
  console.error(`[error] ${message}`)
  process.exitCode = 1
}

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
  for (const required of ['env', 'source', 'bucket', 'region', 'key']) {
    if (!values[required]) {
      throw new Error(`missing --${required}`)
    }
  }
  return values
}

function parseJsonOutput(text, operation) {
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last < first) {
    throw new Error(`${operation} returned no JSON`)
  }
  return JSON.parse(text.slice(first, last + 1))
}

function tcbInvocation() {
  if (process.platform !== 'win32') {
    return { executable: 'tcb', prefix: [] }
  }
  const located = spawnSync('where.exe', ['tcb.cmd'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000
  })
  if (located.status !== 0) {
    throw new Error('CloudBase CLI is unavailable; install tcb and run tcb login')
  }
  const command = located.stdout.split(/\r?\n/).find(Boolean)
  const entry = path.join(path.dirname(command),
    'node_modules', '@cloudbase', 'cli', 'bin', 'tcb')
  if (!fs.existsSync(entry)) {
    throw new Error('CloudBase CLI Node entrypoint is unavailable')
  }
  return { executable: process.execPath, prefix: [entry] }
}

function readTemporaryCredential(options, directory) {
  if (!/^[A-Za-z0-9-]+$/.test(options.env)) {
    throw new Error('CloudBase environment ID is invalid')
  }
  if (!/^[a-z0-9-]+$/.test(options.region)) {
    throw new Error('COS region is invalid')
  }
  const account = /-([0-9]{10})$/.exec(options.bucket)
  if (!account || !options.key || options.key.includes('..')) {
    throw new Error('COS bucket or object key is invalid')
  }
  const key = directory
    ? `${options.key.replace(/\/+$/, '')}/*` : options.key
  const resource =
    `qcs::cos:${options.region}:uid/${account[1]}:` +
    `${options.bucket}/${key}`
  const policy = {
    version: '2.0',
    statement: [{
      effect: 'allow',
      action: [
        'name/cos:GetObject',
        'name/cos:HeadObject',
        'name/cos:PutObject',
        'name/cos:InitiateMultipartUpload',
        'name/cos:UploadPart',
        'name/cos:CompleteMultipartUpload',
        'name/cos:AbortMultipartUpload',
        'name/cos:ListParts'
      ],
      resource: [resource]
    }]
  }
  const body = {
    Name: 'terra-cloudbase-data-upload',
    Policy: JSON.stringify(policy),
    DurationSeconds: directory ? 7200 : 900
  }
  const invocation = tcbInvocation()
  const result = spawnSync(invocation.executable, [
    ...invocation.prefix,
    'api', 'sts', 'GetFederationToken',
    '--api-version', '2018-08-13',
    '--body', JSON.stringify(body),
    '--json'
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000
  })
  if (result.status !== 0) {
    throw new Error('CloudBase STS request failed; run tcb login')
  }
  const response = parseJsonOutput(result.stdout, 'sts.GetFederationToken')
  const credential = response.data && response.data.Credentials
  if (!credential || !credential.TmpSecretId ||
      !credential.TmpSecretKey || !credential.Token) {
    throw new Error('CloudBase returned no temporary STS credential')
  }
  return {
    secretId: credential.TmpSecretId,
    secretKey: credential.TmpSecretKey,
    token: credential.Token
  }
}

function callCos(cos, method, params) {
  return new Promise((resolve, reject) => {
    cos[method](params, (error, data) => {
      if (error) {
        reject(error)
        return
      }
      resolve(data)
    })
  })
}

function isTransientCosError(error) {
  const statusCode = Number(error && error.statusCode)
  if ([408, 429, 500, 502, 503, 504].includes(statusCode)) {
    return true
  }
  const detail = [
    error && error.code,
    error && error.name,
    error && error.message
  ].filter(Boolean).join(' ')
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|socket hang up/i
    .test(detail)
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function retryCollectionOperation(operation, key, options = {}) {
  const maximumAttempts = Number(options.maximumAttempts || 5)
  const initialDelayMilliseconds = Number(
    options.initialDelayMilliseconds || 250)
  let lastError
  for (let attempt = 1; attempt <= maximumAttempts; ++attempt) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isTransientCosError(error) || attempt === maximumAttempts) {
        break
      }
      const waitMilliseconds = Math.min(
        initialDelayMilliseconds * (2 ** (attempt - 1)), 2000)
      console.warn(
        `[retry] ${key} after ${error.message || error}; ` +
        `attempt ${attempt + 1}/${maximumAttempts}`)
      await delay(waitMilliseconds)
    }
  }
  throw new Error(`${key}: ${lastError && lastError.message
    ? lastError.message : String(lastError)}`)
}

function contentLength(result) {
  const headers = result && result.headers
  const value = headers && (headers['content-length'] || headers['Content-Length'])
  return Number(value)
}

function collectionFiles(root, extension) {
  const expected = (extension || '.jpg').toLowerCase()
  const pending = ['']
  const result = []
  while (pending.length > 0) {
    const relativeDirectory = pending.pop()
    const directory = path.join(root, relativeDirectory)
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = path.join(relativeDirectory, entry.name)
      if (entry.isDirectory()) {
        pending.push(relative)
      } else if (entry.isFile() &&
                 path.extname(entry.name).toLowerCase() === expected) {
        const file = path.join(root, relative)
        result.push({
          file,
          relative: relative.split(path.sep).join('/'),
          size: fs.statSync(file).size
        })
      }
    }
  }
  result.sort((left, right) => left.relative.localeCompare(right.relative))
  if (result.length === 0) {
    throw new Error(`source collection has no ${expected} files: ${root}`)
  }
  return result
}

async function uploadCollectionFileOnce(cos, options, source, key) {
  const object = {
    Bucket: options.bucket,
    Region: options.region,
    Key: key
  }
  try {
    const existing = await callCos(cos, 'headObject', object)
    const remoteSize = contentLength(existing)
    if (remoteSize === source.size) {
      return false
    }
    throw new Error(
      `remote object size ${remoteSize} differs from local size ` +
      `${source.size}: ${key}`)
  } catch (error) {
    if (Number(error.statusCode) !== 404) {
      throw error
    }
  }
  await callCos(cos, 'putObject', {
    ...object,
    Body: fs.createReadStream(source.file),
    ContentLength: source.size,
    ContentType: 'image/jpeg'
  })
  const uploaded = await callCos(cos, 'headObject', object)
  if (contentLength(uploaded) !== source.size) {
    throw new Error(`uploaded object size differs: ${key}`)
  }
  return true
}

async function uploadCollectionFile(cos, options, source, key) {
  return retryCollectionOperation(
    () => uploadCollectionFileOnce(cos, options, source, key), key)
}

async function uploadCollection(cos, options, root) {
  const files = collectionFiles(root, options['include-extension'])
  const requestedConcurrency = Number(options.concurrency || 8)
  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1) {
    throw new Error('collection concurrency must be a positive integer')
  }
  const concurrency = Math.min(32, requestedConcurrency)
  const prefix = options.key.replace(/\/+$/, '')
  let cursor = 0
  let uploaded = 0
  let verified = 0
  async function worker() {
    while (cursor < files.length) {
      const index = cursor++
      const source = files[index]
      const changed = await uploadCollectionFile(
        cos, options, source, `${prefix}/${source.relative}`)
      uploaded += changed ? 1 : 0
      verified += changed ? 0 : 1
      const completed = uploaded + verified
      if (completed % 250 === 0 || completed === files.length) {
        console.log(`[progress] ${completed}/${files.length}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) },
    () => worker()))
  const bytes = files.reduce((sum, file) => sum + file.size, 0)
  console.log(`[ok] collection ${options.key} files=${files.length} ` +
    `bytes=${bytes} uploaded=${uploaded} verified=${verified}`)
}

async function upload(options) {
  const source = path.resolve(options.source)
  const stat = fs.statSync(source)
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`source is not a file or directory: ${source}`)
  }

  const credential = readTemporaryCredential(options, stat.isDirectory())
  const cos = new COS({
    SecretId: credential.secretId,
    SecretKey: credential.secretKey,
    SecurityToken: credential.token
  })
  if (stat.isDirectory()) {
    try {
      await uploadCollection(cos, options, source)
    } finally {
      credential.secretId = ''
      credential.secretKey = ''
      credential.token = ''
    }
    return
  }
  const object = {
    Bucket: options.bucket,
    Region: options.region,
    Key: options.key
  }

  try {
    const existing = await callCos(cos, 'headObject', object)
    const remoteSize = contentLength(existing)
    if (remoteSize === stat.size) {
      console.log(`[ok] object already exists (${remoteSize} bytes)`)
      credential.secretId = ''
      credential.secretKey = ''
      credential.token = ''
      return
    }
    throw new Error(
      `remote object size ${remoteSize} differs from local size ${stat.size}`)
  } catch (error) {
    if (Number(error.statusCode) !== 404) {
      throw error
    }
  }

  let lastPercent = -1
  await callCos(cos, 'uploadFile', {
    ...object,
    FilePath: source,
    SliceSize: 20 * 1024 * 1024,
    AsyncLimit: 3,
    onProgress(progress) {
      const percent = Math.floor(Number(progress.percent || 0) * 100)
      if (percent >= lastPercent + 5 || percent === 100) {
        console.log(`[progress] ${percent}%`)
        lastPercent = percent
      }
    }
  })

  const uploaded = await callCos(cos, 'headObject', object)
  const uploadedSize = contentLength(uploaded)
  if (uploadedSize !== stat.size) {
    throw new Error(
      `uploaded object size ${uploadedSize} differs from local size ${stat.size}`)
  }
  console.log(`[ok] uploaded ${options.key} (${uploadedSize} bytes)`)
  credential.secretId = ''
  credential.secretKey = ''
  credential.token = ''
}

async function main() {
  try {
    await upload(parseArguments(process.argv))
  } catch (error) {
    fail(error && error.message ? error.message : String(error))
  }
}

if (require.main === module) {
  main()
}

module.exports = {
  isTransientCosError,
  retryCollectionOperation
}
