// Helpers: OpenCode data directory, session -> directory lookup, session map persistence.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** OpenCode's data directory (XDG_DATA_HOME/opencode, default ~/.local/share/opencode). */
export function opencodeDataDir(env = process.env) {
  const base = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "opencode")
}

let openDb
async function sqliteOpen(file) {
  if (!openDb) {
    try {
      const { Database } = await import("bun:sqlite") // OpenCode runs on Bun
      openDb = (f) => {
        const db = new Database(f, { readonly: true })
        return { get: (sql, arg) => db.query(sql).get(arg), close: () => db.close() }
      }
    } catch {
      const { DatabaseSync } = await import("node:sqlite") // tests under Node
      openDb = (f) => {
        const db = new DatabaseSync(f, { readOnly: true })
        return { get: (sql, arg) => db.prepare(sql).get(arg), close: () => db.close() }
      }
    }
  }
  return openDb(file)
}

/**
 * Directory of an OpenCode session, read-only from opencode.db (session_v2, then the
 * legacy session table). Undefined when the session or the database is not found.
 */
export async function sessionDirectory(sessionId, dataDir = opencodeDataDir()) {
  const file = path.join(dataDir, "opencode.db")
  if (!sessionId || !existsSync(file)) return undefined
  let db
  try {
    db = await sqliteOpen(file)
    for (const table of ["session_v2", "session"]) {
      try {
        const row = db.get(`select directory from ${table} where id = ?`, sessionId)
        if (row?.directory && existsSync(row.directory)) return row.directory
      } catch {
        // table missing in this OpenCode version
      }
    }
    return undefined
  } finally {
    db?.close()
  }
}

/** OpenCode session id -> Claude Code session id, kept across restarts. */
export function sessionMapFile(dataDir = opencodeDataDir()) {
  return path.join(dataDir, "claude-code-sessions.json")
}

export function loadSessionMap(file = sessionMapFile()) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

export function saveSessionMap(map, file = sessionMapFile()) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(map, null, 1))
    renameSync(tmp, file)
  } catch {
    // losing the map only costs a fresh Claude Code session on the next turn
  }
}

/**
 * Letters between OpenCode windows (opencode-peers) for Claude Code: its stdio MCP server, run for ONE
 * OpenCode session. `option`: path to opencode-peers' mcp.ts, `false` to switch off, unset -> the sibling
 * checkout `../opencode-peers/mcp.ts` next to this provider when it exists. Undefined -> no server.
 */
export function resolvePeersMcp(option, here = path.dirname(fileURLToPath(import.meta.url))) {
  if (option === false) return undefined
  const file = typeof option === "string" && option ? path.resolve(option) : path.resolve(here, "..", "opencode-peers", "mcp.ts")
  return existsSync(file) ? file : undefined
}

/** MCP server config (Claude Agent SDK `mcpServers` entry) acting for OpenCode session `session`. */
export function peersMcpServer(file, session, { node = "node", env = process.env } = {}) {
  return {
    type: "stdio",
    command: node,
    args: [file],
    env: {
      OPENCODE_PEERS_SESSION: session,
      // the same mailbox as the OpenCode server's plugin
      ...(env.XDG_DATA_HOME ? { XDG_DATA_HOME: env.XDG_DATA_HOME } : {}),
    },
  }
}

/**
 * HELPER REQUESTS. OpenCode's own helper agents (title, summary, ...) call the window's model with the
 * window's session header but WITHOUT tools and with their own system prompt ("You are a title
 * generator..."); an agent turn always carries OpenCode's tool list. Measured 2026-10-04: run as a
 * Claude Code turn (Claude Code's prompt, tools, MCP, the window's session) the title request executed
 * the window's user message a second time -- peer_send went out twice -- and raced the window's turn
 * for the session map.
 */
export function isHelperRequest(callOptions) {
  return !(Array.isArray(callOptions?.tools) && callOptions.tools.length > 0)
}

