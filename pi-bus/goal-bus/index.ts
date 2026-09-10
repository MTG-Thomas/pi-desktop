/**
 * goal-bus — announce Pi-Agent-Goal transitions on the bus.
 *
 * Watches `goal-state` session entries after each turn. On first completion
 * or each new blocker, appends a bus envelope to
 * `~/.local/share/pi-bus/bus.jsonl` (same format as pi-bus `bus_post`):
 * completions go out as `task.result`, blockers as `op.announce`.
 *
 * Thread linkage is explicit: `goal_bus_link` maps goalId -> threadId.
 * Unlinked goals fall back to broadcast (goals are rare; no spam risk).
 * Progress-only updates never post. Criterion 3 is intentionally
 * non-urgent: no cross-process steer, poll-based delivery via bus_read.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { snapshotGoals, diffGoals, resolveThread, type SeenMap } from './goals.js'

function busRoot(): string {
  return join(homedir(), '.local', 'share', 'pi-bus')
}

function seenPath(): string {
  return join(busRoot(), 'goal-seen.json')
}

function linksPath(): string {
  return join(busRoot(), 'goal-threads.json')
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(busRoot(), { recursive: true })
    writeFileSync(path, JSON.stringify(value, null, 2))
  } catch {
    // Bookkeeping must never break the agent turn.
  }
}

function sessionKey(ctx: unknown): string | null {
  try {
    const sm = (ctx as { sessionManager?: { getSessionFile?: () => string | null } })?.sessionManager
    return sm?.getSessionFile?.() ?? null
  } catch {
    return null
  }
}

function sessionEntries(ctx: unknown): unknown[] {
  try {
    const sm = (ctx as { sessionManager?: { getBranch?: () => unknown[] } })?.sessionManager
    const branch = sm?.getBranch?.()
    return Array.isArray(branch) ? branch : []
  } catch {
    return []
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'goal_bus_link',
    label: 'Goal bus link',
    description:
      'Link a goal ID (exact ID from /goal status, not the status word) to a bus thread so goal-bus announces completions/blockers there. Omit threadId to unlink.',
    parameters: Type.Object({
      goalId: Type.String({ description: 'Pi-Agent-Goal goal ID' }),
      threadId: Type.Optional(Type.String({ description: 'Bus thread ID; omit to unlink' })),
    }),
    async execute(_toolCallId, params) {
      const links = readJson<Record<string, string>>(linksPath(), {})
      const thread = params.threadId?.trim() || null
      if (thread) {
        links[params.goalId] = thread
        writeJson(linksPath(), links)
        return { content: [{ type: 'text', text: `goal ${params.goalId} -> thread ${thread}` }], details: {} }
      }
      delete links[params.goalId]
      writeJson(linksPath(), links)
      return { content: [{ type: 'text', text: `goal ${params.goalId} unlinked (broadcast fallback)` }], details: {} }
    },
  })

  async function scan(ctx: unknown): Promise<void> {
    try {
      const entries = sessionEntries(ctx)
      if (entries.length === 0) return
      const goals = snapshotGoals(entries)
      if (goals.length === 0) return
      const seen = readJson<SeenMap>(seenPath(), {})
      const { transitions, seen: next } = diffGoals(seen, goals)
      writeJson(seenPath(), next)
      if (transitions.length === 0) return
      const links = readJson<Record<string, string>>(linksPath(), {})
      try {
        host = hostname()
      } catch {
        /* keep unknown */
      }
      for (const t of transitions) {
        const threadId = resolveThread(links, t.goalId, goals)
        const topic = t.kind === 'complete' ? 'task.result' : 'op.announce'
        const head = t.kind === 'complete' ? 'Goal complete' : 'Goal blocked'
        const objective = t.objective.length > 500 ? t.objective.slice(0, 500) + '…' : t.objective
        const payload = `${head}: ${objective}\n\n${t.detail}\n\nGoal: ${t.goalId}`
        const env = {
          id: randomUUID(),
          ts: new Date().toISOString(),
          topic,
          threadId,
          payload,
          toRuntimeId: null,
          urgent: false,
          from: { host, pid: process.pid, sessionFile: sessionKey(ctx) },
        }
        try {
          mkdirSync(busRoot(), { recursive: true })
          appendFileSync(join(busRoot(), 'bus.jsonl'), JSON.stringify(env) + '\n', 'utf-8')
        } catch {
          /* never break the turn */
        }
      }
    } catch {
      // A broken watcher must never break unrelated turns.
    }
  }

  pi.on('turn_end', async (_event, ctx) => {
    await scan(ctx)
  })

  pi.on('session_start', async (_event, ctx) => {
    await scan(ctx)
  })
}
