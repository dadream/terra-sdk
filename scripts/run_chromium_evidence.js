'use strict'

const fs = require('fs')
const net = require('net')
const { spawn } = require('child_process')

function argumentsMap(values) {
  const result = {}
  for (let index = 2; index < values.length; index += 2) {
    const key = values[index]
    if (!key.startsWith('--') || values[index + 1] === undefined) {
      throw new Error(`Invalid argument: ${key}`)
    }
    result[key.slice(2)] = values[index + 1]
  }
  return result
}

function required(options, name) {
  if (!options[name]) throw new Error(`Missing --${name}`)
  return options[name]
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function pageWebSocket(port, targetUrl, deadline, child) {
  const endpoint = `http://127.0.0.1:${port}/json/list`
  while (Date.now() < deadline) {
    if (child.startupError) throw child.startupError
    if (browserExited(child)) {
      throw new Error(`Chromium exited before DevTools was ready: ${child.exitCode}`)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(1000, Math.max(1, deadline - Date.now())))
    try {
      const response = await fetch(endpoint, { signal: controller.signal })
      if (response.ok) {
        const pages = await response.json()
        const page = pages.find((item) => item.type === 'page' &&
          (item.url === targetUrl || item.url.startsWith(targetUrl)))
        if (page) return page.webSocketDebuggerUrl
      }
    } catch (error) {
      // Browser startup races are expected here.
    } finally { clearTimeout(timer) }
    await delay(100)
  }
  throw new Error('Chromium DevTools page did not become ready')
}

class CdpConnection {
  constructor(url, Socket = WebSocket) {
    this.Socket = Socket
    this.socket = new Socket(url)
    this.nextId = 1
    this.pending = new Map()
    this.opening = new Set()
    this.failure = null
    this.socket.onopen = () => {
      this.opening.forEach(waiter => { clearTimeout(waiter.timer); waiter.resolve() })
      this.opening.clear()
    }
    this.socket.onerror = event => this.fail(new Error('DevTools WebSocket failed' +
      (event && (event.message || event.error && event.error.message)
        ? ': ' + (event.message || event.error.message) : '')))
    this.socket.onclose = event => this.fail(new Error(`DevTools WebSocket closed (${event.code}): ${event.reason || ''}`))
    this.socket.onmessage = (event) => {
      let message
      try { message = JSON.parse(String(event.data)) }
      catch (_) { this.fail(new Error('Invalid DevTools message')); return }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(new Error(message.error.message ||
          'DevTools command failed'))
      } else {
        pending.resolve(message.result || {})
      }
    }
  }

  ready() {
    if (this.failure) return Promise.reject(this.failure)
    if (this.socket.readyState === this.Socket.OPEN) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter = {resolve, reject}
      waiter.timer = setTimeout(() => {
        this.opening.delete(waiter)
        reject(new Error('DevTools WebSocket open timed out'))
      }, 5000)
      this.opening.add(waiter)
    })
  }

  call(method, params, timeoutMilliseconds) {
    if (this.failure) return Promise.reject(this.failure)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`DevTools command timed out: ${method}`))
      }, timeoutMilliseconds || 5000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.socket.send(JSON.stringify({ id, method, params: params || {} })) }
      catch (error) { this.fail(error) }
    })
  }

  fail(error) {
    if (this.failure) return
    this.failure = error
    this.opening.forEach(waiter => { clearTimeout(waiter.timer); waiter.reject(error) })
    this.opening.clear()
    this.pending.forEach((pending) => {
      clearTimeout(pending.timer)
      pending.reject(error)
    })
    this.pending.clear()
  }

  close() {
    this.fail(new Error('DevTools connection closed'))
    this.socket.close()
  }
}

async function expressionValue(connection, expression, phase = 'page evaluation') {
  const response = await connection.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  }, 20000).catch(error => { throw new Error(`${error.message} during ${phase}`) })
  if (response.exceptionDetails) {
    const exception = response.exceptionDetails.exception || {}
    throw new Error(exception.description || response.exceptionDetails.text || 'Page evaluation failed')
  }
  const result = response.result || {}
  if (result.subtype === 'error') {
    throw new Error(result.description || 'Page evaluation failed')
  }
  return result.value
}

async function stopBrowser(child, connection, childClosed) {
  if (connection) {
    try {
      await connection.call('Browser.close', {}, 1500)
    } catch (error) {
      // The browser may close the socket before acknowledging Browser.close.
    }
  }
  if (!browserExited(child)) {
    let exited = await Promise.race([
      childClosed.then(() => true),
      delay(3000).then(() => false)
    ])
    if (!exited && !browserExited(child)) {
      terminateOwnedBrowser(child, 'SIGTERM')
      exited = await Promise.race([
        childClosed.then(() => true),
        delay(3000).then(() => false)
      ])
    }
    if (!exited && !browserExited(child)) {
      terminateOwnedBrowser(child, 'SIGKILL')
      await Promise.race([childClosed, delay(3000)])
      if (!browserExited(child)) throw new Error('Chromium process did not stop')
    }
  }
  const closed = await Promise.race([
    childClosed.then(() => true),
    delay(3000).then(() => false)
  ])
  if (!closed) {
    throw new Error('Chromium process handles did not close')
  }
}

