/**
 * goal-bus — pure goal-transition logic (no pi imports; node-testable).
 *
 * Mirrors Pi-Agent-Goal's session-entry shape without depending on it:
 * entries with type "custom", customType "goal-state", data.state as the
 * current GoalState (or null when cleared). The watcher keeps a `seen`
 * sidecar and emits one transition per completion / new blocker.
 */

export interface GoalLite {
  goalId: string
  objective: string
  status: string
  blocked: string[]
  completedAt?: number
}

export interface SeenEntry {
  status: string
  announcedComplete: boolean
  announcedBlocked: string[]
}

export type SeenMap = Record<string, SeenEntry>

export interface Transition {
  goalId: string
  kind: 'complete' | 'blocked'
  objective: string
  detail: string
}

interface MaybeEntry {
  type?: unknown
  customType?: unknown
  data?: unknown
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Latest state per goalId from a branch entry list. Cleared goals drop out. */
export function snapshotGoals(entries: readonly unknown[]): GoalLite[] {
  const byId = new Map<string, GoalLite | null>()
  for (const e of entries) {
    if (!isRecord(e)) continue
    const r = e as MaybeEntry
    if (r.type !== 'custom' || r.customType !== 'goal-state') continue
    if (!isRecord(r.data)) continue
    const data = r.data as { state?: unknown }
    if (data.state === null || data.state === undefined) continue
    if (!isRecord(data.state)) continue
    const s = data.state as {
      goalId?: unknown
      objective?: unknown
      status?: unknown
      completedAt?: unknown
      progress?: unknown
    }
    if (typeof s.goalId !== 'string' || typeof s.objective !== 'string' || typeof s.status !== 'string') continue
    let blocked: string[] = []
    if (isRecord(s.progress) && Array.isArray((s.progress as { blocked?: unknown }).blocked)) {
      blocked = (s.progress as { blocked: unknown[] }).blocked.filter(
        (b): b is string => typeof b === 'string' && b.trim().length > 0,
      )
    }
    const goal: GoalLite = {
      goalId: s.goalId,
      objective: s.objective,
      status: s.status,
      blocked,
      ...(typeof s.completedAt === 'number' ? { completedAt: s.completedAt } : {}),
    }
    byId.set(s.goalId, goal)
  }
  return [...byId.values()].filter((g): g is GoalLite => g !== null)
}

/**
 * Resolve the bus thread for a goal. Exact goalId match wins; when there is
 * exactly one link and exactly one goal, that link applies (single-goal
 * sessions are the norm and agents sometimes link by status word).
 * Otherwise null, and the caller falls back to broadcast.
 */
export function resolveThread(
  links: Record<string, string>,
  goalId: string,
  goals: readonly GoalLite[],
): string | null {
  if (links[goalId]) return links[goalId]
  const keys = Object.keys(links)
  if (keys.length === 1 && goals.length === 1) return links[keys[0]]
  return null
}

/**
 * Diff current goals against the seen sidecar. Returns transitions plus the
 * updated sidecar (caller persists it). First sight records silently.
 */
export function diffGoals(seen: SeenMap, goals: readonly GoalLite[]): { transitions: Transition[]; seen: SeenMap } {
  const next: SeenMap = { ...seen }
  const transitions: Transition[] = []
  for (const g of goals) {
    const prev = next[g.goalId]
    if (!prev) {
      next[g.goalId] = { status: g.status, announcedComplete: false, announcedBlocked: [] }
      // A goal first seen already complete still deserves one announcement.
      if (g.status === 'complete') {
        transitions.push({
          goalId: g.goalId,
          kind: 'complete',
          objective: g.objective,
          detail: 'Goal already complete on first sight.',
        })
        next[g.goalId] = { status: g.status, announcedComplete: true, announcedBlocked: [...g.blocked] }
      } else {
        next[g.goalId].announcedBlocked = [...g.blocked]
      }
      continue
    }
    const freshBlockers = g.blocked.filter((b) => !prev.announcedBlocked.includes(b))
    if (freshBlockers.length > 0) {
      transitions.push({ goalId: g.goalId, kind: 'blocked', objective: g.objective, detail: freshBlockers.join('; ') })
    }
    if (g.status === 'complete' && !prev.announcedComplete) {
      transitions.push({ goalId: g.goalId, kind: 'complete', objective: g.objective, detail: 'Goal marked complete.' })
    }
    next[g.goalId] = {
      status: g.status,
      announcedComplete: prev.announcedComplete || g.status === 'complete',
      announcedBlocked: [...new Set([...prev.announcedBlocked, ...g.blocked])],
    }
  }
  return { transitions, seen: next }
}
