/**
 * Pure policy for the agent bus: topics, caps, validation, and delivery
 * matching. Shared by main + renderer so the inbox badge and the broker can
 * never disagree about what is deliverable.
 *
 * Transport note: Pi's RPC protocol has no custom extension→host channel, so
 * `bus_post` travels as an ordinary tool call. The main-process broker snoops
 * `tool_execution_start` for `toolName === BUS_TOOL_NAME`, validates the args
 * here, and injects into targets via `prompt`/`steer`/`follow_up`. The tool
 * itself just acks, which keeps the flow working headless (plain `pi` CLI).
 */

export const BUS_TOOL_NAME = 'bus_post'

export type BusScope = 'session' | 'workspace' | 'global'

export type BusTopic =
  | 'task.dispatch'
  | 'task.result'
  | 'plan.propose'
  | 'plan.critique'
  | 'plan.consensus'
  | 'code.review-request'
  | 'code.review-verdict'
  | 'op.announce'
  | 'op.question'
  | 'op.answer'

export const BUS_TOPICS: readonly BusTopic[] = [
  'task.dispatch',
  'task.result',
  'plan.propose',
  'plan.critique',
  'plan.consensus',
  'code.review-request',
  'code.review-verdict',
  'op.announce',
  'op.question',
  'op.answer',
]

/** Max payload text the broker accepts; full diffs travel as file + link. */
export const BUS_MAX_PAYLOAD_CHARS = 8 * 1024

/** Max envelopes retained per runtime inbox; oldest are evicted first. */
export const BUS_MAX_INBOX = 200

/** Max envelopes retained in the broker log ( powers BUS_LIST). */
export const BUS_MAX_LOG = 500

export function isBusTopic(value: unknown): value is BusTopic {
  return typeof value === 'string' && (BUS_TOPICS as readonly string[]).includes(value)
}

export function isBusScope(value: unknown): value is BusScope {
  return value === 'session' || value === 'workspace' || value === 'global'
}

export interface BusPostInput {
  topic: BusTopic
  payload: string
  toRuntimeId?: string
  scope?: BusScope
  threadId?: string
  urgent?: boolean
}

export interface BusEnvelope extends BusPostInput {
  id: string
  ts: number
  fromRuntimeId: string
  fromWorkspaceId: string
  scope: BusScope
}

/** Human-readable errors; empty means valid. */
export function validateBusPost(input: Record<string, unknown>): string[] {
  const errors: string[] = []
  if (!isBusTopic(input.topic)) errors.push(`Unknown topic: ${String(input.topic)}`)
  if (typeof input.payload !== 'string' || input.payload.trim() === '') {
    errors.push('payload must be a non-empty string')
  } else if (input.payload.length > BUS_MAX_PAYLOAD_CHARS) {
    errors.push(`payload exceeds ${BUS_MAX_PAYLOAD_CHARS} chars; link a file instead`)
  }
  if (input.toRuntimeId !== undefined && typeof input.toRuntimeId !== 'string') {
    errors.push('toRuntimeId must be a string')
  }
  if (input.scope !== undefined && !isBusScope(input.scope)) {
    errors.push(`Unknown scope: ${String(input.scope)}`)
  }
  if (input.threadId !== undefined && typeof input.threadId !== 'string') {
    errors.push('threadId must be a string')
  }
  if (input.urgent !== undefined && typeof input.urgent !== 'boolean') {
    errors.push('urgent must be a boolean')
  }
  return errors
}

export interface BusSubscription {
  runtimeId: string
  topics: BusTopic[]
  threadId?: string
}

/**
 * Delivery matching: a direct post goes to exactly one runtime; a broadcast
 * goes to every runtime subscribed to the topic (optionally narrowed to a
 * thread). The sender never receives its own broadcast.
 */
export function matchesSubscription(
  envelope: Pick<BusEnvelope, 'topic' | 'threadId' | 'fromRuntimeId'>,
  sub: BusSubscription,
): boolean {
  if (sub.runtimeId === envelope.fromRuntimeId) return false
  if (!sub.topics.includes(envelope.topic)) return false
  if (sub.threadId !== undefined && sub.threadId !== envelope.threadId) return false
  return true
}

/**
 * Trust rule for cross-workspace delivery. An untrusted workspace may announce
 * and answer, but may never dispatch tasks or propose plans into a trusted
 * one — a cloned repo tightens, never loosens (same posture as the
 * permission-rules workspace gate).
 */
const UNTRUSTED_SENDABLE: readonly BusTopic[] = ['op.announce', 'op.question', 'op.answer', 'task.result']

export function mayDeliverAcrossTrust(topic: BusTopic, fromTrusted: boolean): boolean {
  if (fromTrusted) return true
  return (UNTRUSTED_SENDABLE as readonly string[]).includes(topic)
}

/** Render an envelope as the user message injected into a target session. */
export function formatBusInjection(envelope: BusEnvelope): string {
  const head = `[bus:${envelope.topic}${envelope.threadId ? ` thread:${envelope.threadId}` : ''} from:${envelope.fromRuntimeId}]`
  return `${head}\n${envelope.payload}`
}
