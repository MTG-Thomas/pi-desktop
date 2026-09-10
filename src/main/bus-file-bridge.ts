import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BusEnvelope } from '../shared/ipc-contracts'
import { BUS_MAX_PAYLOAD_CHARS, isBusTopic } from '../shared/bus-policy'

/**
 * Headless file-bus bridge: tails the append-only log the `bus_post`
 * extension tool writes (`~/.local/share/pi-bus/bus.jsonl`, same path the
 * extension resolves) and ingests new entries into the broker so headless
 * traffic surfaces in Desktop sessions and the inbox.
 *
 * Two transports, one shared history — dedup rules keep it that way:
 * - Tail-from-now: entries older than bridge start (minus a small grace for
 *   the startup race) are never routed. No history floods on launch.
 * - Owned-sender skip: a post executed inside a Desktop-managed Pi process
 *   is already routed by the broker's `bus_post` snoop off the event stream,
 *   so file entries from live managed pids / session files are skipped.
 * - Malformed lines and oversized payloads are skipped, never fatal.
 *
 * Trust: file senders are not workspace members, so they arrive with
 * `fromWorkspaceId: 'headless'`, which the trust gate treats as untrusted
 * (announce/answer/report route; dispatch/propose do not). Everything still
 * lands in the broker log and the EVENT_BUS broadcast, so the operator sees
 * all of it in the inbox either way.
 */

export const BUS_HEADLESS_WORKSPACE_ID = 'headless'

/** Grace for posts written while the bridge was starting. */
export const BUS_BRIDGE_START_GRACE_MS = 30 * 1000

/** Poll cadence: cheap on an append-only file, no watcher handles to leak. */
export const BUS_BRIDGE_POLL_MS = 2000

export function defaultBusFilePath(): string {
  return join(homedir(), '.local', 'share', 'pi-bus', 'bus.jsonl')
}

export interface FileBusSender {
  host?: unknown
  pid?: unknown
  sessionFile?: unknown
}

export interface FileBusLine {
  id?: unknown
  ts?: unknown
  topic?: unknown
  threadId?: unknown
  payload?: unknown
  toRuntimeId?: unknown
  urgent?: unknown
  from?: unknown
}

/** Live Desktop-managed senders, for the owned-sender skip. */
export interface BusBridgeLiveSender {
  pid: number | null
  sessionFile: string | null
}

/** File lines kept for the startup backfill (append-only, never routed). */
export const BUS_BRIDGE_SEED_LINES = 200

export interface BusFileBridgeDeps {
  busFilePath(): string
  /** Raw new bytes appended since `position`, plus the new position. */
  readAppended(position: number): { text: string; position: number }
  liveSenders(): BusBridgeLiveSender[]
  ingest(envelope: BusEnvelope): void
  seed(envelopes: BusEnvelope[]): void
  now(): number
  /** setInterval/clearInterval seam so tests drive ticks manually. */
  setPoll(fn: () => void, ms: number): unknown
  clearPoll(handle: unknown): void
}

export interface BusFileBridge {
  /** One poll tick (also called on this interval). Returns ingested count. */
  poll(): number
  stop(): void
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseTs(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/**
 * Map one file line to a broker envelope, or null when it must be skipped.
 * With `history: true` (startup backfill) the tail-from-now and
 * owned-sender checks are lifted: backfill only lands in the broker log
 * for the inbox, it is never routed into sessions.
 */
export function fileLineToEnvelope(
  line: FileBusLine,
  opts: { now: number; startTs: number; live: BusBridgeLiveSender[]; history?: boolean },
): BusEnvelope | null {
  if (typeof line.id !== 'string' || line.id === '') return null
  if (!isBusTopic(line.topic)) return null
  if (typeof line.payload !== 'string' || line.payload === '') return null
  if (line.payload.length > BUS_MAX_PAYLOAD_CHARS) return null

  const ts = parseTs(line.ts, opts.now)
  if (!opts.history && ts < opts.startTs - BUS_BRIDGE_START_GRACE_MS) return null

  const from = asRecord(line.from)
  const pid = typeof from?.pid === 'number' ? from.pid : null
  const sessionFile = typeof from?.sessionFile === 'string' ? from.sessionFile : null
  if (
    !opts.history &&
    opts.live.some(
      (sender) => (pid !== null && sender.pid === pid) || (sessionFile !== null && sender.sessionFile === sessionFile),
    )
  ) {
    return null
  }

  return {
    topic: line.topic,
    payload: line.payload,
    toRuntimeId: typeof line.toRuntimeId === 'string' ? line.toRuntimeId : undefined,
    scope: 'global',
    threadId: typeof line.threadId === 'string' ? line.threadId : undefined,
    urgent: line.urgent === true,
    id: line.id,
    ts,
    fromRuntimeId: `headless:${typeof from?.host === 'string' ? from.host : 'unknown'}:${pid ?? 'unknown'}`,
    fromWorkspaceId: BUS_HEADLESS_WORKSPACE_ID,
  }
}

export function createBusFileBridge(deps: BusFileBridgeDeps): BusFileBridge {
  const startTs = deps.now()
  let position = 0
  let stopped = false

  // One bounded backfill so a fresh app shows recent threads. History only:
  // parsed leniently, appended to the log, never routed into sessions.
  try {
    const full = deps.readAppended(0)
    position = full.position
    const lines = full.text.split('\n').filter((raw) => raw.trim() !== '')
    const seeded: BusEnvelope[] = []
    for (const raw of lines.slice(-BUS_BRIDGE_SEED_LINES)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      const envelope = fileLineToEnvelope(asRecord(parsed) ?? {}, {
        now: startTs,
        startTs,
        live: [],
        history: true,
      })
      if (envelope) seeded.push(envelope)
    }
    // position sits at EOF now, so the live tail never re-reads these.
    deps.seed(seeded)
  } catch {
    // A missing or unreadable file just means no history yet.
  }

  const poll = (): number => {
    if (stopped) return 0
    let ingested = 0
    let chunk: { text: string; position: number }
    try {
      chunk = deps.readAppended(position)
    } catch {
      return 0
    }
    position = chunk.position
    if (!chunk.text) return 0
    const live = deps.liveSenders()
    const now = deps.now()
    for (const raw of chunk.text.split('\n')) {
      const trimmed = raw.trim()
      if (!trimmed) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }
      const envelope = fileLineToEnvelope(asRecord(parsed) ?? {}, { now, startTs, live })
      if (!envelope) continue
      try {
        deps.ingest(envelope)
        ingested++
      } catch {
        // One bad delivery must not stall the tail.
      }
    }
    return ingested
  }

  const handle = deps.setPoll(poll, BUS_BRIDGE_POLL_MS)
  return {
    poll,
    stop: () => {
      stopped = true
      deps.clearPoll(handle)
    },
  }
}
