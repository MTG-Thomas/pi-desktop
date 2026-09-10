import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'node:fs'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { createBusFileBridge, defaultBusFilePath, type BusFileBridge } from '../bus-file-bridge'
import { IPC_CHANNELS, type BusPostInput, type BusPostResult, type BusTopic } from '../../shared/ipc-contracts'
import { isBusTopic } from '../../shared/bus-policy'
import { createBusBroker, type BusBroker, type BusRuntime } from '../bus-broker'
import { workspaceTrustStore } from '../workspace-trust'
import { assertTrustedSender, isObject, isOptionalString, isString } from './validation'
import type { IpcContext } from './context'

/**
 * Agent-bus IPC handlers. Renderer posts arrive here with an explicit sender
 * (the active session runtime); Pi-originated posts arrive as `bus_post` tool
 * calls snooped off the event stream by the broker itself.
 */

function parseTopics(value: unknown): BusTopic[] {
  if (!Array.isArray(value)) throw new Error('topics must be an array')
  return value.map((topic) => {
    if (!isBusTopic(topic)) throw new Error(`Unknown topic: ${String(topic)}`)
    return topic
  })
}

function parsePostInput(value: unknown): BusPostInput {
  if (!isObject(value)) throw new Error('post must be an object')
  if (!isBusTopic(value.topic)) throw new Error(`Unknown topic: ${String(value.topic)}`)
  if (!isString(value.payload)) throw new Error('payload must be a string')
  const input: BusPostInput = { topic: value.topic, payload: value.payload }
  if (value.toRuntimeId !== undefined) {
    if (!isString(value.toRuntimeId)) throw new Error('toRuntimeId must be a string')
    input.toRuntimeId = value.toRuntimeId
  }
  if (value.scope !== undefined) {
    if (value.scope !== 'session' && value.scope !== 'workspace' && value.scope !== 'global') {
      throw new Error(`Unknown scope: ${String(value.scope)}`)
    }
    input.scope = value.scope
  }
  if (!isOptionalString(value.threadId)) throw new Error('threadId must be a string')
  if (value.threadId !== undefined) input.threadId = value.threadId
  if (value.urgent !== undefined) {
    if (typeof value.urgent !== 'boolean') throw new Error('urgent must be a boolean')
    input.urgent = value.urgent
  }
  return input
}

export function createBusRuntimeIndex(ctx: IpcContext) {
  const { workspaceManager } = ctx
  const listRuntimes = (): BusRuntime[] =>
    workspaceManager
      .getSessionRuntimes()
      .map((info) => ({
        runtimeId: info.runtimeId,
        workspaceId: info.workspaceId,
        manager: workspaceManager.getPiManager(info.workspaceId),
      }))
      .filter((r): r is BusRuntime => r.manager !== null)

  const isTrusted = (workspaceId: string): boolean => {
    const workspace = workspaceManager.getWorkspaces().find((w) => w.id === workspaceId)
    return workspace ? workspaceTrustStore.isTrusted(workspace.path) : false
  }

  return { listRuntimes, isTrusted }
}

