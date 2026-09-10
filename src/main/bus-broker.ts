import type { PiRpcManager } from './pi-rpc-manager'
import type { BusEnvelope, BusPostInput, BusSubscription, BusTopic, PiRpcEvent } from '../shared/ipc-contracts'
import { type BusPostResult } from '../shared/ipc-contracts'
import {
  BUS_MAX_INBOX,
  BUS_MAX_LOG,
  BUS_TOOL_NAME,
  formatBusInjection,
  isBusTopic,
  matchesSubscription,
  mayDeliverAcrossTrust,
  validateBusPost,
} from '../shared/bus-policy'

/**
 * The agent bus broker. Owns subscriptions, the bounded delivery log, and
 * per-runtime inboxes; snoops `bus_post` tool calls off the Pi event stream
 * and injects envelopes into target sessions via `follow_up` (or `steer` when
 * urgent and the target is mid-turn).
 *
 * Electron-free factory: managers, delivery, identity and the clock arrive as
 * deps, so tests drive it with bare emitters. The one Electron-adjacent seam
 * (`workspaceManager`) is narrowed to the four lookups below.
 */

export interface BusRuntime {
  runtimeId: string
  workspaceId: string
  manager: PiRpcManager
}

export interface BusBrokerDeps {
  /** All currently live runtimes (sessions), across every workspace. */
  listRuntimes(): BusRuntime[]
  /** Runtime that owns a manager, if the manager is still live. */
  runtimeFor(manager: PiRpcManager): BusRuntime | null
  /** Workspace trust gate (untrusted senders are restricted by topic). */
  isTrusted(workspaceId: string): boolean
  /** Forward one envelope to the renderer (EVENT_BUS). */
  broadcastEnvelope(envelope: BusEnvelope): void
  newId(): string
  now(): number
}

export interface BusBroker {
  /** Wire one manager's event stream into the broker. Idempotent. */
  attachManager(manager: PiRpcManager): void
  /** Direct post (renderer BUS_POST, or tests). Sender is explicit. */
  post(from: BusRuntime, input: BusPostInput): BusPostResult
  /**
   * Ingest a pre-built envelope (file bridge). The caller owns identity
   * and validation; the broker appends, broadcasts, and routes. Returns the
   * runtime ids it was delivered to (trust-gated; empty is not an error).
   */
  ingest(envelope: BusEnvelope): string[]
  /**
   * Seed history into the log (startup backfill). Append-only: no
   * broadcast, no routing — the inbox picks it up from BUS_LIST.
   */
  seed(envelopes: BusEnvelope[]): void
  subscribe(runtimeId: string, topics: BusTopic[], threadId?: string): void
  unsubscribe(runtimeId: string, topic?: BusTopic): void
  subscriptionsFor(runtimeId: string): BusSubscription[]
  /** Newest-first bounded log (backs BUS_LIST). */
  list(limit?: number): BusEnvelope[]
  /** Bounded inbox for one runtime (backs the renderer badge). */
  inboxFor(runtimeId: string, limit?: number): BusEnvelope[]
}

const DEFAULT_SUBSCRIPTIONS: BusTopic[] = ['op.announce', 'op.question', 'op.answer']

