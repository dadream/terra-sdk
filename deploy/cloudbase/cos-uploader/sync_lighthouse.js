'use strict'

const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  bucketResources,
  clearCredential,
  objectResource,
  requestTemporaryCredential
} = require('./cos_auth')

const SOURCE_PREFIX = 'terra-testdata/datasets/'

function parseArguments(argv) {
  const values = {
    distro: 'Ubuntu-22.04',
    destination: '/srv/terra/data/datasets'
  }
  for (let index = 2; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument near ${name}`)
    }
    values[name.slice(2)] = value
  }
  for (const required of ['env', 'bucket', 'region', 'host']) {
    if (!values[required]) {
      throw new Error(`missing --${required}`)
    }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(values.host)) {
    throw new Error('SSH host alias is invalid')
  }
  if (!/^\/[A-Za-z0-9/._-]+$/.test(values.destination) ||
      values.destination.includes('..')) {
    throw new Error('destination path is invalid')
  }
  return values
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

function toWslPath(file, distro) {
  const resolved = path.resolve(file)
  if (process.platform !== 'win32') return resolved
  const prefixes = [
    `\\\\wsl.localhost\\${distro}\\`,
    `\\\\wsl$\\${distro}\\`
  ]
  const prefix = prefixes.find(candidate =>
    resolved.toLowerCase().startsWith(candidate.toLowerCase()))
  if (prefix) {
    return '/' + resolved.slice(prefix.length).replace(/\\/g, '/')
  }
  const converted = spawnSync('wsl.exe', [
    '-d', distro, '--', 'wslpath', '-u', resolved
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000
  })
  if (converted.status !== 0) {
    throw new Error(`unable to translate Windows path: ${resolved}`)
  }
  return converted.stdout.trim()
}

function wslCommand(options, command, commandArguments, spawnOptions = {}) {
  const result = spawnSync('wsl.exe', [
    '-d', options.distro, '--', command, ...commandArguments
  ], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    timeout: spawnOptions.timeout || 120000,
    input: spawnOptions.input
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`)
  }
}

function installVerifier(options) {
  const repository = path.resolve(__dirname, '../../..')
  const manifest = toWslPath(path.join(repository,
    'deploy', 'lighthouse', 'data_manifest.json'), options.distro)
  const verifier = toWslPath(path.join(repository,
    'deploy', 'lighthouse', 'verify_data.py'), options.distro)
  const remote = '/tmp/terra-lighthouse-data'
  wslCommand(options, 'ssh', [options.host, 'mkdir', '-p', remote])
  wslCommand(options, 'scp', [manifest, verifier, `${options.host}:${remote}/`])
  wslCommand(options, 'ssh', [
    options.host, 'sudo', 'install', '-d', '-m', '0755',
    '/opt/terra/deploy'
  ])
  wslCommand(options, 'ssh', [
    options.host, 'sudo', 'install', '-m', '0644',
    `${remote}/data_manifest.json`,
    '/opt/terra/deploy/data_manifest.json'
  ])
  wslCommand(options, 'ssh', [
    options.host, 'sudo', 'install', '-m', '0755',
    `${remote}/verify_data.py`,
    '/opt/terra/deploy/verify_data.py'
  ])
  wslCommand(options, 'ssh', [options.host, 'rm', '-rf', remote])
}

function sync(options) {
  const statements = [
    {
      effect: 'allow',
      action: ['name/cos:GetBucket', 'name/cos:HeadBucket'],
      resource: bucketResources(options)
    },
    {
      effect: 'allow',
      action: ['name/cos:GetObject', 'name/cos:HeadObject'],
      resource: [objectResource(options, `${SOURCE_PREFIX}*`)]
    }
  ]
  const credential = requestTemporaryCredential(
    options, statements, 'terra-lighthouse-data-sync', 7200)
  try {
    installVerifier(options)
    const destination = options.destination.replace(/\/+$/, '')
    const script = [
      'set -eu',
      'umask 077',
      'config=$(mktemp --suffix=.yaml)',
      'cleanup() { rm -f "$config"; }',
      'trap cleanup EXIT HUP INT TERM',
      `sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0755 ${shellQuote(destination)}`,
      'sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0755 /srv/terra/state/coscli /srv/terra/state/coscli/logs',
      [
        'coscli config add',
        '--alias cloudbase',
        `--bucket ${shellQuote(options.bucket)}`,
        `--region ${shellQuote(options.region)}`,
        '--config-path "$config"',
        '--init-skip'
      ].join(' '),
      [
        'coscli config set',
        `--secret_id ${shellQuote(credential.secretId)}`,
        `--secret_key ${shellQuote(credential.secretKey)}`,
        `--session_token ${shellQuote(credential.token)}`,
        '--config-path "$config"',
        '--init-skip'
      ].join(' '),
      'echo "[sync] temporary COS credential configured"',
      [
        'coscli ls',
        `cos://cloudbase/${SOURCE_PREFIX}`,
        '--limit 2',
        '--config-path "$config"'
      ].join(' '),
      'echo "[sync] source prefix is readable"',
      'sync_log=/srv/terra/state/coscli/last-sync.log',
      'echo "[sync] downloading retained dataset prefix"',
      'set +e',
      [
        'coscli sync',
        `cos://cloudbase/${SOURCE_PREFIX}`,
        `${shellQuote(destination)}/`,
        '--recursive --update --routines 12 --retry-num 10',
        '--snapshot-path /srv/terra/state/coscli',
        '--process-log-path /srv/terra/state/coscli/logs',
        '--fail-output-path /srv/terra/state/coscli/logs',
        '--config-path "$config"',
        '>"$sync_log" 2>&1'
      ].join(' '),
      'sync_status=$?',
      'set -e',
      'tail -n 20 "$sync_log"',
      'if [ "$sync_status" -ne 0 ]; then',
      '  echo "[error] COS dataset sync failed" >&2',
      '  exit "$sync_status"',
      'fi',
      'echo "[sync] objects downloaded; verifying data"',
      [
        'sudo python3 /opt/terra/deploy/verify_data.py',
        '--data-root /srv/terra/data',
        '--manifest /opt/terra/deploy/data_manifest.json'
      ].join(' ')
    ].join('\n')
    wslCommand(options, 'ssh', [
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=120',
      options.host, 'bash', '-s'], {
      input: script,
      timeout: 4 * 60 * 60 * 1000
    })
  } finally {
    clearCredential(credential)
  }
}

function main() {
  try {
    sync(parseArguments(process.argv))
  } catch (error) {
    console.error(`[error] ${error.message || error}`)
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = { parseArguments, shellQuote, toWslPath }
