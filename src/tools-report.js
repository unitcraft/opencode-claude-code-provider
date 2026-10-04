// `/cc-tools` typed in a window: every tool Claude Code offers there and whether it is on, answered by the
// provider without a model call. Claude Code lists its tools at the start of a turn (the SDK's "init"
// message); the provider starts one with the window's settings minus its own switched-off tools, reads the
// list and interrupts before any request reaches the model (measured: 0 tokens). The context usage of the
// tools that stay on comes from the SDK's local estimate (no model call either).
import { query } from "@anthropic-ai/claude-agent-sdk"
import { texts } from "./texts.js"

export const TOOLS_COMMAND = "/cc-tools"

/** Is the newest user message the `/cc-tools` command? */
export function isToolsCommand(prompt) {
  const last = [...(prompt ?? [])].reverse().find((m) => m.role === "user")
  if (!last) return false
  const text = typeof last.content === "string" ? last.content : (last.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("")
  return text.trim().replace(/^"|"$/g, "").trim().toLowerCase() === TOOLS_COMMAND
}

/** The tool names Claude Code offers with `options` (an interrupted turn: no model request). */
export async function listClaudeTools(options) {
  const q = query({ prompt: "List.", options: { ...options, persistSession: false, maxTurns: 1 } })
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") {
        await q.interrupt().catch(() => {})
        return m.tools
      }
      if (m.type === "assistant" || m.type === "result") break
    }
  } finally {
    q.close?.()
  }
  return []
}

/** Context usage of what is on now (local estimate, no model call). */
export async function contextUsage(options) {
  let release
  const input = (async function* () {
    await new Promise((r) => (release = r))
  })()
  const q = query({ prompt: input, options: { ...options, persistSession: false } })
  try {
    return await q.getContextUsage({ detail: "summary" })
  } finally {
    release?.()
    q.close?.()
  }
}

/**
 * The report: `all` -- tool names with nothing of the provider switched off; `sources` -- toolSources();
 * `usage` -- contextUsage() with the window's real settings.
 */
export function toolsReport({ all, sources, usage, language, alsoDisallowed = [] }) {
  const t = texts(language)
  const rows = []
  const names = [...new Set([...all, ...Object.keys(sources.tools)])]
  const builtin = names.filter((n) => !n.startsWith("mcp__")).sort()
  const mcp = names.filter((n) => n.startsWith("mcp__")).sort()
  for (const name of [...builtin, ...mcp]) {
    const s = sources.tools[name]
    const off = (s && !s.on) || alsoDisallowed.includes(name)
    const by = alsoDisallowed.includes(name) ? "disallowedTools" : s ? t.layer[s.by] : t.layer.claude
    const unknown = !all.includes(name) && !off ? ` (${t.notOffered})` : ""
    rows.push(`| ${name} | ${off ? t.off : t.on}${unknown} | ${by} |`)
  }
  const cats = (usage?.categories ?? []).filter((c) => /tool|prompt|skill|memory|mcp/i.test(c.name))
  const k = (n) => `${(n / 1000).toFixed(1)}k`
  const onCount = rows.filter((r) => r.includes(`| ${t.on}`)).length
  return [
    `## ${t.toolsTitle}`,
    "",
    t.toolsSummary(onCount, rows.length - onCount, sources.projectFile),
    "",
    `| ${t.tool} | ${t.status} | ${t.decidedBy} |`,
    "|---|---|---|",
    ...rows,
    ...(cats.length ? ["", `${t.contextNow}: ${cats.map((c) => `${c.name} ${k(c.tokens)}`).join(", ")}${usage.totalTokens ? ` — ${t.total} ${k(usage.totalTokens)}` : ""}.`] : []),
    "",
    t.toolsHow,
  ].join("\n")
}
