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
  const port = await availablePort()
  if (fs.existsSync(profile)) throw new Error('Evidence requires a new, test-owned browser profile')
  fs.mkdirSync(profile, {recursive: true})
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
    await connection.call('Runtime.enable')
    let demoReady = false
    while (Date.now() < deadline - 60000) {
      try {
        demoReady = await expressionValue(connection,
          '!!(window.__terraProductDemo && window.__terraProductDemo.viewer.runtime.manifest)')
      } catch (error) {
        if (!/execution context/i.test(error.message || String(error))) throw error
      }
      if (demoReady) break
      await delay(100)
    }
    if (!demoReady) throw new Error('Demo initialization timed out')
    const report = {schema: 'terra.coarsening-focus.v2', started: new Date().toISOString(),
      passed: false, cases: [], samples: [], checks: [], trace: null}
    function save() { fs.writeFileSync(domOutput + '.json', JSON.stringify(report, null, 2) + '\n') }
    function check(name, value, detail) { report.checks.push({name, passed: !!value, detail}); save() }
    try {
      await expressionValue(connection, `(function(){
        const rt=window.__terraProductDemo.viewer.runtime,r=rt.renderer,t=r.textures;
        const p=window.__coarseFocus={phase:'initial',frames:[],rpc:[],sync:[],requests:[],cancels:[],errors:[],original:new Set()};
        const histogram=tiles=>{const h={};for(const tile of tiles)h[tile.level]=(h[tile.level]||0)+1;return h};
        const keys=map=>Array.from(map.keys());
        p.snapshot=function(){const s=r.stats(),q=s.quality,tex=s.textures;
          return {time:performance.now(),phase:p.phase,range:rt.camera.distance,radius:rt.manifest.radius,
            cameraRevision:rt.abi.viewRevision,plannedCamera:r.plannedCameraVersion,currentCamera:r.cameraVersion,
            complete:q.planningComplete,cameraCurrent:q.cameraCurrent,state:q.state,
            selected:[q.selectedLevelMinimum,q.selectedLevelMaximum],resolved:[q.resolvedLevelMinimum,q.resolvedLevelMaximum],
            error:q.resolvedMaxPixelError,targetError:q.targetPixelError,limitedByBudget:q.limitedByBudget,
            limits:q.limitationReasons,coarsening:!!(r.current&&r.current.imageryPlan&&r.current.imageryPlan.quality.coarsening),
            presented:histogram(r.presentedTextures.values()),target:histogram(t.targetDesired.values()),
            cache:histogram(keys(t.cache.entries).map(k=>({level:Number(k.split('/')[0])}))),
            originalPresented:keys(r.presentedTextures).filter(k=>p.original.has(k)).length,
            originalCached:keys(t.cache.entries).filter(k=>p.original.has(k)).length,
            active:histogram(keys(t.scheduler.active).map(k=>({level:Number(k.split('/')[0])}))),
            queued:histogram(keys(t.scheduler.queued).map(k=>({level:Number(k.split('/')[0])}))),
            obsoleteActive:keys(t.scheduler.active).filter(k=>!t.isWanted(k)).length,
            staleActive:Array.from(t.scheduler.active.values()).filter(v=>v.stale).length,
            missing:tex.missingRatio,targetMissing:tex.targetMissing,requestsActive:tex.active,requestsQueued:tex.queued,
            cachedTarget:tex.cachedTarget,targetCount:tex.targetDesired,cacheEntries:tex.entries,cacheBytes:tex.bytes,
            capacity:tex.capacity,targetCapacity:tex.targetCapacity,failed:tex.failed,
            transitioning:q.transitioningCells||0,roots:q.geometryCoverageSubmitted,draws:q.renderedDrawCount,coverage:q.geometryCoverageReady,
            partitionQueue:r.partitionQueue.reduce((n,v)=>n+v.cells.length,0),partitionUploads:r.partitionUploads.length,
            partitionBytes:s.performance.partitionBytes,partitionCapacity:s.performance.partitionCapacityBytes,
            geometryBytes:s.geometry.bytes,geometryCapacity:s.performance.geometryCapacityBytes,
            protectedTextures:t.protectedKeys.size,admissionBlocked:t.admissionBlocked.size,blockedByCapacity:t.blockedByCapacity,
            missingGeometry:r.missingCurrentGeometryCount(),pendingPriority:r.current.updateState.pendingPriorityUpdateCount,
            textureCapacity:s.performance.textureCapacityBytes,renderMs:s.performance.render.lastMs,
            oldDisplay:s.transition.displayingPreviousFrame};
        };
        const render=r.render;r.render=function(){const result=render.call(this);if(p.frames.length<16000)p.frames.push(p.snapshot());return result};
        const send=rt.abi.send;rt.abi.send=function(message,transfer,onProgress){const started=performance.now();
          const record=(v,progress)=>{
            if(message.type==='imagery')p.rpc.push({time:performance.now(),phase:p.phase,ms:performance.now()-started,streamProgress:progress,
              range:rt.camera.distance,view:v.viewRevision,currentView:rt.abi.viewRevision,mesh:v.modelRevision,
              complete:!!(v.imageryPlan&&v.imageryPlan.quality.planningComplete),pending:!!v.pending,
              continuation:!!v.continuation,coarsening:!!(v.imageryPlan&&v.imageryPlan.quality.coarsening),
              measurements:v.measurements&&v.measurements.length,age:v.cameraPlanAgeMs,progress:v.progress,
              levels:v.imageryPlan&&[v.imageryPlan.quality.selectedLevelMinimum,v.imageryPlan.quality.selectedLevelMaximum]});
            return v;
          };
          return send.call(this,message,transfer,onProgress&&((v)=>{record(v,true);onProgress(v)}))
            .then(v=>record(v,false),e=>{p.errors.push({time:performance.now(),phase:p.phase,type:message.type,error:e.message});throw e})};
        const sync=t.sync;t.sync=function(draws,retained,coarse){const result=sync.call(this,draws,retained,coarse);
          if(coarse)p.sync.push({time:performance.now(),phase:p.phase,current:r.plannedCameraVersion===r.cameraVersion,
            complete:r.current.imageryPlan.quality.planningComplete,target:histogram(this.targetDesired.values()),
            active:histogram(keys(this.scheduler.active).map(k=>({level:Number(k.split('/')[0])}))),
            partitionQueue:r.partitionQueue.reduce((n,v)=>n+v.cells.length,0)});return result};
        const schedule=t.schedule;t.schedule=function(key,tile,priority){p.requests.push({time:performance.now(),phase:p.phase,level:tile.level,key});return schedule.call(this,key,tile,priority)};
        const cancel=t.scheduler.cancelExcept;t.scheduler.cancelExcept=function(wanted){
          const active=keys(this.active).filter(k=>!wanted.has(k)&&!this.active.get(k).stale),queued=keys(this.queued).filter(k=>!wanted.has(k));
          if(active.length||queued.length)p.cancels.push({time:performance.now(),phase:p.phase,active,queued});
          return cancel.call(this,wanted)};
        const gl=r.gl,debug=gl.getExtension('WEBGL_debug_renderer_info');
        p.environment={viewport:[r.canvas.width,r.canvas.height],dpr:rt.budget.devicePixelRatio,
          renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
          vendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR)};
      })()`)
      const sample = async tag => {
        const s = await expressionValue(connection, `(function(){const p=window.__coarseFocus,s=p.snapshot(),rt=window.__terraProductDemo.viewer.runtime;
          s.wasm=rt.state().performance.wasmMemoryBytes;s.tag=${JSON.stringify(tag)};return s})()`)
        report.samples.push(s); save(); return s
      }
      const phase = name => expressionValue(connection, `window.__coarseFocus.phase=${JSON.stringify(name)}`)
      const screenshot = async name => {
        await connection.call('Page.enable')
        const shot=await connection.call('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false},10000)
        fs.writeFileSync(domOutput+'.'+name+'.png',Buffer.from(shot.data,'base64'))
      }
      async function settle(name, timeout, near) {
        const until=Math.min(deadline-5000,Date.now()+timeout)
        let last=null
        while(Date.now()<until){
          last=await sample(name)
          const fine=Object.entries(last.presented).some(([level,n])=>Number(level)>=10&&n>0)
          if(!last.transitioning&&last.complete&&last.cameraCurrent&&last.coverage&&last.targetMissing===0&&
              last.requestsActive===0&&last.requestsQueued===0&&last.missing===0&&
              !last.oldDisplay&&Number.isFinite(last.error)&&(!near||fine))return last
          await delay(200)
        }
        return last
      }
      const center=await expressionValue(connection, `(function(){const b=document.querySelector('canvas').getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2}})()`)
      let scenarios=[{name:'instant-oblique',mode:'instant',tilt:76.3},
        {name:'fast-wheel-oblique',mode:'wheel',tilt:76.3},
        {name:'staged-wheel-oblique',mode:'staged',tilt:76.3},
        {name:'fast-wheel-top',mode:'wheel',tilt:0}]
      if(options.cases){
        const names=options.cases.split(',')
        if(names.some(name=>!scenarios.some(s=>s.name===name)))throw new Error('Unknown fine-to-coarse case')
        scenarios=scenarios.filter(s=>names.includes(s.name))
      }
      for(const scenario of scenarios){
        if(Date.now()>deadline-40000)throw new Error('Insufficient time for another bounded fine-to-coarse case')
        const c={...scenario,passed:false};report.cases.push(c);save()
        await phase(scenario.name+':warm')
        await expressionValue(connection, `(function(){const d=window.__terraProductDemo,rt=d.viewer.runtime;
          d.viewer.camera.setView({target:{longitudeDegrees:116.5623,latitudeDegrees:40.74863},
            rangeMeters:rt.rangeLimits().minimum,tiltDegrees:${scenario.tilt},headingDegrees:14.5})})()`)
        const warm=await settle(scenario.name+':warm',60000,true)
        c.warm=warm
        c.startFullyComplete=!!(warm&&warm.complete&&warm.cameraCurrent&&warm.targetMissing===0&&
          warm.requestsActive===0&&warm.requestsQueued===0)
        c.startFineTiles=warm?Object.entries(warm.presented).filter(([k])=>Number(k)>=10).reduce((n,[,v])=>n+v,0):0
        check(scenario.name+':fine-start',warm&&warm.coverage&&warm.missing===0&&c.startFineTiles>=16,
          {fineTiles:c.startFineTiles,fullyComplete:c.startFullyComplete,warm})
        if(!report.checks[report.checks.length-1].passed)throw new Error('An already displayed fine starting cut was not established: '+scenario.name)
        await screenshot(scenario.name+'-fine')
        await expressionValue(connection, `(function(){const p=window.__coarseFocus,r=window.__terraProductDemo.viewer.runtime.renderer;
          p.original=new Set(Array.from(r.presentedTextures).filter(([,t])=>t.level>=8).map(([key])=>key))})()`)
        await phase(scenario.name+':ascent')
        const start=await sample(scenario.name+':start');c.start=start
        if(scenario.mode==='instant'){
          await expressionValue(connection, `(function(){const d=window.__terraProductDemo,v=d.viewer.camera.getView();
            v.rangeMeters=d.viewer.runtime.manifest.radius*18;d.viewer.camera.setView(v)})()`)
        }else{
          for(let i=0;i<34;i++){
            if(Date.now()>deadline-10000)throw new Error('Ascent deadline exceeded')
            await connection.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:center.x,y:center.y,deltaX:0,deltaY:286})
            await delay(scenario.mode==='staged'?60:25)
            if(i%5===0)await sample(scenario.name+':input-'+i)
            if(scenario.mode==='staged'&&i===17){
              await phase(scenario.name+':regional')
              const regional=await settle(scenario.name+':regional',45000,false);c.regional=regional
              check(scenario.name+':regional-complete',regional&&regional.complete&&regional.cameraCurrent&&regional.targetMissing===0,regional)
              await screenshot(scenario.name+'-regional')
              await phase(scenario.name+':ascent')
            }
          }
        }
        c.stop=await sample(scenario.name+':stop')
        await phase(scenario.name+':settle')
        const final=await settle(scenario.name+':settle',20000,false);c.final=final
        c.convergedMs=final.time-c.stop.time
        check(scenario.name+':global-converged',final&&final.complete&&final.cameraCurrent&&final.targetMissing===0&&
          final.requestsActive===0&&final.requestsQueued===0&&final.coverage&&final.missing===0&&
          final.range>start.range*3&&final.resolved[1]<=2&&final.selected[1]<=2,final)
        check(scenario.name+':fine-presentation-retired',final.originalPresented===0&&
          !Object.keys(final.presented).some(k=>Number(k)>=8),{remaining:final.originalPresented,presented:final.presented,cache:final.cache})
        check(scenario.name+':global-target-quality',Number.isFinite(final.error)&&
          final.error<=final.targetError*1.001&&!final.limitedByBudget&&final.failed===0,
          {error:final.error,target:final.targetError,limitedByBudget:final.limitedByBudget})
        await screenshot(scenario.name+'-coarse')
        await delay(1500)
        const stable=await sample(scenario.name+':stable');c.stable=stable
        check(scenario.name+':no-late-fine-demand',stable.requestsActive===0&&stable.requestsQueued===0&&stable.targetMissing===0&&
          !Object.keys(stable.target).some(k=>Number(k)>=8)&&stable.originalPresented===0,stable)
        const trace=await expressionValue(connection, `(function(){const p=window.__coarseFocus;
          return{frames:p.frames.filter(v=>v.phase.startsWith(${JSON.stringify(scenario.name+':')})&&v.time>=${start.time}),
            rpc:p.rpc.filter(v=>v.phase.startsWith(${JSON.stringify(scenario.name+':')})&&v.time>=${start.time}),
            sync:p.sync.filter(v=>v.phase.startsWith(${JSON.stringify(scenario.name+':')})&&v.time>=${start.time}),
            cancels:p.cancels.filter(v=>v.phase.startsWith(${JSON.stringify(scenario.name+':')})&&v.time>=${start.time})}})()`)
        const f=trace.frames
        c.frames=f.length;c.zeroDrawFrames=f.filter(v=>v.draws===0).length;c.missingFrames=f.filter(v=>v.missing!==0).length
        c.capacityFrames=f.filter(v=>v.cacheBytes>v.textureCapacity||v.geometryBytes>v.geometryCapacity||v.partitionBytes>v.partitionCapacity).length
        c.maximumRenderMs=Math.max(0,...f.map(v=>v.renderMs||0))
        c.maximumRpcMs=Math.max(0,...trace.rpc.map(v=>v.ms))
        const firstCoarse=trace.sync.find(v=>v.current)
        c.firstCoarseDemandMs=firstCoarse?firstCoarse.time-start.time:null
        const latest=trace.rpc.find(v=>v.view===final.cameraRevision&&v.measurements>0)
        c.latestUsableAfterStopMs=latest?Math.max(0,latest.time-c.stop.time):null
        const retired=f.find(v=>v.time>=c.stop.time&&v.originalPresented===0&&v.cameraCurrent)
        c.fineRetiredAfterStopMs=retired?retired.time-c.stop.time:null
        c.cancelledActive=trace.cancels.reduce((n,v)=>n+v.active.length,0)
        c.cancelledQueued=trace.cancels.reduce((n,v)=>n+v.queued.length,0)
        check(scenario.name+':continuous-coverage',f.length>5&&c.zeroDrawFrames===0&&c.missingFrames===0,{frames:c.frames,zero:c.zeroDrawFrames,missing:c.missingFrames})
        check(scenario.name+':capacity',c.capacityFrames===0,{exceededFrames:c.capacityFrames})
        check(scenario.name+':coarsening-admitted',!!firstCoarse,{firstCoarseDemandMs:c.firstCoarseDemandMs})
        check(scenario.name+':latest-camera-takeover',c.latestUsableAfterStopMs!==null&&c.latestUsableAfterStopMs<4000,{ms:c.latestUsableAfterStopMs})
        c.passed=report.checks.filter(v=>v.name.startsWith(scenario.name+':')).every(v=>v.passed)
        save();console.log(JSON.stringify({name:c.name,passed:c.passed,startFullyComplete:c.startFullyComplete,
          startFineTiles:c.startFineTiles,nearLevels:warm.resolved,globalLevels:final.resolved,
          firstCoarseDemandMs:c.firstCoarseDemandMs,latestUsableAfterStopMs:c.latestUsableAfterStopMs,
          convergedMs:c.convergedMs,fineRetiredAfterStopMs:c.fineRetiredAfterStopMs,
          frames:c.frames,maximumRenderMs:c.maximumRenderMs,maximumRpcMs:c.maximumRpcMs,
          oldFineCached:stable.originalCached,cancelledActive:c.cancelledActive,cancelledQueued:c.cancelledQueued}))
      }
      report.trace=await expressionValue(connection, `(function(){const p=window.__coarseFocus;
        return{environment:p.environment,frames:p.frames,rpc:p.rpc,sync:p.sync,requests:p.requests,cancels:p.cancels,errors:p.errors}})()`)
      check('no-fatal-worker-errors',!report.trace.errors.some(v=>!/Stale Worker imagery frame/.test(v.error)),report.trace.errors)
      report.passed=report.cases.length===scenarios.length&&report.checks.every(v=>v.passed)
      report.finished=new Date().toISOString();save()
      fs.writeFileSync(domOutput,await expressionValue(connection,"'<!DOCTYPE html>\\n'+document.documentElement.outerHTML"))
      console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,checks:report.checks.length,environment:report.trace.environment}))
      if(!report.passed)throw new Error('One or more fine-to-coarse checks failed')
    } catch(error) {
      report.error=error.message;report.finished=new Date().toISOString()
      try{report.trace=await expressionValue(connection, `(function(){const p=window.__coarseFocus;return p&&{environment:p.environment,
        frames:p.frames,rpc:p.rpc,sync:p.sync,requests:p.requests,cancels:p.cancels,errors:p.errors}})()`)}catch(_){}
      save();throw error
    }
  } finally {
    if (connection) {
      try { await expressionValue(connection, 'window.__terraProductDemo && window.__terraProductDemo.destroy()') } catch (error) {}
    }
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

main().catch((error) => {
  console.error(`Browser evidence runner failed: ${error.message || error}`)
  process.exitCode = 1
})
