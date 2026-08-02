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
    if (child.exitCode !== null) {
      throw new Error(`Chromium exited before DevTools was ready: ${child.exitCode}`)
    }
    try {
      const response = await fetch(endpoint)
      if (response.ok) {
        const pages = await response.json()
        const page = pages.find((item) => item.type === 'page' &&
          (item.url === targetUrl || item.url.startsWith(targetUrl)))
        if (page) return page.webSocketDebuggerUrl
      }
    } catch (error) {
      // Browser startup races are expected here.
    }
    await delay(100)
  }
  throw new Error('Chromium DevTools page did not become ready')
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
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
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        'DevTools WebSocket open timed out')), 5000)
      this.socket.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      this.socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error('DevTools WebSocket failed'))
      }
    })
  }

  call(method, params, timeoutMilliseconds) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`DevTools command timed out: ${method}`))
      }, timeoutMilliseconds || 5000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params: params || {} }))
    })
  }

  close() {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timer)
      pending.reject(new Error('DevTools connection closed'))
    })
    this.pending.clear()
    this.socket.close()
  }
}

async function expressionValue(connection, expression) {
  const response = await connection.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  }, 20000)
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
  if (child.exitCode === null) {
    let exited = await Promise.race([
      new Promise((resolve) => child.once('exit', () => resolve(true))),
      delay(3000).then(() => false)
    ])
    if (!exited && child.exitCode === null) {
      child.kill()
      exited = await Promise.race([
        new Promise((resolve) => child.once('exit', () => resolve(true))),
        delay(3000).then(() => false)
      ])
    }
    if (!exited && child.exitCode === null) {
      throw new Error('Chromium process did not stop')
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
  const port = await availablePort()
  const log = fs.openSync(logOutput, 'w')
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
  ], { stdio: ['ignore', 'ignore', log], windowsHide: true })
  const childClosed = new Promise((resolve) => child.once('close', resolve))
  const deadline = Date.now() + timeoutMilliseconds
  let connection = null
  try {
    const websocketUrl = await pageWebSocket(port, targetUrl, deadline, child)
    connection = new CdpConnection(websocketUrl)
    await connection.ready()
    await connection.call('Runtime.enable')
    let status = ''
    while (Date.now() < deadline) {
      try {
        status = await expressionValue(connection,
          "document.documentElement ? (document.documentElement.dataset.terraStatus || '') : ''")
      } catch (error) {
        if (!/execution context/i.test(error.message || String(error))) {
          throw error
        }
        status = ''
      }
      if (status === 'passed' || status === 'failed') break
      if (child.exitCode !== null) {
        throw new Error(`Chromium exited before evidence completed: ${child.exitCode}`)
      }
      await delay(100)
    }
    const terminal = status === 'passed' || status === 'failed'
    const dom = await expressionValue(connection,
      "'<!DOCTYPE html>\\n' + document.documentElement.outerHTML")
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
    if (cleanupError) throw cleanupError
  }
}

main().catch((error) => {
  console.error(`Browser evidence runner failed: ${error.message || error}`)
  process.exitCode = 1
})
