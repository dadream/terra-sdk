const assert = require('assert')
const {CdpConnection, expressionValue} = require('../../scripts/run_chromium_evidence')

class Socket {
  constructor() { this.readyState = Socket.OPEN; this.sent = [] }
  send(message) { this.sent.push(JSON.parse(message)) }
  reply(message) { this.onmessage({data:JSON.stringify(message)}) }
  close() { this.closed = true }
}
Socket.OPEN = 1

async function main() {
  const connection = new CdpConnection('fixture', Socket)
  await connection.ready()
  const first = connection.call('first'), second = connection.call('second')
  connection.socket.reply({id:2,result:{done:2}})
  connection.socket.reply({id:1,result:{done:1}})
  assert.deepStrictEqual(await first,{done:1}); assert.deepStrictEqual(await second,{done:2})
  assert.strictEqual(connection.pending.size,0)
  const request = connection.call('pending'), rejected = assert.rejects(request,/closed \(1009\): payload/)
  connection.socket.onclose({code:1009,reason:'payload'})
  assert.strictEqual(connection.pending.size,0,'Disconnect retained command timers until timeout')
  await rejected
  await assert.rejects(connection.call('later'),/closed \(1009\)/)
  connection.close(); assert(connection.socket.closed)

  const opening = new CdpConnection('fixture', Socket)
  opening.socket.readyState = 0
  const waiting = assert.rejects(opening.ready(),/closed/)
  opening.socket.onclose({code:1006,reason:''})
  assert.strictEqual(opening.opening.size,0,'Failed opening retained its timer')
  await waiting; opening.close()

  const failed = new CdpConnection('fixture', Socket)
  const evaluation = assert.rejects(expressionValue(failed,'private source','final DOM capture'),
    error => /WebSocket failed: parser failed during final DOM capture/.test(error.message) &&
      !error.message.includes('private source'))
  failed.socket.onerror({error:new Error('parser failed')})
  assert.strictEqual(failed.pending.size,0)
  await evaluation; failed.close()

  const send = new CdpConnection('fixture', Socket)
  send.socket.send = () => { throw new Error('socket closed during send') }
  await assert.rejects(send.call('send'),/closed during send/)
  assert.strictEqual(send.pending.size,0); send.close()

  const malformed = new CdpConnection('fixture', Socket)
  const invalid = assert.rejects(malformed.call('invalid'),/Invalid DevTools message/)
  malformed.socket.onmessage({data:'not json'})
  await invalid; assert.strictEqual(malformed.pending.size,0); malformed.close()
  console.log('DevTools response routing, disconnect/error propagation, timer cleanup and evaluation labels passed')
}

main().catch(error => {console.error(error); process.exitCode=1})
