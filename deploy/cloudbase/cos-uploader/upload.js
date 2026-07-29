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

function readTemporaryCredential(options) {
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
  const resource =
    `qcs::cos:${options.region}:uid/${account[1]}:` +
    `${options.bucket}/${options.key}`
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
    DurationSeconds: 900
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

function contentLength(result) {
  const headers = result && result.headers
  const value = headers && (headers['content-length'] || headers['Content-Length'])
  return Number(value)
}

async function upload(options) {
  const source = path.resolve(options.source)
  const stat = fs.statSync(source)
  if (!stat.isFile()) {
    throw new Error(`source is not a file: ${source}`)
  }

  const credential = readTemporaryCredential(options)
  const cos = new COS({
    SecretId: credential.secretId,
    SecretKey: credential.secretKey,
    SecurityToken: credential.token
  })
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

main()
