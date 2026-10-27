'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

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

function validateCosOptions(options) {
  if (!/^[A-Za-z0-9-]+$/.test(options.env || '')) {
    throw new Error('CloudBase environment ID is invalid')
  }
  if (!/^[a-z0-9-]+$/.test(options.region || '')) {
    throw new Error('COS region is invalid')
  }
  if (!/^[a-z0-9-]+-[0-9]{10}$/.test(options.bucket || '')) {
    throw new Error('COS physical bucket name is invalid')
  }
}

function bucketResource(options) {
  validateCosOptions(options)
  const account = /-([0-9]{10})$/.exec(options.bucket)[1]
  return `qcs::cos:${options.region}:uid/${account}:${options.bucket}`
}

function bucketResources(options) {
  const bucket = bucketResource(options)
  return [bucket, `${bucket}/`, `${bucket}/*`]
}

function objectResource(options, keyPattern) {
  if (!keyPattern || keyPattern.includes('..') || keyPattern.startsWith('/')) {
    throw new Error('COS object key pattern is invalid')
  }
  return `${bucketResource(options)}/${keyPattern}`
}

function requestTemporaryCredential(options, statements, name, durationSeconds) {
  validateCosOptions(options)
  const body = {
    Name: name,
    Policy: JSON.stringify({
      version: '2.0',
      statement: statements
    }),
    DurationSeconds: durationSeconds
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

function clearCredential(credential) {
  if (!credential) return
  credential.secretId = ''
  credential.secretKey = ''
  credential.token = ''
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

module.exports = {
  bucketResource,
  bucketResources,
  callCos,
  clearCredential,
  objectResource,
  parseJsonOutput,
  requestTemporaryCredential,
  validateCosOptions
}
