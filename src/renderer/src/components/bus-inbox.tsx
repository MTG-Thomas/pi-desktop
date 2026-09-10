import { useEffect, useMemo, useState } from 'react'
import { Inbox, Send } from 'lucide-react'
import { clsx } from 'clsx'
import { useAppStore } from '../store'
import { BUS_TOPICS, type BusTopic } from '../../../shared/bus-policy'
import type { BusEnvelope } from '../../../shared/ipc-contracts'

export const BUS_BROADCAST_KEY = '(broadcast)'

export function busThreadKey(envelope: Pick<BusEnvelope, 'threadId'>): string {
  return envelope.threadId ?? BUS_BROADCAST_KEY
}

function threadLabel(key: string): string {
  return key === BUS_BROADCAST_KEY ? 'Broadcast' : key
}

function timeOf(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return ''
  }
}

export function BusInbox(): React.JSX.Element {
  const busEnvelopes = useAppStore((state) => state.busEnvelopes)
  const busThreadsSeen = useAppStore((state) => state.busThreadsSeen)
  const refreshBus = useAppStore((state) => state.refreshBus)
  const postBus = useAppStore((state) => state.postBus)
  const markThreadSeen = useAppStore((state) => state.markThreadSeen)

  const [activeThread, setActiveThread] = useState<string | null>(null)
  const [topic, setTopic] = useState<BusTopic>('op.announce')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  // Pull on every mount: boot order between the main bridge backfill and
  // the first refresh is not guaranteed, and this also heals reconnects.
  useEffect(() => {
    void refreshBus()
  }, [refreshBus])

  const threads = useMemo(() => {
    const byKey = new Map<string, BusEnvelope[]>()
    for (const envelope of busEnvelopes) {
      const key = busThreadKey(envelope)
      const list = byKey.get(key) ?? []
      list.push(envelope)
      byKey.set(key, list)
    }
    return [...byKey.entries()]
      .map(([key, messages]) => ({
        key,
        messages,
        last: messages[messages.length - 1]!,
        unread: messages.filter((m) => m.ts > (busThreadsSeen[key] ?? 0)).length,
      }))
      .sort((a, b) => b.last.ts - a.last.ts)
  }, [busEnvelopes, busThreadsSeen])

  const totalUnread = threads.reduce((sum, thread) => sum + thread.unread, 0)

  const open = threads.find((thread) => thread.key === activeThread) ?? threads[0] ?? null

  // Mark-seen must key off the stable thread key and the unread COUNT, not
  // the derived thread object: marking seen recomputes the thread list (new
  // identities), which would re-fire the effect forever and hang the view.
  const openKey = open?.key ?? null
  const openUnread = open?.unread ?? 0
  useEffect(() => {
    if (openKey !== null && openUnread > 0) markThreadSeen(openKey)
  }, [openKey, openUnread, markThreadSeen])

  const selectThread = (key: string): void => {
    setActiveThread(key)
    markThreadSeen(key)
  }

  const send = async (): Promise<void> => {
    const payload = draft.trim()
    if (!payload || sending) return
    setSending(true)
    setSendError(null)
    try {
      const threadId = open && open.key !== BUS_BROADCAST_KEY ? open.key : undefined
      const result = await postBus(topic, payload, threadId)
      if (!result.ok) setSendError(result.error)
      else setDraft('')
    } catch {
      setSendError('Could not reach the bus broker.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="mx-auto flex w-full max-w-5xl min-h-0 flex-1 flex-col px-6 py-7">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Inbox size={19} className="text-accent-fg" />
              <h1 className="text-lg font-semibold text-primary">Bus</h1>
              {totalUnread > 0 && (
                <span className="rounded-full bg-warning-bg px-2 py-0.5 text-[10px] font-medium text-warning">
                  {totalUnread} unread
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-dim">
              Every agent post from every session — Desktop-routed and headless file-bus alike.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refreshBus()}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary"
            title="Reload thread history"
          >
            Refresh
          </button>
        </div>

        {threads.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-dim">
            No bus traffic yet. Sessions post with the <span className="text-secondary">bus_post</span> tool; headless
            posts arrive here through the file bridge.
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] gap-3">
            <div className="min-h-0 overflow-y-auto rounded-lg border border-border bg-card">
              {threads.map((thread) => (
                <button
                  key={thread.key}
                  type="button"
                  onClick={() => selectThread(thread.key)}
                  className={clsx(
                    'flex w-full flex-col gap-0.5 border-b border-border px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-surface-hover',
                    open?.key === thread.key && 'bg-highlight',
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-primary">{threadLabel(thread.key)}</span>
                    {thread.unread > 0 && (
                      <span className="shrink-0 rounded-full bg-accent px-1.5 py-px text-[10px] font-medium text-white">
                        {thread.unread}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-[11px] text-dim">{thread.last.payload}</span>
                  <span className="text-[10px] text-dim">
                    {thread.last.topic} · {timeOf(thread.last.ts)}
                  </span>
                </button>
              ))}
            </div>

            <div className="flex min-h-0 flex-col rounded-lg border border-border bg-card">
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {!open ? (
                  <p className="text-sm text-dim">Pick a thread.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {open.messages.map((message) => (
                      <div key={message.id}>
                        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                          <span className="font-medium text-secondary">{message.fromRuntimeId}</span>
                          <span className="rounded bg-highlight px-1.5 py-px text-accent-fg">{message.topic}</span>
                          {message.fromWorkspaceId === 'headless' && (
                            <span className="rounded bg-highlight px-1.5 py-px text-dim">headless</span>
                          )}
                          {message.urgent && (
                            <span className="rounded bg-warning-bg px-1.5 py-px text-warning">urgent</span>
                          )}
                          <span className="text-dim">{timeOf(message.ts)}</span>
                        </div>
                        <p className="whitespace-pre-wrap text-sm text-primary">{message.payload}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-border px-4 py-3">
                <div className="mb-2 flex items-center gap-2">
                  <select
                    value={topic}
                    onChange={(event) => setTopic(event.target.value as BusTopic)}
                    className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-primary"
                    title="Topic"
                  >
                    {BUS_TOPICS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <span className="text-[11px] text-dim">posting to {open ? threadLabel(open.key) : '…'}</span>
                </div>
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send()
                    }}
                    rows={2}
                    placeholder="Post to this thread… (Ctrl+Enter to send)"
                    className="min-h-[52px] flex-1 resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-sm text-primary placeholder:text-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus"
                  />
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={sending || draft.trim() === ''}
                    className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                    title="Send bus post"
                  >
                    <Send size={12} />
                    Send
                  </button>
                </div>
                {sendError && <p className="mt-1.5 text-xs text-warning">{sendError}</p>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
