// node --test test/
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { toolSources } from "../settings.js"
import { isToolsCommand, toolsReport } from "../tools-report.js"

const msg = (text) => [{ role: "user", content: [{ type: "text", text }] }]

test("/cc-tools is recognized as the whole message only", () => {
  assert.equal(isToolsCommand(msg("/cc-tools")), true)
  assert.equal(isToolsCommand(msg('  "/CC-TOOLS"  ')), true) // opencode run quotes the message
  assert.equal(isToolsCommand(msg("show /cc-tools please")), false)
  assert.equal(isToolsCommand(msg("/compact")), false)
})

test("the report: every tool, on/off, and which layer decided", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "occ-tools-"))
  mkdirSync(path.join(repo, ".opencode"))
  writeFileSync(path.join(repo, ".opencode", "opencode-claude-code-provider.json"), JSON.stringify({ tools: { Workflow: true } }))
  const sources = toolSources({ tools: { WebSearch: false } }, repo)
  const all = ["Bash", "Read", "WebSearch", "Workflow", "Artifact", "ToolSearch", "mcp__peers__peer_send", "NotebookEdit"]
  const report = toolsReport({ all, sources, usage: { categories: [{ name: "System tools", tokens: 15000 }], totalTokens: 30000 }, language: "en", alsoDisallowed: ["NotebookEdit"] })
  const row = (name) => report.split("\n").find((l) => l.startsWith(`| ${name} |`))
  assert.match(row("Bash"), /\| on \| Claude Code \|/)
  assert.match(row("WebSearch"), /\| off \| opencode\.jsonc \|/)
  assert.match(row("Workflow"), /\| on \| project file \|/) // the project switched the default back on
  assert.match(row("Artifact"), /\| off \| provider default \|/)
  assert.match(row("NotebookEdit"), /\| off \| disallowedTools \|/)
  assert.match(row("DesignSync"), /\| off \| provider default \|/) // a default even when Claude Code did not list it
  assert.ok(report.indexOf("| mcp__peers__peer_send") > report.indexOf("| WebSearch")) // MCP tools after built-ins
  assert.match(report, /Project file: .*opencode-claude-code-provider\.json/)
  assert.match(report, /System tools 15\.0k/)
  assert.match(toolsReport({ all, sources, language: "ru" }), /\| Инструмент \| Статус \| Кто решил \|/)
})
