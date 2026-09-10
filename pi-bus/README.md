# pi-bus

Inter-session message bus tools for Pi. Pairs with the Pi Desktop bus broker
(`src/main/bus-broker.ts` + `src/main/ipc/bus-handlers.ts`).

## Install

Headless (plain Pi CLI — posts ack locally, no routing):

```bash
pi -e ./pi-bus/index.ts
```

Routed (Pi Desktop with the `feat/bus-mvp` broker): install as a Pi package so
every session carries the tool, then the broker snoops `bus_post` calls off
the event stream and delivers them.

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