export function createBusBroker(deps: BusBrokerDeps): BusBroker {
  const attached = new WeakSet<PiRpcManager>()
  const subscriptions = new Map<string, BusSubscription>()
  const log: BusEnvelope[] = []
  const inboxes = new Map<string, BusEnvelope[]>()

  const subscriptionFor = (runtimeId: string): BusSubscription => {
    let sub = subscriptions.get(runtimeId)
    if (!sub) {
      sub = { runtimeId, topics: [...DEFAULT_SUBSCRIPTIONS] }
      subscriptions.set(runtimeId, sub)
    }
    return sub
  }

  const appendEnvelope = (envelope: BusEnvelope): void => {
    log.push(envelope)
    if (log.length > BUS_MAX_LOG) log.splice(0, log.length - BUS_MAX_LOG)
    deps.broadcastEnvelope(envelope)
  }

  const inboxPush = (runtimeId: string, envelope: BusEnvelope): void => {
    const inbox = inboxes.get(runtimeId) ?? []
    inbox.push(envelope)
    if (inbox.length > BUS_MAX_INBOX) inbox.splice(0, inbox.length - BUS_MAX_INBOX)
    inboxes.set(runtimeId, inbox)
  }

  const deliver = (envelope: BusEnvelope, target: BusRuntime): void => {
    inboxPush(target.runtimeId, envelope)
    const message = formatBusInjection(envelope)
    // Urgent posts steer a working session; everything else waits its turn.
    // Failures here must never break the sender: the inbox + log already hold
    // the envelope, so a dead target just means "unread".
    const command = envelope.urgent ? { type: 'steer', message } : { type: 'follow_up', message }
    void Promise.resolve(target.manager.sendCommand(command)).catch(() => {})
  }

  const route = (envelope: BusEnvelope): string[] => {
    const runtimes = deps.listRuntimes()
    const delivered: string[] = []
    const fromTrusted = deps.isTrusted(envelope.fromWorkspaceId)
    if (!mayDeliverAcrossTrust(envelope.topic, fromTrusted)) return delivered

    if (envelope.toRuntimeId) {
      const target = runtimes.find((r) => r.runtimeId === envelope.toRuntimeId)
      if (target && target.runtimeId !== envelope.fromRuntimeId) {
        deliver(envelope, target)
        delivered.push(target.runtimeId)
      }
      return delivered
    }

    for (const target of runtimes) {
      if (matchesSubscription(envelope, subscriptionFor(target.runtimeId))) {
        deliver(envelope, target)
        delivered.push(target.runtimeId)
      }
    }
    return delivered
  }

  const post = (from: BusRuntime, input: BusPostInput): BusPostResult => {
    const errors = validateBusPost(input as unknown as Record<string, unknown>)
    if (errors.length > 0) return { ok: false as const, error: errors.join('; ') }
    const envelope: BusEnvelope = {
      topic: input.topic,
      payload: input.payload,
      toRuntimeId: input.toRuntimeId,
      scope: input.scope ?? 'global',
      threadId: input.threadId,
      urgent: input.urgent,
      id: deps.newId(),
      ts: deps.now(),
      fromRuntimeId: from.runtimeId,
      fromWorkspaceId: from.workspaceId,
    }
    appendEnvelope(envelope)
    route(envelope)
    return { ok: true as const, id: envelope.id }
  }

  /** Handle one streamed event: snoop `bus_post` tool calls into posts. */
  const handleManagerEvent = (manager: PiRpcManager, event: PiRpcEvent): void => {
    if (event.type !== 'tool_execution_start') return
    if (event.toolName !== BUS_TOOL_NAME) return
    const from = deps.runtimeFor(manager)
    if (!from) return
    const args = event.args as Record<string, unknown>
    if (!isBusTopic(args.topic) || typeof args.payload !== 'string') return
    post(from, {
      topic: args.topic,
      payload: args.payload,
      toRuntimeId: typeof args.toRuntimeId === 'string' ? args.toRuntimeId : undefined,
      scope: args.scope === 'session' || args.scope === 'workspace' ? args.scope : 'global',
      threadId: typeof args.threadId === 'string' ? args.threadId : undefined,
      urgent: args.urgent === true,
    })
  }

  const attachManager = (manager: PiRpcManager): void => {
    if (attached.has(manager)) return
    attached.add(manager)
    // Ensure a default subscription row exists while the runtime is live.
    const runtime = deps.runtimeFor(manager)
    if (runtime) subscriptionFor(runtime.runtimeId)
    manager.on('event', (event: PiRpcEvent) => handleManagerEvent(manager, event))
  }

  const ingest = (envelope: BusEnvelope): string[] => {
    appendEnvelope(envelope)
    return route(envelope)
  }

  const seed = (envelopes: BusEnvelope[]): void => {
    for (const envelope of envelopes) {
      log.push(envelope)
    }
    if (log.length > BUS_MAX_LOG) log.splice(0, log.length - BUS_MAX_LOG)
  }

  return {
    attachManager,
    post,
    ingest,
    seed,
    subscribe(runtimeId, topics, threadId) {
      subscriptions.set(runtimeId, { runtimeId, topics: [...topics], threadId })
    },
    unsubscribe(runtimeId, topic) {
      if (!topic) {
        subscriptions.delete(runtimeId)
        return
      }
      const sub = subscriptions.get(runtimeId)
      if (!sub) return
      sub.topics = sub.topics.filter((t) => t !== topic)
    },
    subscriptionsFor(runtimeId) {
      const sub = subscriptions.get(runtimeId)
      return sub ? [{ ...sub, topics: [...sub.topics] }] : []
    },
    list(limit = 50) {
      return log.slice(-Math.max(1, limit)).reverse()
    },
    inboxFor(runtimeId, limit = 50) {
      return (inboxes.get(runtimeId) ?? []).slice(-Math.max(1, limit)).reverse()
    },
  }
}
