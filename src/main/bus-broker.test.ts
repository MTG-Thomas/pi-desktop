import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createBusBroker, type BusRuntime } from './bus-broker'

function fakeManager() {
  const emitter = new EventEmitter() as EventEmitter & {
    sent: Array<Record<string, unknown>>
    sendCommand(cmd: Record<string, unknown>): Promise<null>
  }
  emitter.sent = []
  emitter.sendCommand = async (cmd: Record<string, unknown>) => {
    emitter.sent.push(cmd)
    return null
  }
  return emitter
}

function setup() {
  const a = fakeManager()
  const b = fakeManager()
  const runtimes: BusRuntime[] = [
    { runtimeId: 'a', workspaceId: 'w1', manager: a as never },
    { runtimeId: 'b', workspaceId: 'w1', manager: b as never },
  ]
  const broadcasted: Array<{ topic: string }> = []
  const broker = createBusBroker({
    listRuntimes: () => runtimes,
    runtimeFor: (m) => runtimes.find((r) => r.manager === (m as never)) ?? null,
    isTrusted: () => true,
    broadcastEnvelope: (e) => void broadcasted.push(e),
    newId: (() => {
      let n = 0
      return () => `id-${++n}`
    })(),
    now: () => 0,
  })
  return { a, b, runtimes, broadcasted, broker }
}

describe('bus broker', () => {
  it('delivers a broadcast post to subscribed runtimes but not the sender', () => {
    const { a, b, runtimes, broker } = setup()
    broker.subscribe('b', ['task.result'])
    const result = broker.post(runtimes[0], { topic: 'task.result', payload: 'done', threadId: 't1' })
    assert.equal(result.ok, true)
    assert.equal(b.sent.length, 1)
    assert.equal(a.sent.length, 0)
    assert.match(b.sent[0].message as string, /\[bus:task\.result thread:t1 from:a\]/)
  })

  it('delivers direct posts by runtime id', () => {
    const { b, runtimes, broker } = setup()
    const result = broker.post(runtimes[0], { topic: 'op.question', payload: 'ping?', toRuntimeId: 'b' })
    assert.equal(result.ok, true)
    assert.equal(b.sent.length, 1)
  })

  it('uses steer for urgent posts', () => {
    const { b, runtimes, broker } = setup()
    broker.post(runtimes[0], { topic: 'op.question', payload: 'stop!', toRuntimeId: 'b', urgent: true })
    assert.equal(b.sent[0].type, 'steer')
  })

  it('rejects invalid posts without delivering', () => {
    const { b, runtimes, broker } = setup()
    const result = broker.post(runtimes[0], { topic: 'nope' as never, payload: '' })
    assert.equal(result.ok, false)
    assert.equal(b.sent.length, 0)
  })

  it('blocks untrusted task.dispatch across the trust boundary', () => {
    const { b, runtimes } = setup()
    const untrusted = createBusBroker({
      listRuntimes: () => runtimes,
      runtimeFor: (m) => runtimes.find((r) => r.manager === (m as never)) ?? null,
      isTrusted: () => false,
      broadcastEnvelope: () => {},
      newId: () => 'x',
      now: () => 0,
    })
    untrusted.subscribe('b', ['task.dispatch'])
    untrusted.post(runtimes[0], { topic: 'task.dispatch', payload: 'do evil' })
    assert.equal(b.sent.length, 0)
  })

  it('snoops bus_post tool calls off the event stream', () => {
    const { a, b, broker } = setup()
    broker.attachManager(a as never)
    broker.subscribe('b', ['op.announce'])
    a.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'bus_post',
      args: { topic: 'op.announce', payload: 'hello all' },
    })
    assert.equal(b.sent.length, 1)
    assert.equal(broker.list().length, 1)
  })

  it('ignores other tools and unknown topics on the stream', () => {
    const { a, b, broker } = setup()
    broker.attachManager(a as never)
    a.emit('event', { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} })
    a.emit('event', {
      type: 'tool_execution_start',
      toolCallId: 'c2',
      toolName: 'bus_post',
      args: { topic: 'bogus', payload: 'x' },
    })
    assert.equal(b.sent.length, 0)
    assert.equal(broker.list().length, 0)
  })
})
