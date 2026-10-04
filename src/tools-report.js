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

/** The tools and skills Claude Code offers with `options` (an interrupted turn: no model request). */
export async function discoverClaude(options) {
  const q = query({ prompt: "List.", options: { ...options, persistSession: false, maxTurns: 1 } })
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") {
        await q.interrupt().catch(() => {})
        return { tools: m.tools ?? [], skills: m.skills ?? [] }
      }
      if (m.type === "assistant" || m.type === "result") break
    }
  } finally {
    q.close?.()
  }
  return { tools: [], skills: [] }
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
/** Rows of one switch table: every name, on/off, the deciding layer. */
function switchRows(all, decided, t, alsoOff = []) {
  const names = [...new Set([...all, ...Object.keys(decided)])]
  const plain = names.filter((n) => !n.startsWith("mcp__")).sort()
  const mcp = names.filter((n) => n.startsWith("mcp__")).sort()
  return [...plain, ...mcp].map((name) => {
    const s = decided[name]
    const off = (s && !s.on) || alsoOff.includes(name)
    const by = alsoOff.includes(name) ? "disallowedTools" : s ? t.layer[s.by] : t.layer.claude
    const unknown = !all.includes(name) && !off ? ` (${t.notOffered})` : ""
    return { on: !off, row: `| ${name} | ${off ? t.off : t.on}${unknown} | ${by} |` }
  })
}

export function toolsReport({ all, sources, usage, language, alsoDisallowed = [], skills }) {
  const t = texts(language)
  const toolRows = switchRows(all, sources.tools, t, alsoDisallowed)
  const rows = toolRows.map((r) => r.row)
  const skillRows = skills ? switchRows(skills.all, skills.sources.skills, t) : []
  const cats = (usage?.categories ?? []).filter((c) => /tool|prompt|skill|memory|mcp/i.test(c.name))
  const k = (n) => `${(n / 1000).toFixed(1)}k`
  const onCount = toolRows.filter((r) => r.on).length
  const skillsOn = skillRows.filter((r) => r.on).length
  return [
    `## ${t.toolsTitle}`,
    "",
    t.toolsSummary(onCount, rows.length - onCount, sources.projectFile),
    "",
    `| ${t.tool} | ${t.status} | ${t.decidedBy} |`,
    "|---|---|---|",
    ...rows,
    ...(skills
      ? ["", `## ${t.skillsTitle}`, "", t.onOff(skillsOn, skillRows.length - skillsOn), "", `| ${t.skill} | ${t.status} | ${t.decidedBy} |`, "|---|---|---|", ...skillRows.map((r) => r.row)]
      : []),
    ...(cats.length ? ["", `${t.contextNow}: ${cats.map((c) => `${c.name} ${k(c.tokens)}`).join(", ")}${usage.totalTokens ? ` — ${t.total} ${k(usage.totalTokens)}` : ""}.`] : []),
    "",
    t.toolsHow,
  ].join("\n")
}