export function registerBusHandlers(ctx: IpcContext, broker: BusBroker): void {
  const { workspaceManager } = ctx

  // Every Pi manager feeds the broker (snoop `bus_post` tool calls). Same
  // attach point as the event router; both attach guards are idempotent.
  workspaceManager.onPiManager((manager) => {
    broker.attachManager(manager)
  })

  /** Sender for renderer-originated posts: the active session runtime. */
  const activeSender = (): BusRuntime => {
    const active = workspaceManager.getActiveWorkspace()
    if (!active) throw new Error('No active workspace')
    const runtimes = workspaceManager.getSessionRuntimes(active.id)
    const runtime = runtimes.find((r) => r.active) ?? runtimes[0]
    if (!runtime) throw new Error('No live session runtime in the active workspace')
    const manager = workspaceManager.getPiManager(active.id)
    if (!manager) throw new Error('Pi not running for the active workspace')
    return { runtimeId: runtime.runtimeId, workspaceId: active.id, manager }
  }

  ipcMain.handle(IPC_CHANNELS.BUS_POST, async (event: IpcMainInvokeEvent, post: unknown): Promise<BusPostResult> => {
    assertTrustedSender(event)
    return broker.post(activeSender(), parsePostInput(post))
  })

  ipcMain.handle(IPC_CHANNELS.BUS_LIST, async (event: IpcMainInvokeEvent, limit: unknown) => {
    assertTrustedSender(event)
    if (limit !== undefined && typeof limit !== 'number') throw new Error('limit must be a number')
    return broker.list(limit)
  })

  ipcMain.handle(IPC_CHANNELS.BUS_SUBSCRIBE, async (event: IpcMainInvokeEvent, topics: unknown, threadId: unknown) => {
    assertTrustedSender(event)
    if (!isOptionalString(threadId)) throw new Error('threadId must be a string')
    broker.subscribe(activeSender().runtimeId, parseTopics(topics), threadId ?? undefined)
    return { ok: true as const }
  })

  ipcMain.handle(IPC_CHANNELS.BUS_UNSUBSCRIBE, async (event: IpcMainInvokeEvent, topic: unknown) => {
    assertTrustedSender(event)
    if (topic !== undefined && !isBusTopic(topic)) throw new Error(`Unknown topic: ${String(topic)}`)
    broker.unsubscribe(activeSender().runtimeId, topic as BusTopic | undefined)
    return { ok: true as const }
  })

  ipcMain.handle(IPC_CHANNELS.BUS_SUBSCRIPTIONS, async (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event)
    return broker.subscriptionsFor(activeSender().runtimeId)
  })
}

/**
 * Tail the headless file bus into the broker. Started once from
 * registerIpcHandlers; lives for the app lifetime (quit tears it down).
 * Reads are position-cursor slices of a small append-only file — plenty for
 * an 8KB-capped operator bus, no watcher handles to leak.
 */
export function startBusFileBridge(ctx: IpcContext, broker: BusBroker): BusFileBridge {
  return createBusFileBridge({
    busFilePath: defaultBusFilePath,
    readAppended: (position) => {
      const path = defaultBusFilePath()
      if (!existsSync(path)) return { text: '', position }
      // Char offsets throughout: byte offsets would desync on multi-byte
      // payloads. A shorter file means rotation — re-read from the top.
      const full = readFileSync(path, 'utf-8')
      if (full.length < position) return { text: full, position: full.length }
      return { text: full.slice(position), position: full.length }
    },
    liveSenders: () =>
      ctx.workspaceManager.getSessionRuntimes().map((info) => ({
        pid: ctx.workspaceManager.getPiManager(info.workspaceId)?.getStatus().pid ?? null,
        sessionFile: info.sessionPath,
      })),
    ingest: (envelope) => void broker.ingest(envelope),
    now: () => Date.now(),
    setPoll: (fn, ms) => setInterval(fn, ms),
    clearPoll: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  })
}

export function createAppBusBroker(ctx: IpcContext): BusBroker {
  const { listRuntimes, isTrusted } = createBusRuntimeIndex(ctx)
  return createBusBroker({
    listRuntimes,
    runtimeFor: (manager) => {
      const runtimeId = ctx.workspaceManager.runtimeIdFor(manager)
      const info = runtimeId ? ctx.workspaceManager.getSessionRuntime(runtimeId) : null
      if (!info) return null
      const live = ctx.workspaceManager.getPiManager(info.workspaceId)
      if (!live) return null
      return { runtimeId: info.runtimeId, workspaceId: info.workspaceId, manager: live }
    },
    isTrusted,
    broadcastEnvelope: (envelope) => ctx.broadcast(IPC_CHANNELS.EVENT_BUS, envelope),
    newId: () => randomUUID(),
    now: () => Date.now(),
  })
}
