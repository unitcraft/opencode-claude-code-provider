// node --test test/
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { COMPACTION_SUMMARY, helperSettings, isCompactionRequest, isHelperRequest, loadSessionMap, peersMcpServer, resolvePeersMcp, saveSessionMap, sessionDirectory } from "../lib.js"

function fakeOpencode() {
  const data = mkdtempSync(path.join(os.tmpdir(), "occ-"))
  const repo = path.join(data, "repo")
  mkdirSync(repo)
  const db = new DatabaseSync(path.join(data, "opencode.db"))
  db.exec("create table session_v2 (id text primary key, directory text not null)")
  db.prepare("insert into session_v2 values (?, ?)").run("ses_A", repo)
  db.prepare("insert into session_v2 values (?, ?)").run("ses_GONE", path.join(data, "deleted"))
  db.close()
  return { data, repo }
}

test("the session directory comes from opencode.db", async () => {
  const { data, repo } = fakeOpencode()
  assert.equal(await sessionDirectory("ses_A", data), repo)
})

test("unknown session, missing directory or missing database -> undefined (caller refuses)", async () => {
  const { data } = fakeOpencode()
  assert.equal(await sessionDirectory("ses_NOPE", data), undefined)
  assert.equal(await sessionDirectory("ses_GONE", data), undefined)
  assert.equal(await sessionDirectory("ses_A", path.join(data, "no-such-dir")), undefined)
  assert.equal(await sessionDirectory(undefined, data), undefined)
})

test("the session map survives a reload", () => {
  const { data } = fakeOpencode()
  const file = path.join(data, "map.json")
  assert.deepEqual(loadSessionMap(file), {})
  saveSessionMap({ ses_A: "11111111-2222-3333-4444-555555555555" }, file)
  assert.deepEqual(loadSessionMap(file), { ses_A: "11111111-2222-3333-4444-555555555555" })
})

test("peers MCP: explicit path, sibling checkout by default, off with false or when absent", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "occ-peers-"))
  const provider = path.join(base, "opencode-claude-code-provider")
  const sibling = path.join(base, "opencode-peers", "mcp.ts")
  mkdirSync(provider)
  assert.equal(resolvePeersMcp(undefined, provider), undefined) // no sibling yet
  mkdirSync(path.dirname(sibling))
  writeFileSync(sibling, "")
  assert.equal(resolvePeersMcp(undefined, provider), sibling)
  assert.equal(resolvePeersMcp(false, provider), undefined)
  const other = path.join(base, "elsewhere-mcp.ts")
  writeFileSync(other, "")
  assert.equal(resolvePeersMcp(other, provider), other)
  assert.equal(resolvePeersMcp(path.join(base, "missing.ts"), provider), undefined)
})

test("peers MCP server acts for the requesting OpenCode session, in the same mailbox", () => {
  const cfg = peersMcpServer("D:/x/mcp.ts", "ses_A", { env: { XDG_DATA_HOME: "D:/data", OTHER: "1" } })
  assert.deepEqual(cfg, { type: "stdio", command: "node", args: ["D:/x/mcp.ts"], env: { OPENCODE_PEERS_SESSION: "ses_A", XDG_DATA_HOME: "D:/data" } })
  assert.deepEqual(peersMcpServer("m.ts", "ses_B", { node: "C:/node.exe", env: {} }).env, { OPENCODE_PEERS_SESSION: "ses_B" })
})

test("helper requests (no tools: title, summary) are told apart from agent turns", () => {
  // shapes measured 2026-10-04: the title request had 0 tools, the agent turn 12, both the same session header
  assert.equal(isHelperRequest({ tools: undefined }), true)
  assert.equal(isHelperRequest({ tools: [] }), true)
  assert.equal(isHelperRequest({ tools: [{ type: "function", name: "bash" }] }), false)
})

test("a helper request runs as a plain call: its own system prompt, no tools, no MCP, nothing kept", () => {
  const s = helperSettings([
    { role: "system", content: "You are a title generator." },
    { role: "system", content: "Rules." },
    { role: "user", content: [{ type: "text", text: "Call peer_send" }] },
  ])
  assert.equal(s.systemPrompt, "You are a title generator.\n\nRules.")
  assert.deepEqual(s.tools, [])
  assert.deepEqual(s.mcpServers, {})
  assert.equal(s.strictMcpConfig, true)
  assert.deepEqual(s.settingSources, [])
  assert.equal(s.persistSession, false)
  assert.equal(s.maxTurns, 1)
})

// OpenCode's compaction request, as measured 2026-10-04 (last user message, shortened)
const compactionAsk = (opening) => [
  { role: "system", content: "You are an AI agent running in OpenCode" },
  { role: "user", content: [{ type: "text", text: "Remember the code word PELICAN-42." }] },
  { role: "assistant", content: [{ type: "text", text: "Saved." }] },
  { role: "user", content: [{ type: "text", text: `${opening}\n\nYou MUST use this format for your response.\n<template>\n## Objective\n- [..]\n## Requirements\n</template>` }] },
]

test("OpenCode's compaction request is recognized, both openings; ordinary turns are not", () => {
  assert.equal(isCompactionRequest(compactionAsk("You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.")), true)
  assert.equal(isCompactionRequest(compactionAsk("Update the existing checkpoint in the conversation above into one consolidated summary.")), true)
  assert.equal(isCompactionRequest([{ role: "user", content: [{ type: "text", text: "Write a README with ## Objective and ## Requirements" }] }]), false)
  assert.equal(isCompactionRequest([{ role: "user", content: "/compact" }]), false)
  // only the LAST user message counts: a compaction ask earlier in the history is not a compaction now
  assert.equal(isCompactionRequest([...compactionAsk("You MUST summarize the conversation above into a structured summary"), { role: "assistant", content: [] }, { role: "user", content: [{ type: "text", text: "next task" }] }]), false)
  assert.match(COMPACTION_SUMMARY, /^## Objective$/m) // OpenCode accepts a summary only with its template headings
})

test("the provider answers compaction itself: no Claude Code run, no session lookup", async () => {
  const { createClaudeCode } = await import("../index.js")
  const model = createClaudeCode({ peersMcp: false }).languageModel("haiku")
  const tools = [{ type: "function", name: "bash", inputSchema: { type: "object" } }]
  // no session header: a real run would be refused ("cannot resolve the directory"), so an answer proves no run
  const g = await model.doGenerate({ prompt: compactionAsk("You MUST summarize the conversation above into a structured summary"), tools, headers: {} })
  assert.equal(g.content[0].text, COMPACTION_SUMMARY)
  assert.equal(g.usage.inputTokens.total, 0)
  const s = await model.doStream({ prompt: compactionAsk("Update the existing checkpoint in the conversation above into one consolidated summary"), tools, headers: {} })
  const parts = []
  for await (const p of s.stream) parts.push(p)
  assert.deepEqual(parts.map((p) => p.type), ["stream-start", "text-start", "text-delta", "text-end", "finish"])
  assert.equal(parts[2].delta, COMPACTION_SUMMARY)
  // an ordinary turn still goes to Claude Code (here refused: no session)
  await assert.rejects(model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools, headers: {} }), /cannot resolve the directory/)
})