/**
 * Claude Code as a plain model call for a helper request: OpenCode's system prompt, no tools, no MCP,
 * no settings/CLAUDE.md/hooks, one turn, nothing persisted (no transcript, no resume, no session map).
 */
export function helperSettings(prompt) {
  const system = prompt
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("")))
    .join("\n\n")
  return {
    systemPrompt: system,
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    persistSession: false,
    maxTurns: 1,
  }
}

/**
 * COMPACTION. OpenCode's compaction (auto or /compact) comes as an ordinary turn of the window (its tools,
 * its session) whose last user message asks for a summary in OpenCode's template. Measured 2026-10-04: on
 * claude-code it became a full Claude Code turn (Haiku: $0.03, 137k cached tokens read), the summary was
 * APPENDED to Claude Code's own session, and the next turn resumed that full session anyway -- OpenCode's
 * compaction cannot shrink what Claude Code sees, it only spends a turn. So the provider runs Claude Code's
 * own /compact instead (index.js). Markers: OpenCode's two fixed openings and the template's first heading.
 */
export const COMPACTION_OPENINGS = [
  "You MUST summarize the conversation above into a structured summary",
  "Update the existing checkpoint in the conversation above into one consolidated summary",
]

export function isCompactionRequest(prompt) {
  const last = [...(prompt ?? [])].reverse().find((m) => m.role === "user")
  if (!last) return false
  const text = typeof last.content === "string" ? last.content : (last.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("")
  return text.includes("## Objective") && COMPACTION_OPENINGS.some((o) => text.includes(o))
}

/** The summary OpenCode stores instead of a Claude Code turn (OpenCode checks the template headings). */

/** autoCompactWindow for a model: a number for every model, or { opus: n, sonnet: n, "*": n } (exact, family, "*"). */
export function autoCompactWindowFor(option, modelId) {
  if (typeof option === "number") return option
  if (!option || typeof option !== "object") return undefined
  const id = String(modelId).toLowerCase()
  if (typeof option[id] === "number") return option[id]
  const family = Object.keys(option).find((k) => k !== "*" && id.includes(k.toLowerCase()))
  if (family && typeof option[family] === "number") return option[family]
  return typeof option["*"] === "number" ? option["*"] : undefined
}

/**
 * The newest user message as Claude Code's raw input. The package prefixes every user message with
 * "Human: " (not configurable); a system-role message goes in verbatim. So a text-only user message is
 * passed as such: Claude Code then gets exactly what the user typed (and its own slash commands work).
 * A message with images or files stays a user message (the package attaches files to user messages only).
 */
export function rawUserTurn(messages) {
  if (messages.length !== 1 || messages[0].role !== "user") return messages
  const c = messages[0].content
  if (typeof c === "string") return [{ role: "system", content: c }]
  if (!Array.isArray(c) || !c.every((p) => p.type === "text")) return messages
  return [{ role: "system", content: c.map((p) => p.text).join("\n") }]
}

/** A finished text answer without calling the model: for doGenerate (v3 result). */
export function textResult(text) {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "end_turn" },
    usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: undefined, reasoning: undefined }, raw: undefined },
    warnings: [],
  }
}

/** The same answer as a v3 stream, for doStream. */
export function textStream(text) {
  const r = textResult(text)
  const parts = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: text },
    { type: "text-end", id: "0" },
    { type: "finish", finishReason: r.finishReason, usage: r.usage },
  ]
  return {
    stream: new ReadableStream({
      start(ctl) {
        for (const p of parts) ctl.enqueue(p)
        ctl.close()
      },
    }),
  }
}

/** Built-in Claude Code tools switched off: `tools: { "Artifact": false, ... }` of the provider options. */
export function disabledTools(tools, alreadyDisallowed = []) {
  const off = Object.entries(tools ?? {}).filter(([, on]) => on === false).map(([name]) => name)
  return [...new Set([...alreadyDisallowed, ...off])]
}
