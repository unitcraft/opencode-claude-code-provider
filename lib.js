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
