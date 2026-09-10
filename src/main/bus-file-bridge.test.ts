import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUS_BRIDGE_START_GRACE_MS,
  createBusFileBridge,
  fileLineToEnvelope,
  type BusBridgeLiveSender,
} from './bus-file-bridge'
import type { BusEnvelope } from '../shared/ipc-contracts'

const NOW = 1_000_000_000_000

function line(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'file-1',
    ts: new Date(NOW).toISOString(),
    topic: 'op.announce',
    payload: 'hello',
    toRuntimeId: null,
    urgent: false,
    from: { host: 'box', pid: 4242, sessionFile: null },
    ...overrides,
  }
}

describe('fileLineToEnvelope', () => {
  const live: BusBridgeLiveSender[] = []

  it('maps a headless line to a broker envelope', () => {
    const envelope = fileLineToEnvelope(line(), { now: NOW, startTs: NOW, live })
    assert.ok(envelope)
    assert.equal(envelope.topic, 'op.announce')
    assert.equal(envelope.fromWorkspaceId, 'headless')
    assert.match(envelope.fromRuntimeId, /headless:box:4242/)
  })

  it('skips history older than the start grace', () => {
    const old = fileLineToEnvelope(line({ ts: new Date(NOW - BUS_BRIDGE_START_GRACE_MS - 1000).toISOString() }), {
      now: NOW,
      startTs: NOW,
      live,
    })
    assert.equal(old, null)
  })

  it('skips entries from live Desktop-managed pids (snoop duplicates)', () => {
    const dupe = fileLineToEnvelope(line(), {
      now: NOW,
      startTs: NOW,
      live: [{ pid: 4242, sessionFile: null }],
    })
    assert.equal(dupe, null)
  })

  it('skips entries matching a live session file', () => {
    const dupe = fileLineToEnvelope(line({ from: { host: 'box', pid: 9999, sessionFile: '/s/a.jsonl' } }), {
      now: NOW,
      startTs: NOW,
      live: [{ pid: 1111, sessionFile: '/s/a.jsonl' }],
    })
    assert.equal(dupe, null)
  })

  it('skips malformed lines, unknown topics, and oversized payloads', () => {
    assert.equal(fileLineToEnvelope({ id: 'x' }, { now: NOW, startTs: NOW, live }), null)
    assert.equal(fileLineToEnvelope(line({ topic: 'bogus' }), { now: NOW, startTs: NOW, live }), null)
    assert.equal(fileLineToEnvelope(line({ payload: 'x'.repeat(9000) }), { now: NOW, startTs: NOW, live }), null)
  })
})

describe('createBusFileBridge', () => {
  it('tails appended bytes and ingests new entries only', () => {
    let file = `${JSON.stringify(line({ id: 'a' }))}\n`
    const ingested: BusEnvelope[] = []
    const bridge = createBusFileBridge({
      busFilePath: () => '/tmp/bus.jsonl',
      readAppended: (position) => {
        const text = file.slice(position)
        return { text, position: file.length }
      },
      liveSenders: () => [],
      ingest: (envelope) => void ingested.push(envelope),
      now: () => NOW,
      setPoll: () => 'timer',
      clearPoll: () => {},
    })
    assert.equal(bridge.poll(), 1)
    assert.equal(bridge.poll(), 0)
    file += `${JSON.stringify(line({ id: 'b', payload: 'second' }))}\nnot-json\n`
    assert.equal(bridge.poll(), 1)
    assert.deepEqual(
      ingested.map((e) => e.id),
      ['a', 'b'],
    )
    bridge.stop()
  })

  it('a dead file never breaks the poll loop', () => {
    const bridge = createBusFileBridge({
      busFilePath: () => '/tmp/missing.jsonl',
      readAppended: () => {
        throw new Error('gone')
      },
      liveSenders: () => [],
      ingest: () => {},
      now: () => NOW,
      setPoll: () => 'timer',
      clearPoll: () => {},
    })
    assert.equal(bridge.poll(), 0)
    bridge.stop()
  })
})
