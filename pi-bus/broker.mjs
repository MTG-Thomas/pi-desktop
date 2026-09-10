/**
 * pi-broker — single-machine appserver shim for `pi --mode rpc`.
 *
 * Codex appserver equivalent (list/turn/steer/spawn) for one machine:
 * this process owns N `pi --mode rpc` children over stdio JSONL and
 * exposes them on loopback HTTP with basic auth. Same trust model as
 * LaneOps: loopback-only, password in ~/.local/share/pi-bus/broker.json,
 * never committed, never pasted on the bus.
 *
 * Endpoints (all require Basic auth, JSON bodies, JSON responses):
 *   GET  /health                        {healthy, version}
 *   POST /session          {title?, provider?, model?, sessionDir?, sessionId?, noSession?}
 *     -> {id, pid}                       spawn a child (broker owns the loop)
 *   GET  /session                       [{id, title, alive, pid, sessionFile, sessionId}]
 *   POST /session/:id/attach {sessionFile?}  respawn a dead entry on the same file
 *   GET  /session/:id/state             get_state data
 *   POST /session/:id/prompt {message, timeoutMs?}
 *     -> {settled, response, text}       blocking turn (waits agent_settled)
 *   POST /session/:id/steer {message}   steer while streaming (errors if idle)
 *   POST /session/:id/follow_up {message}
 *   POST /session/:id/abort             abort + wait idle
 *   GET  /session/:id/messages          get_messages data
 *   POST /session/:id/entries {since?}  get_entries data
 *   DELETE /session/:id                 kill child, keep session file
 *
 * Ownership rule: broker-driven sessions are owned by the broker caller.
 * NEVER point prompt/steer at a harness-owned LIVE thread (interactive TUI,
 * Pi Desktop pane, :4096). Mailbox/bus notes only for those; dual drivers
 * corrupt the turn queue.
 *
 * Usage:
 *   node broker.mjs --port 4098            (password from PIBUS_PASSWORD or generated)
 *   PI_BIN=/path/to/pi node broker.mjs --port 4098
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const VERSION = "0.1.0";
const BUS_ROOT = join(homedir(), ".local", "share", "pi-bus");
const CONFIG_PATH = join(BUS_ROOT, "broker.json");
const SESSIONS_PATH = join(BUS_ROOT, "broker-sessions.json");

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const PORT = parseInt(arg("--port", process.env.PIBUS_PORT || "4098"), 10);
const PI_BIN = process.env.PI_BIN || (process.platform === "win32" ? "pi" : "pi");

function busAuth() {
  if (process.env.PIBUS_PASSWORD) return process.env.PIBUS_PASSWORD;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (cfg.port === PORT && typeof cfg.password === "string") return cfg.password;
  } catch { /* fall through: generate */ }
  return randomBytes(24).toString("hex");
}
const PASSWORD = busAuth();
const EXPECTED = `opencode:${PASSWORD}`;

