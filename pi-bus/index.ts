/**
 * pi-bus — inter-session message bus tools.
 *
 * `bus_post` is the transport: Pi Desktop's main-process broker snoops this
 * tool's calls off the Pi event stream (`tool_execution_start`), validates
 * them against the shared bus policy, and injects the envelope into target
 * sessions via `follow_up` (or `steer` when urgent).
 *
 * Headless (`pi` CLI without the broker): the same call ALSO appends the
 * envelope to a file-backed log at `~/.local/share/pi-bus/bus.jsonl`, and
 * `bus_read` polls it back. Same topics/threads, no broker needed. Desktop
 * routing is unaffected: tool name + params are unchanged, the file write
 * is additive only.
 *
 * Conventions (keep boring, keep typed):
 * - payloads are Markdown, <8KB. Full diffs travel as file path + link.
 * - `threadId` correlates a task round-trip: dispatch → result(s).
 * - prefer topic broadcast over `toRuntimeId` direct; direct is for answers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const Topic = Type.Union(
  [
    "task.dispatch",
    "task.result",
    "plan.propose",
    "plan.critique",
    "plan.consensus",
    "code.review-request",
    "code.review-verdict",
    "op.announce",
    "op.question",
    "op.answer",
  ].map((t) => Type.Literal(t)),
);

type TopicName =
  | "task.dispatch"
  | "task.result"
  | "plan.propose"
  | "plan.critique"
  | "plan.consensus"
  | "code.review-request"
  | "code.review-verdict"
  | "op.announce"
  | "op.question"
  | "op.answer";

interface BusEnvelope {
  id: string;
  ts: string;
  topic: TopicName;
  threadId: string | null;
  payload: string;
  toRuntimeId: string | null;
  urgent: boolean;
  from: { host: string; pid: number; sessionFile: string | null };
}

const PAYLOAD_MAX = 8 * 1024;
const THREAD_REQUIRED = new Set<TopicName>([
  "task.dispatch",
  "task.result",
  "code.review-request",
  "code.review-verdict",
]);

function busDir(): string {
  return join(homedir(), ".local", "share", "pi-bus");
}

function busFile(): string {
  return join(busDir(), "bus.jsonl");
}

function appendEnvelope(env: BusEnvelope): void {
  mkdirSync(busDir(), { recursive: true });
  appendFileSync(busFile(), JSON.stringify(env) + "\n", "utf-8");
}

function readEnvelopes(): BusEnvelope[] {
  const file = busFile();
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf-8");
  const out: BusEnvelope[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t) as BusEnvelope;
      if (typeof v.id === "string" && typeof v.topic === "string" && typeof v.payload === "string") {
        out.push(v);
      }
    } catch {
      // Malformed line: skip, never break the reader.
    }
  }
  return out;
}

function deliveredDir(): string {
  return join(busDir(), "delivered");
}

function safeName(value: string): string {
  const base = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return base.length > 0 ? base : "session";
}

function sessionKey(ctx: unknown): string | null {
  try {
    const sm = (ctx as { sessionManager?: { getSessionFile?: () => string | null; getSessionId?: () => string | null } })?.sessionManager;
    return sm?.getSessionFile?.() ?? sm?.getSessionId?.() ?? null;
  } catch {
    return null;
  }
}

function deliveredIds(key: string): Set<string> {
  try {
    const raw = readFileSync(join(deliveredDir(), `${safeName(key)}.json`), "utf-8");
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) return new Set(arr.filter((v): v is string => typeof v === "string"));
  } catch {
    // No sidecar yet: nothing delivered.
  }
  return new Set();
}

function markDelivered(key: string, ids: readonly string[]): void {
  try {
    mkdirSync(deliveredDir(), { recursive: true });
    const seen = deliveredIds(key);
    for (const id of ids) seen.add(id);
    writeFileSync(join(deliveredDir(), `${safeName(key)}.json`), JSON.stringify([...seen]));
  } catch {
    // Delivery bookkeeping must never break the agent turn.
  }
}

/** Urgent posts for this session not yet injected. Broadcast urgent plus
 *  directs addressed at this session file/id. Same-process steer only:
 *  cross-process delivery stays poll-based via bus_read. */