function terminateOwnedBrowser(child, signal) {
  if (!Number.isInteger(child.pid)) return
  if (process.platform === 'win32') child.kill(signal)
  else {
    try { process.kill(-child.pid, signal) }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}

function browserExited(child) { return child.exitCode !== null || child.signalCode !== null }

async function removeBrowserProfile(profile) {
  let lastError = null
  for (let attempt = 0; attempt < 30; ++attempt) {
    try {
      fs.rmSync(profile, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100
      })
    } catch (error) {
      lastError = error
    }
    if (!fs.existsSync(profile)) return
    await delay(Math.min(100 + attempt * 50, 1000))
  }
  throw lastError || new Error(`Browser profile cleanup failed: ${profile}`)
}

async function main() {
  const options = argumentsMap(process.argv)
  const browser = required(options, 'browser')
  const profile = required(options, 'profile')
  const targetUrl = required(options, 'url')
  const domOutput = required(options, 'dom-output')
  const logOutput = required(options, 'log-output')
  const timeoutMilliseconds = Number(options.timeout || 120) * 1000
  const width = Number(options.width || 1280)
  const height = Number(options.height || 1000)
  let port, log
  try {
    port = await availablePort()
    log = fs.openSync(logOutput, 'w')
  } catch (error) {
    // These failures happen before a browser exists, but the caller already
    // owns a temporary profile. Keep startup failure cleanup complete too.
    await removeBrowserProfile(profile)
    throw error
  }
  const child = spawn(browser, [
    '--headless=new',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--enable-webgl',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--use-angle=swiftshader',
    '--run-all-compositor-stages-before-draw',
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    targetUrl
  ], { stdio: ['ignore', 'ignore', log], windowsHide: true,
    detached: process.platform !== 'win32' })
  const interrupt = () => terminateOwnedBrowser(child, 'SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const childClosed = new Promise((resolve) => child.once('close', resolve))
  child.on('error', error => { child.startupError = error })
  const deadline = Date.now() + timeoutMilliseconds
  let connection = null
  try {
    const websocketUrl = await pageWebSocket(port, targetUrl, deadline, child)
    connection = new CdpConnection(websocketUrl)
    await connection.ready()
    // Default-context evaluation needs no execution-context event subscription.
    // This runner consumes replies only; Runtime.enable would replay events
    // that it ignores and add a separate startup barrier.
    if (options['driver-file']) {
      // A target URL can be visible to DevTools before navigation replaces the
      // initial document. Inject only after load, otherwise its context and all
      // driver callbacks can disappear without producing a terminal result.
      let loaded = false
      while (Date.now() < deadline) {
        try {
          loaded = await expressionValue(connection,
            "document.readyState === 'complete' && location.href.startsWith(" + JSON.stringify(targetUrl) + ")", 'page readiness')
        } catch (error) {
          if (!/execution context/i.test(error.message || String(error))) throw error
        }
        if (loaded) break
        await delay(100)
      }
      if (!loaded) throw new Error('Evidence page did not finish loading before driver injection')
      await expressionValue(connection, fs.readFileSync(options['driver-file'], 'utf8'), 'driver injection')
    }
    let status = '', lastProgressAt = 0
    while (Date.now() < deadline) {
      try {
        status = await expressionValue(connection,
          options['driver-file']
            ? "document.documentElement ? (document.documentElement.dataset.terraEvidenceStatus || '') : ''"
            : "document.documentElement ? (document.documentElement.dataset.terraStatus || '') : ''", 'evidence status')
        if (options['progress-output'] && options['progress-element'] && Date.now() - lastProgressAt >= 1000) {
          const progress = await expressionValue(connection,
            '(document.getElementById(' + JSON.stringify(options['progress-element']) + ') || {}).textContent || ""', 'progress capture')
          if (progress) fs.writeFileSync(options['progress-output'], progress, 'utf8')
          lastProgressAt = Date.now()
        }
      } catch (error) {
        if (!/execution context/i.test(error.message || String(error))) {
          throw error
        }
        status = ''
      }
      if (status === 'passed' || status === 'failed') break
      if (browserExited(child)) {
        throw new Error(`Chromium exited before evidence completed: ${child.exitCode}`)
      }
      await delay(100)
    }
    const terminal = status === 'passed' || status === 'failed'
    const dom = await expressionValue(connection,
      "'<!DOCTYPE html>\\n' + document.documentElement.outerHTML", 'final DOM capture')
    fs.writeFileSync(domOutput, dom, 'utf8')
    let screenshotError = null
    if (options['screenshot-output']) {
      try {
        await connection.call('Page.enable')
        const screenshot = await connection.call('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false
        }, 30000)
        fs.writeFileSync(options['screenshot-output'],
          Buffer.from(screenshot.data, 'base64'))
      } catch (error) {
        screenshotError = error
      }
    }
    if (!terminal) {
      throw new Error('Evidence page did not reach a terminal state')
    }
    if (screenshotError) throw screenshotError
    if (status === 'failed') throw new Error('Evidence page reported failure')
  } finally {
    let cleanupError = null
    try {
      await stopBrowser(child, connection, childClosed)
    } catch (error) {
      cleanupError = error
    }
    if (connection) {
      try {
        connection.close()
      } catch (error) {
        if (!cleanupError) cleanupError = error
      }
    }
    try {
      fs.closeSync(log)
    } catch (error) {
      if (!cleanupError) cleanupError = error
    }
    try {
      await removeBrowserProfile(profile)
    } catch (error) {
      if (!cleanupError) cleanupError = error
    }
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    if (cleanupError) throw cleanupError
  }
}

module.exports = {CdpConnection, expressionValue}

if (require.main === module) main().catch((error) => {
  console.error(`Browser evidence runner failed: ${error.message || error}`)
  process.exitCode = 1
})