function checkAuth(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  let got;
  try {
    got = Buffer.from(h.slice(6), "base64").toString("utf-8");
  } catch { return false; }
  const a = Buffer.from(got);
  const b = Buffer.from(EXPECTED);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Sessions: id -> record. */
const sessions = new Map();

function persistSessions() {
  const arr = [...sessions.values()].map((s) => ({
    id: s.id, title: s.title, sessionFile: s.sessionFile, sessionId: s.sessionId,
    provider: s.provider, model: s.model, sessionDir: s.sessionDir,
    extensions: s.extensions, created: s.created,
  }));
  try {
    mkdirSync(BUS_ROOT, { recursive: true });
    writeFileSync(SESSIONS_PATH, JSON.stringify(arr, null, 2));
  } catch { /* best effort */ }
}

function loadPersisted() {
  try {
    const arr = JSON.parse(readFileSync(SESSIONS_PATH, "utf-8"));
    if (Array.isArray(arr)) {
      for (const s of arr) {
        sessions.set(s.id, {
          ...s, child: null, pid: null, alive: false, buf: "",
          pending: new Map(), events: [], settledWaiters: [],
        });
      }
    }
  } catch { /* none yet */ }
}

function sendCmd(rec, obj) {
  return new Promise((resolve, reject) => {
    if (!rec.child || rec.child.exitCode !== null) {
      reject(new Error(`session ${rec.id} has no live child`));
      return;
    }
    const id = obj.id || `req-${randomUUID()}`;
    obj = { ...obj, id };
    const timer = setTimeout(() => {
      rec.pending.delete(id);
      reject(new Error(`rpc timeout waiting for response to ${obj.type}`));
    }, 60_000);
    rec.pending.set(id, { resolve: (d) => { clearTimeout(timer); resolve(d); }, reject });
    try {
      rec.child.stdin.write(JSON.stringify(obj) + "\n");
    } catch (e) {
      rec.pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

function waitSettled(rec, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      rec.settledWaiters = rec.settledWaiters.filter((w) => w !== waiter);
      waiter(false);
    }, timeoutMs);
    const waiter = (settled) => { clearTimeout(timer); resolve(settled); };
    rec.settledWaiters.push(waiter);
  });
}

function onLine(rec, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  rec.events.push(msg);
  if (rec.events.length > 400) rec.events.splice(0, rec.events.length - 400);
  if (msg.type === "response" && msg.id && rec.pending.has(msg.id)) {
    const p = rec.pending.get(msg.id);
    rec.pending.delete(msg.id);
    p.resolve(msg);
    return;
  }
  if (msg.type === "agent_settled") {
    const ws = rec.settledWaiters.splice(0);
    for (const w of ws) w(true);
  }
  if (msg.type === "get_state" || (msg.type === "response" && msg.command === "get_state" && msg.data)) {
    if (msg.data && (msg.data.sessionFile || msg.data.sessionId)) {
      if (msg.data.sessionFile) rec.sessionFile = msg.data.sessionFile;
      if (msg.data.sessionId) rec.sessionId = msg.data.sessionId;
      persistSessions();
    }
  }
}

function spawnChild(rec, extra = {}) {
  const cargs = ["--mode", "rpc"];
  if (extra.sessionDir || rec.sessionDir) cargs.push("--session-dir", extra.sessionDir || rec.sessionDir);
  if (extra.fork) cargs.push("--fork", extra.fork);
  else if (extra.sessionFile) cargs.push("--session", extra.sessionFile);
  else if (rec.sessionFile && !rec.sessionId) cargs.push("--session", rec.sessionFile);
  if (extra.sessionId || rec.sessionId) cargs.push("--session-id", extra.sessionId || rec.sessionId);
  if (extra.provider || rec.provider) cargs.push("--provider", extra.provider || rec.provider);
  if (extra.model || rec.model) cargs.push("--model", extra.model || rec.model);
  if (extra.title || rec.title) cargs.push("--name", extra.title || rec.title);
  if (extra.noSession || rec.noSession) cargs.push("--no-session");
  const exts = extra.extensions || rec.extensions || [];
  for (const e of exts) cargs.push("-e", e);
  // shell:true on win32 so PATH shims (WinGet Links pi.cmd) resolve.
  const child = spawn(PI_BIN, cargs, { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
  child.on("error", (err) => {
    // Spawn failure (ENOENT etc.): mark dead, never crash the broker.
    rec.spawnError = err.message;
    rec.alive = false;
    rec.child = null;
    rec.pid = null;
    for (const [, p] of rec.pending) p.reject(new Error(`session ${rec.id} child failed: ${err.message}`));
    rec.pending.clear();
    const ws = rec.settledWaiters.splice(0);
    for (const w of ws) w(false);
  });
  rec.child = child;
  rec.pid = child.pid;
  rec.alive = true;
  rec.buf = "";
  child.stdout.on("data", (chunk) => {
    rec.buf += chunk.toString("utf-8");
    let idx;
    while ((idx = rec.buf.indexOf("\n")) >= 0) {
      const line = rec.buf.slice(0, idx).replace(/\r$/, "");
      rec.buf = rec.buf.slice(idx + 1);
      if (line.trim()) onLine(rec, line);
    }
  });
  child.stderr.on("data", () => { /* child logs stay out of the protocol */ });
  child.on("exit", () => {
    rec.alive = false;
    rec.child = null;
    rec.pid = null;
    for (const [, p] of rec.pending) p.reject(new Error(`session ${rec.id} child exited`));
    rec.pending.clear();
    const ws = rec.settledWaiters.splice(0);
    for (const w of ws) w(false);
  });
  return child;
}

async function spawnSession(opts) {
  const id = `pis_${randomBytes(6).toString("hex")}`;
  const rec = {
    id, title: opts.title || id, provider: opts.provider || null, model: opts.model || null,
    sessionDir: opts.sessionDir || null, sessionId: opts.sessionId || null,
    sessionFile: null, noSession: !!opts.noSession,
    extensions: Array.isArray(opts.extensions) ? opts.extensions : null,
    created: new Date().toISOString(),
    child: null, pid: null, alive: false, buf: "",
    pending: new Map(), events: [], settledWaiters: [],
  };
  sessions.set(id, rec);
  spawnChild(rec, opts);
  // Readiness: poll get_state until it answers or 30s passes.
  const deadline = Date.now() + 30_000;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (!rec.alive) throw new Error(`child for ${id} exited during startup${rec.spawnError ? `: ${rec.spawnError}` : ""}`);
    try {
      const r = await sendCmd(rec, { type: "get_state" });
      if (r.success) {
        if (r.data && r.data.sessionFile) rec.sessionFile = r.data.sessionFile;
        if (r.data && r.data.sessionId) rec.sessionId = r.data.sessionId;
        persistSessions();
        return rec;
      }
      lastErr = r.error || "get_state failed";
    } catch (e) { lastErr = e.message; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`session ${id} never became ready: ${lastErr}`);
}

function lastAssistantText(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "message_end" && e.message && e.message.role === "assistant") {
      const parts = (e.message.content || [])
        .filter((p) => p.type === "text")
        .map((p) => p.text);
      if (parts.length) return parts.join("\n");
    }
  }
  return "";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1024 * 1024) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); } catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (!checkAuth(req)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="pi-broker"' });
      res.end("auth required");
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { healthy: true, version: VERSION });
      return;
    }
    if (req.method === "POST" && parts.length === 1 && parts[0] === "session") {
      const body = await readBody(req);
      const rec = await spawnSession(body);
      json(res, 200, { id: rec.id, pid: rec.pid });
      return;
    }
    if (req.method === "GET" && parts.length === 1 && parts[0] === "session") {
      json(res, 200, [...sessions.values()].map((s) => ({
        id: s.id, title: s.title, alive: s.alive, pid: s.pid,
        sessionFile: s.sessionFile, sessionId: s.sessionId, created: s.created,
      })));
      return;
    }
    if (parts.length >= 2 && parts[0] === "session") {
      const rec = sessions.get(parts[1]);
      if (!rec) { json(res, 404, { error: "unknown session" }); return; }
      const sub = parts[2] || "";

      if (req.method === "POST" && sub === "attach") {
        const body = await readBody(req);
        if (!rec.alive) spawnChild(rec, { sessionFile: body.sessionFile || rec.sessionFile });
        json(res, 200, { id: rec.id, pid: rec.pid, alive: rec.alive });
        return;
      }
      if (!rec.alive) { json(res, 409, { error: `session ${rec.id} has no live child; POST /session/${rec.id}/attach first` }); return; }

      if (req.method === "GET" && sub === "state") {
        const r = await sendCmd(rec, { type: "get_state" });
        json(res, 200, r.success ? r.data : { error: r.error });
        return;
      }
      if (req.method === "POST" && (sub === "prompt" || sub === "steer" || sub === "follow_up")) {
        const body = await readBody(req);
        if (!body.message) { json(res, 400, { error: "message is required" }); return; }
        const mark = rec.events.length;
        const cmd = sub === "prompt"
          ? { type: "prompt", message: body.message }
          : sub === "steer"
            ? { type: "steer", message: body.message }
            : { type: "follow_up", message: body.message };
        if (body.images) cmd.images = body.images;
        let accepted;
        try {
          accepted = await sendCmd(rec, cmd);
        } catch (e) { json(res, 502, { error: e.message }); return; }
        if (!accepted.success) { json(res, 409, { error: accepted.error || "command rejected" }); return; }
        if (sub !== "prompt") { json(res, 200, { accepted: true }); return; }
        const settled = await waitSettled(rec, body.timeoutMs || 300_000);
        const fresh = rec.events.slice(mark);
        json(res, 200, { settled, response: accepted, text: lastAssistantText(fresh) });
        return;
      }
      if (req.method === "POST" && sub === "abort") {
        let r;
        try { r = await sendCmd(rec, { type: "abort" }); }
        catch (e) { json(res, 502, { error: e.message }); return; }
        json(res, 200, { accepted: !!r.success });
        return;
      }
      if (req.method === "GET" && sub === "messages") {
        const r = await sendCmd(rec, { type: "get_messages" });
        json(res, 200, r.success ? r.data : { error: r.error });
        return;
      }
      if (req.method === "POST" && sub === "entries") {
        const body = await readBody(req);
        const cmd = { type: "get_entries" };
        if (body.since) cmd.since = body.since;
        const r = await sendCmd(rec, cmd);
        json(res, 200, r.success ? r.data : { error: r.error });
        return;
      }
      if (req.method === "DELETE" && sub === "") {
        try { rec.child.kill(); } catch { /* already dead */ }
        sessions.delete(rec.id);
        persistSessions();
        json(res, 200, { deleted: rec.id });
        return;
      }
    }
    json(res, 404, { error: "unknown route" });
  } catch (e) {
    json(res, 500, { error: e.message || String(e) });
  }
});

loadPersisted();
server.listen(PORT, "127.0.0.1", () => {
  mkdirSync(BUS_ROOT, { recursive: true });
  const cfg = {
    host: "127.0.0.1", port: PORT, user: "opencode",
    password: PASSWORD, pid: process.pid,
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.error(`pi-broker healthy on 127.0.0.1:${PORT} (pid ${process.pid}, v${VERSION})`);
});