function pendingUrgent(key: string): BusEnvelope[] {
  const delivered = deliveredIds(key);
  return readEnvelopes().filter(
    (e) => e.urgent && !delivered.has(e.id) && (e.toRuntimeId === null || e.toRuntimeId === key),
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "bus_post",
    label: "Bus post",
    description: [
      "Send a message to other agent sessions via the desktop broker.",
      "Use task.dispatch to fan out work (set threadId), task.result to report back on a thread.",
      "Use plan.* for council-style converge, code.review-request for review, op.* for operator chatter.",
      "Payload is Markdown under 8KB; link files instead of pasting diffs.",
      "Headless: the post is also appended to ~/.local/share/pi-bus/bus.jsonl; read it back with bus_read.",
    ].join(" "),
    parameters: Type.Object({
      topic: Topic,
      payload: Type.String({ description: "Markdown message body, under 8KB" }),
      threadId: Type.Optional(Type.String({ description: "Correlation id for a task round-trip" })),
      toRuntimeId: Type.Optional(
        Type.String({ description: "Direct delivery; omit for topic broadcast" }),
      ),
      urgent: Type.Optional(
        Type.Boolean({ description: "Steer (interrupt) instead of queueing behind the turn" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const topic = params.topic as TopicName;
      if (params.payload.length > PAYLOAD_MAX) {
        throw new Error(`bus_post: payload exceeds ${PAYLOAD_MAX} chars (${params.payload.length}).`);
      }
      const threadId = params.threadId?.trim() ? params.threadId.trim() : null;
      if (THREAD_REQUIRED.has(topic) && !threadId) {
        throw new Error(`bus_post: threadId is required for ${topic}.`);
      }
      const toRuntimeId = params.toRuntimeId?.trim() ? params.toRuntimeId.trim() : null;
      const urgent = params.urgent ?? false;

      let sessionFile: string | null = null;
      try {
        sessionFile = (ctx as unknown as { sessionManager?: { getSessionFile?: () => string | null } })
          ?.sessionManager?.getSessionFile?.() ?? null;
      } catch {
        sessionFile = null;
      }
      let host = "unknown";
      try {
        host = hostname();
      } catch {
        host = "unknown";
      }

      const env: BusEnvelope = {
        id: randomUUID(),
        ts: new Date().toISOString(),
        topic,
        threadId,
        payload: params.payload,
        toRuntimeId,
        urgent,
        from: { host, pid: process.pid, sessionFile },
      };
      try {
        appendEnvelope(env);
      } catch (err) {
        throw new Error(`bus_post: file append failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const scope = toRuntimeId ? `→ ${toRuntimeId}` : "broadcast";
      const thread = threadId ? ` [${threadId}]` : "";
      return {
        content: [{ type: "text", text: `Posted ${topic}${thread} (${scope}) id=${env.id}.` }],
        details: { topic, threadId, id: env.id },
      };
    },
  });

  pi.registerTool({
    name: "bus_read",
    label: "Bus read",
    description: [
      "Read recent bus posts from the headless file log (~/.local/share/pi-bus/bus.jsonl).",
      "Filter by threadId and/or topic. Headless polling: call at turn start and before finishing.",
    ].join(" "),
    parameters: Type.Object({
      threadId: Type.Optional(Type.String({ description: "Only posts on this thread" })),
      topic: Type.Optional(Type.String({ description: "Only posts with this topic" })),
      limit: Type.Optional(Type.Number({ description: "Max posts to return (default 20, max 50)" })),
    }),
    async execute(_toolCallId, params) {
      const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
      const thread = params.threadId?.trim() || null;
      const topic = params.topic?.trim() || null;
      let all: BusEnvelope[];
      try {
        all = readEnvelopes();
      } catch (err) {
        throw new Error(`bus_read: read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const filtered = all.filter(
        (e) => (!thread || e.threadId === thread) && (!topic || e.topic === topic),
      );
      const slice = filtered.slice(-limit);
      if (slice.length === 0) return { content: [{ type: "text", text: "Bus: empty." }], details: {} };
      const text = slice
        .map((e) => {
          const head = `[bus:${e.topic} thread:${e.threadId ?? "-"} from:${e.from.sessionFile ?? `${e.from.host}:${e.from.pid}`} id:${e.id}]${e.toRuntimeId ? ` to:${e.toRuntimeId}` : ""}${e.urgent ? " URGENT" : ""}`;
          return `${head}\n${e.payload}`;
        })
        .join("\n---\n");
      return { content: [{ type: "text", text }], details: { count: slice.length } };
    },
  });

  pi.registerCommand("bus-threads", {
    description: "Remind me of the bus topic/thread conventions",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "bus: dispatch→result share a threadId; broadcasts beat directs; diffs via file links. Headless: bus_read polls ~/.local/share/pi-bus/bus.jsonl.",
        "info",
      );
    },
  });

  // Same-process urgent steer: inject once into this session's next tool
  // call by blocking it with the urgent posts inline (mailbox-style).
  // bus_* tools are exempt so the agent can always read its way out.
  // Cross-process urgent stays poll-based: bus_read surfaces URGENT flags.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName.startsWith("bus_")) return;
    try {
      const key = sessionKey(ctx);
      if (!key) return;
      const pending = pendingUrgent(key);
      if (pending.length === 0) return;
      markDelivered(key, pending.map((m) => m.id));
      const lines = pending.map((m) => {
        const head = `[bus:${m.topic} thread:${m.threadId ?? "-"} from:${m.from.sessionFile ?? `${m.from.host}:${m.from.pid}`} id:${m.id}]`;
        return `${head}\n${m.payload}`;
      });
      return {
        block: true,
        reason: `BUS_URGENT: ${pending.length} urgent bus post(s). Read with bus_read, then continue.\n${lines.join("\n---\n")}`,
      };
    } catch {
      // A broken bus store must never break unrelated tools.
      return;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const key = sessionKey(ctx);
      const all = readEnvelopes();
      const unread = key ? all.filter((e) => !deliveredIds(key).has(e.id)).length : all.length;
      const urgent = all.filter((e) => e.urgent).length;
      if (all.length > 0) {
        ctx.ui.notify(`bus: ${unread} unpolled post(s), ${urgent} urgent. Call bus_read at turn start and before finishing.`, "info");
      }
    } catch {
      // Best effort only.
    }
  });
}
