# goal-bus

Announce Pi-Agent-Goal transitions on the bus. Watches `goal-state`
session entries after each turn; on first completion or each new blocker,
appends a bus envelope to `~/.local/share/pi-bus/bus.jsonl` (same format
as pi-bus `bus_post`):

- completions → `task.result`
- new blockers → `op.announce` (never urgent: no cross-process steer)

Progress-only updates never post. Thread linkage is explicit via the
`goal_bus_link` tool (`goalId` → `threadId`); unlinked goals fall back to
broadcast. When exactly one link and one goal exist, that link applies.

## Files

- `goals.ts` — pure transition logic, no pi imports. Node-testable:
  `node -e "import('./goals.ts').then(...)"` (relies on Node type stripping).
- `index.ts` — thin pi wiring: `turn_end`/`session_start` scan, sidecars
  (`goal-seen.json`, `goal-threads.json` under the bus dir), bus append.

## Design notes

- State diffing, not event interception: entries are append-only and
  branch-local, so forks/`/tree`/reload follow the selected branch.
- Inject-once per completion / per blocker string; first sight records
  silently (except already-complete, which announces once).
- Bookkeeping failures never break the agent turn (all guarded).
