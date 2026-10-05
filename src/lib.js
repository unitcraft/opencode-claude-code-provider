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

// Which Claude account a window's session belongs to (plan 001, Ph.2): a project can name its own claudeConfigDir.
// A Claude Code session lives in one account's directory, so the map remembers the account next to the session id
// ("<OpenCode session>@account"); a session of another account is not resumed — a new one starts instead of an error.
export const accountKey = (ocSession) => `${ocSession}@account`
export function resumeFor(sessions, ocSession, account) {
  const id = ocSession ? sessions[ocSession] : undefined
  if (!id) return undefined
  const was = sessions[accountKey(ocSession)]
  return (was ?? "") === (account ?? "") || was === undefined ? id : undefined // older entries have no account: resume
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
export function resolvePeersMcp(option, here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))) { // here: the package root (src/..)
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
 * What is new since the model's last answer, for a resumed session (Claude Code already has the rest): every
 * user message after the last assistant/tool message, merged into one. Usually that is one message, the one the
 * user typed; but OpenCode also queues messages for the next turn (session.synthetic with resume: false -- e.g.
 * letters from neighbouring tabs, plan-mode reminders), and they come right before it. Taking only the last one
 * lost them (measured 2026-10-05).
 */
export function newUserTurn(prompt) {
  let i = prompt.length
  while (i > 0 && prompt[i - 1].role === "user") i--
  // After a compaction OpenCode sends its summary as a user message "<conversation-checkpoint> ... <summary>" right
  // before the user's message (recorded 2026-10-05). Claude Code keeps its own memory, so the checkpoint is dropped:
  // merged in, it made the user's own message look like part of an automatic summary, and the model rightly did not
  // take the owner's approval in it as the owner's word.
  const tail = prompt.slice(i).filter((m) => !isCheckpoint(m))
  if (!tail.length) return prompt.filter((m) => m.role !== "system" && !isCheckpoint(m))
  if (tail.length === 1) return tail
  const parts = tail.flatMap((m) => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? []))
  return [{ ...tail[tail.length - 1], content: parts }]
}

const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p) => p?.text ?? "").join(""))
/** OpenCode's compaction summary as it comes in the next request. */
export const isCheckpoint = (m) => m?.role === "user" && textOf(m).trimStart().startsWith("<conversation-checkpoint>")

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

/**
 * The context size of a turn. Claude Code makes several model calls in one turn (one per tool step), and the
 * package reports the usage SUMMED over them; OpenCode takes the input of the step as the context size, so a turn
 * with 4 tools showed 125K for a ~35K context (measured 2026-10-05). The true context is the input of the LAST call:
 * the tracker remembers each top-level assistant message's usage (subagent messages carry parent_tool_use_id) and
 * replaces the input part of the final usage with it; output stays summed.
 */
export function lastCallUsage() {
  let last
  return {
    onSdkMessage(m) {
      const u = m?.type === "assistant" && !m.parent_tool_use_id ? m.message?.usage : undefined
      if (u && (u.input_tokens != null || u.cache_read_input_tokens != null)) last = u
    },
    apply(usage) {
      if (!last || !usage) return usage
      const noCache = last.input_tokens ?? 0
      const cacheRead = last.cache_read_input_tokens ?? 0
      const cacheWrite = last.cache_creation_input_tokens ?? 0
      return { ...usage, inputTokens: { ...(usage.inputTokens ?? {}), total: noCache + cacheRead + cacheWrite, noCache, cacheRead, cacheWrite } }
    },
  }
}

/**
 * Tool calls of Claude Code are shown in the OpenCode window with their whole input (a file written by one Bash
 * command filled the screen). They are executed by Claude Code, OpenCode only shows them, so long string values are
 * cut for display: the first `max` characters and "…(+N)". max 0 = whole input.
 */
export function shortenToolInput(input, max) {
  if (!max || max < 1) return input
  const cut = (v) => {
    if (typeof v === "string") return v.length > max ? `${v.slice(0, max)}…(+${v.length - max})` : v
    if (Array.isArray(v)) return v.map(cut)
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)]))
    return v
  }
  if (typeof input !== "string") return cut(input)
  try {
    return JSON.stringify(cut(JSON.parse(input)))
  } catch {
    return cut(input)
  }
}

/**
 * The main model of a turn from Claude Code's modelUsage ({"claude-opus-...": {contextWindow, inputTokens, ...}}).
 * Claude Code also calls a small model for its own chores (Haiku), so "the first entry with a window" was wrong:
 * an Opus window got the compaction note "claude-haiku-4-5 window 200k" (seen 2026-10-05). The main one is the
 * entry whose name has the window's model alias (opus / sonnet / haiku), else the one with the most tokens.
 */
export function mainModelUsage(modelUsage, modelId) {
  const entries = Object.entries(modelUsage ?? {}).filter(([, u]) => u && u.contextWindow)
  if (!entries.length) return undefined
  const alias = String(modelId ?? "").toLowerCase().match(/opus|sonnet|haiku/)?.[0]
  const byName = alias ? entries.filter(([name]) => name.toLowerCase().includes(alias)) : []
  const tokens = ([, u]) => (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) + (u.outputTokens ?? 0)
  const pool = byName.length ? byName : entries
  const [name, u] = pool.reduce((a, b) => (tokens(b) > tokens(a) ? b : a))
  return { name, contextWindow: u.contextWindow }
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

/** The skills to load: every discovered skill except those set to false; undefined = no filter (load all). */
export function enabledSkills(discovered, skills) {
  const off = new Set(Object.entries(skills ?? {}).filter(([, on]) => on === false).map(([name]) => name))
  if (!off.size || !discovered?.length) return undefined
  return discovered.filter((name) => !off.has(name))
}

/** Local time HH:MM. */
export const hhmm = (d = new Date()) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`

/** What the model is told when the provider stamps the time (constant: the system prompt stays cache-stable). */
export const TIME_HINT =
  "The local time (HH:MM) at the start of each of your text messages is stamped by the OpenCode provider itself: do not write the time yourself and do not run date / Get-Date for it."

/**
 * Stamps "HH:MM" before the first piece of every text block the model streams (not the provider's own
 * notes). Returns a function part -> part.
 */
export function timeStamper(now = () => new Date()) {
  const fresh = new Set()
  return (part) => {
    if (part.type === "text-start" && !String(part.id).startsWith("provider-note-")) fresh.add(part.id)
    if (part.type === "text-delta" && fresh.has(part.id) && part.delta) {
      fresh.delete(part.id)
      return { ...part, delta: hhmm(now()) + String.fromCharCode(10, 10) + part.delta }
    }
    return part
  }
}
