/**
 * pi-bus — inter-session message bus tools.
 *
 * `bus_post` is the transport: Pi Desktop's main-process broker snoops this
 * tool's calls off the Pi event stream (`tool_execution_start`), validates
 * them against the shared bus policy, and injects the envelope into target
 * sessions via `follow_up` (or `steer` when urgent). The tool itself just
 * acks, so the same extension works headless under a plain `pi` CLI, where
 * posts are visible in the transcript but not routed.
 *
 * Conventions (keep boring, keep typed):
 * - payloads are Markdown, <8KB. Full diffs travel as file path + link.
 * - `threadId` correlates a task round-trip: dispatch → result(s).
 * - prefer topic broadcast over `toRuntimeId` direct; direct is for answers.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const Topic = Type.Union(
  [
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
  ].map((t) => Type.Literal(t)),
)

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'bus_post',
    label: 'Bus post',
    description: [
      'Send a message to other agent sessions via the desktop broker.',
      'Use task.dispatch to fan out work (set threadId), task.result to report back on a thread.',
      'Use plan.* for council-style converge, code.review-request for review, op.* for operator chatter.',
      'Payload is Markdown under 8KB; link files instead of pasting diffs.',
    ].join(' '),
    parameters: Type.Object({
      topic: Topic,
      payload: Type.String({ description: 'Markdown message body, under 8KB' }),
      threadId: Type.Optional(Type.String({ description: 'Correlation id for a task round-trip' })),
      toRuntimeId: Type.Optional(Type.String({ description: 'Direct delivery; omit for topic broadcast' })),
      urgent: Type.Optional(Type.Boolean({ description: 'Steer (interrupt) instead of queueing behind the turn' })),
    }),
    async execute(_toolCallId, params) {
      const scope = params.toRuntimeId ? `→ ${params.toRuntimeId}` : 'broadcast'
      const thread = params.threadId ? ` [${params.threadId}]` : ''
      return {
        content: [{ type: 'text', text: `Posted ${params.topic}${thread} (${scope}).` }],
        details: { topic: params.topic, threadId: params.threadId ?? null },
      }
    },
  })

  pi.registerCommand('bus-threads', {
    description: 'Remind me of the bus topic/thread conventions',
    handler: async (_args, ctx) => {
      ctx.ui.notify('bus: dispatch→result share a threadId; broadcasts beat directs; diffs via file links.', 'info')
    },
  })
}
