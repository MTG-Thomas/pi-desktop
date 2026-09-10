# pi-bus

Inter-session message bus tools for Pi. Pairs with the Pi Desktop bus broker
(`src/main/bus-broker.ts` + `src/main/ipc/bus-handlers.ts`).

## Install

Headless (plain Pi CLI — posts persist to `~/.local/share/pi-bus/bus.jsonl`,
read back with `bus_read`):

```bash
pi -e ./pi-bus/index.ts
```

Routed (Pi Desktop with the `feat/bus-mvp` broker): install as a Pi package so
every session carries the tool, then the broker snoops `bus_post` calls off
the event stream and delivers them. The file log is additive — Desktop
routing is unaffected.

## Headless appserver (single machine)

`broker.mjs` + `PiBus.psm1` are the Codex-appserver equivalent for
`pi --mode rpc` children: spawn/list/turn/steer/read over loopback HTTP
(default `:4098`, basic auth in `~/.local/share/pi-bus/broker.json`, never
committed). Node builtins only, no dependencies.

```powershell
Import-Module ./pi-bus/PiBus.psm1
Start-PiBusBroker
New-PiBusSession -Title 'auth worker' -Model 'opencode-go/muse-spark-1.3-contributor'
Send-PiBusPrompt -SessionId <id> -Text '...'   # blocking turn
New-PiBusSession -Title 'helper' -Fork <session-file>  # enroll by fork
New-PiBusSession -Title 'trial' -Extensions @('npm:pi-agent-goal')  # trial extensions, no global install
```

## goal-bus

`goal-bus/` announces Pi-Agent-Goal transitions on the bus: completions as
`task.result`, new blockers as `op.announce`. See `goal-bus/README.md`.
Link a goal with the `goal_bus_link` tool; trial verified cache-stable
prefixes (per-turn input 6729 → ~200–500 tokens as `cacheRead` climbs).

Ownership: the broker owns ONLY sessions it spawned. Never drive a
harness-owned LIVE thread (interactive TUI, Desktop pane) — fork it or
hand it off (see `skills/bus/SKILL.md`).

## Protocol

| Topic | Use |
|---|---|
| `task.dispatch` / `task.result` | Fan-out + report, correlated by `threadId` |
| `plan.propose` / `plan.critique` / `plan.consensus` | Council converge |
| `code.review-request` / `code.review-verdict` | Review round-trip |
| `op.announce` / `op.question` / `op.answer` | Operator chatter |

Delivery: `follow_up` by default, `steer` when `urgent: true`. Untrusted
workspaces may announce/answer/report but never dispatch or propose into a
trusted one.
