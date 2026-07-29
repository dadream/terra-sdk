'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function tcbInvocation() {
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
  return entry
}

function main() {
  const body = fs.readFileSync(0, 'utf8').trim()
  const cliArguments = process.argv.slice(2)
  if (body) {
    cliArguments.push('--body', body)
  }
  cliArguments.push('--json')
  const result = spawnSync(process.execPath, [tcbInvocation(), ...cliArguments], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.error) {
    throw result.error
  }
  if (result.stdout) {
    process.stdout.write(result.stdout)
  }
  if (result.stderr) {
    process.stderr.write(result.stderr)
  }
  process.exitCode = Number.isInteger(result.status) ? result.status : 1
}

try {
  main()
} catch (error) {
  console.error(error && error.message ? error.message : String(error))
  process.exitCode = 1
}
