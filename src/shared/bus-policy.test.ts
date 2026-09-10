import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatBusInjection, matchesSubscription, mayDeliverAcrossTrust, validateBusPost } from './bus-policy'

describe('validateBusPost', () => {
  it('accepts a minimal valid post', () => {
    assert.deepEqual(validateBusPost({ topic: 'op.announce', payload: 'hello' }), [])
  })

  it('rejects unknown topics and empty payloads', () => {
    const errors = validateBusPost({ topic: 'nonsense', payload: '  ' })
    assert.equal(errors.length, 2)
  })

  it('rejects oversized payloads', () => {
    const errors = validateBusPost({ topic: 'op.announce', payload: 'x'.repeat(9000) })
    assert.match(errors.join(' '), /exceeds/)
  })

  it('rejects mistyped optional fields', () => {
    const errors = validateBusPost({ topic: 'op.announce', payload: 'hi', toRuntimeId: 42, urgent: 'yes' })
    assert.equal(errors.length, 2)
  })
})

describe('matchesSubscription', () => {
  const envelope = { topic: 'task.result' as const, threadId: 't1', fromRuntimeId: 'a' }

  it('matches a subscribed runtime on topic', () => {
    assert.equal(matchesSubscription(envelope, { runtimeId: 'b', topics: ['task.result'] }), true)
  })

  it('never echoes to the sender', () => {
    assert.equal(matchesSubscription(envelope, { runtimeId: 'a', topics: ['task.result'] }), false)
  })

  it('narrows on threadId when the subscription sets one', () => {
    assert.equal(matchesSubscription(envelope, { runtimeId: 'b', topics: ['task.result'], threadId: 't2' }), false)
  })
})

describe('mayDeliverAcrossTrust', () => {
  it('trusted senders may send anything', () => {
    assert.equal(mayDeliverAcrossTrust('task.dispatch', true), true)
  })

  it('untrusted senders may announce but not dispatch', () => {
    assert.equal(mayDeliverAcrossTrust('op.announce', false), true)
    assert.equal(mayDeliverAcrossTrust('task.dispatch', false), false)
    assert.equal(mayDeliverAcrossTrust('plan.propose', false), false)
  })
})

describe('formatBusInjection', () => {
  it('carries topic, thread and sender in the header line', () => {
    const text = formatBusInjection({
      topic: 'task.result',
      payload: 'done',
      scope: 'global',
      threadId: 't1',
      id: '1',
      ts: 0,
      fromRuntimeId: 'a',
      fromWorkspaceId: 'w',
    })
    assert.match(text, /\[bus:task\.result thread:t1 from:a\]/)
  })
})
