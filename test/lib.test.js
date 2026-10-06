// node --test test/
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { compactionAnswer, texts } from "../src/texts.js"
import { claudeEnv, backgroundHint, backgroundWatch, autoCompactWindowFor, disabledTools, helperSettings, lastCallUsage, mainModelUsage, newUserTurn, rawUserTurn, shortenToolInput, isCompactionRequest, isHelperRequest, loadSessionMap, crewMcpServer, resolveCrewMcp, saveSessionMap, sessionDirectory } from "../src/lib.js"

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

test("crew MCP: explicit path, sibling checkout by default, off with false or when absent", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "occ-crew-"))
  const provider = path.join(base, "opencode-claude-code-provider")
  const sibling = path.join(base, "crew-harness", "mcp.ts")
  mkdirSync(provider)
  assert.equal(resolveCrewMcp(undefined, provider), undefined) // no sibling yet
  mkdirSync(path.dirname(sibling))
  writeFileSync(sibling, "")
  assert.equal(resolveCrewMcp(undefined, provider), sibling)
  assert.equal(resolveCrewMcp(false, provider), undefined)
  const other = path.join(base, "elsewhere-mcp.ts")
  writeFileSync(other, "")
  assert.equal(resolveCrewMcp(other, provider), other)
  assert.equal(resolveCrewMcp(path.join(base, "missing.ts"), provider), undefined)
})

test("crew MCP server acts for the requesting OpenCode session, in the same mailbox", () => {
  const cfg = crewMcpServer("D:/x/mcp.ts", "ses_A", { env: { XDG_DATA_HOME: "D:/data", OTHER: "1" } })
  assert.deepEqual(cfg, { type: "stdio", command: "node", args: ["D:/x/mcp.ts"], env: { OPENCODE_CREW_SESSION: "ses_A", XDG_DATA_HOME: "D:/data" } })
  assert.deepEqual(crewMcpServer("m.ts", "ses_B", { node: "C:/node.exe", env: {} }).env, { OPENCODE_CREW_SESSION: "ses_B" })
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
    { role: "user", content: [{ type: "text", text: "Call crew_send" }] },
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
  assert.match(compactionAnswer("en", "x"), /^## Objective$/m) // OpenCode accepts a summary only with its template headings
})

test("/compact of a window without a Claude Code session: answered at once, nothing to compact", async () => {
  const { createClaudeCode } = await import("../index.js")
  const model = createClaudeCode({ crewMcp: false, watchOpenCode: false, autoCompactWindow: { haiku: 150000 } }).languageModel("haiku")
  const tools = [{ type: "function", name: "bash", inputSchema: { type: "object" } }]
  // no session header: a real run would be refused ("cannot resolve the directory"), so an answer proves no run
  const g = await model.doGenerate({ prompt: compactionAsk("You MUST summarize the conversation above into a structured summary"), tools, headers: {} })
  const expected = compactionAnswer("en", texts("en").compactNothing, { model: "haiku", threshold: 150000 })
  assert.equal(g.content[0].text, expected)
  assert.match(g.content[0].text, /nothing to compact yet.*~150k tokens/s)
  assert.equal(g.usage.inputTokens.total, 0)
  const s = await model.doStream({ prompt: compactionAsk("Update the existing checkpoint in the conversation above into one consolidated summary"), tools, headers: {} })
  const parts = []
  for await (const p of s.stream) parts.push(p)
  assert.deepEqual(parts.map((p) => p.type), ["stream-start", "text-start", "text-delta", "text-end", "finish"])
  assert.equal(parts[2].delta, expected)
  // an ordinary turn still goes to Claude Code (here refused: no session)
  await assert.rejects(model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools, headers: {} }), /cannot resolve the directory/)
})

test("/compact answer names the threshold: configured (clamped as Claude Code does) or Claude Code's own; en default, ru", () => {
  const en = texts().threshold
  assert.match(en({ model: "claude-opus-5-5", threshold: 400000, contextWindow: 1000000 }), /~400k tokens .*claude-opus-5-5 window 1000k tokens/)
  assert.match(en({ model: "haiku", threshold: 500000, contextWindow: 200000 }), /~200k tokens/) // above the window -> the window
  assert.match(en({ model: "haiku", threshold: 50000 }), /~100k tokens/) // below Claude Code's minimum 100k
  assert.match(en({ model: "sonnet" }), /a limit it picks itself/)
  assert.match(texts("ru").threshold({ model: "opus", threshold: 400000, contextWindow: 1000000 }), /~400 тыс\. токенов/)
  assert.match(compactionAnswer("ru", texts("ru").compactDone({ seconds: 19 })), /^## Objective\n- \/compact: Claude Code сжал память окна за 19 с\./)
})

test("tools: { Name: false } switches built-in tools off (true or absent keeps them)", () => {
  assert.deepEqual(disabledTools({ Artifact: false, Bash: true, Workflow: false }), ["Artifact", "Workflow"])
  assert.deepEqual(disabledTools({ Artifact: false }, ["Artifact", "X"]), ["Artifact", "X"])
  assert.deepEqual(disabledTools(undefined), [])
})

test("autoCompactWindow: one number for all models, or per model family", () => {
  assert.equal(autoCompactWindowFor(300000, "opus"), 300000)
  assert.equal(autoCompactWindowFor({ opus: 400000, haiku: 150000 }, "opus"), 400000)
  assert.equal(autoCompactWindowFor({ opus: 400000 }, "claude-opus-5-5"), 400000)
  assert.equal(autoCompactWindowFor({ opus: 400000 }, "sonnet"), undefined)
  assert.equal(autoCompactWindowFor(undefined, "opus"), undefined)
})

test("the user's text goes as typed: a text-only message becomes raw input, files stay a user message", () => {
  assert.deepEqual(rawUserTurn([{ role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "there" }] }]), [{ role: "system", content: "hi\nthere" }])
  assert.deepEqual(rawUserTurn([{ role: "user", content: "hi" }]), [{ role: "system", content: "hi" }])
  const withImage = [{ role: "user", content: [{ type: "text", text: "see" }, { type: "file", mediaType: "image/png", data: "AA==" }] }]
  assert.equal(rawUserTurn(withImage), withImage)
  const history = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]
  assert.equal(rawUserTurn(history), history) // a whole history (no resume) keeps its roles
})

test("newUserTurn: everything the user side queued since the last answer, merged", () => {
  const u = (text) => ({ role: "user", content: [{ type: "text", text }] })
  const a = { role: "assistant", content: [{ type: "text", text: "old answer" }] }
  assert.deepEqual(newUserTurn([{ role: "system", content: "s" }, u("q1"), a, u("hi")]), [u("hi")])
  // a letter queued with session.synthetic comes right before the user's message: both reach Claude Code
  assert.deepEqual(newUserTurn([u("q1"), a, u("letter"), u("hi")]), [{ role: "user", content: [{ type: "text", text: "letter" }, { type: "text", text: "hi" }] }])
  assert.deepEqual(rawUserTurn(newUserTurn([u("q1"), a, u("letter"), { role: "user", content: "hi" }])), [{ role: "system", content: ["letter", "hi"].join(String.fromCharCode(10)) }])
  // an image stays attached to the merged user message
  const img = { role: "user", content: [{ type: "file", mediaType: "image/png", data: "x" }, { type: "text", text: "look" }] }
  const merged = newUserTurn([a, u("letter"), img])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].content.length, 3)
  // no user message at the end: the history without system messages
  assert.deepEqual(newUserTurn([{ role: "system", content: "s" }, a]), [a])
})

test("lastCallUsage: the context is the input of the last model call, not the sum over the turn", () => {
  const u = lastCallUsage()
  const summed = { inputTokens: { total: 125787, noCache: 44, cacheRead: 125132, cacheWrite: 611 }, outputTokens: { total: 1618 } }
  assert.equal(u.apply(summed), summed) // nothing seen yet: as is
  u.onSdkMessage({ type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 29000, cache_creation_input_tokens: 300 } } })
  u.onSdkMessage({ type: "assistant", message: { usage: { input_tokens: 12, cache_read_input_tokens: 34000, cache_creation_input_tokens: 500 } } })
  u.onSdkMessage({ type: "assistant", parent_tool_use_id: "t1", message: { usage: { input_tokens: 5, cache_read_input_tokens: 900000 } } }) // a subagent: not the main context
  u.onSdkMessage({ type: "user", message: {} })
  const fixed = u.apply(summed)
  assert.deepEqual(fixed.inputTokens, { total: 34512, noCache: 12, cacheRead: 34000, cacheWrite: 500 })
  assert.equal(fixed.outputTokens.total, 1618) // output stays summed
})

test("shortenToolInput: long string values are cut for display", () => {
  const long = "x".repeat(1000)
  const out = JSON.parse(shortenToolInput(JSON.stringify({ command: long, description: "short", n: 5, list: [long] }), 300))
  assert.equal(out.command, "x".repeat(300) + "…(+700)")
  assert.equal(out.description, "short")
  assert.equal(out.n, 5)
  assert.equal(out.list[0].length, 300 + "…(+700)".length)
  assert.equal(shortenToolInput(JSON.stringify({ command: long }), 0), JSON.stringify({ command: long })) // 0 = whole input
  assert.deepEqual(shortenToolInput({ a: long }, 10), { a: "x".repeat(10) + "…(+990)" }) // an object stays an object
})

test("mainModelUsage: the window's model, not Claude Code's helper model", () => {
  const usage = {
    "claude-haiku-4-5-20251001": { contextWindow: 200000, inputTokens: 900, outputTokens: 50 }, // chores, listed first
    "claude-opus-4-6": { contextWindow: 1000000, inputTokens: 20, cacheReadInputTokens: 40000, outputTokens: 600 },
  }
  assert.deepEqual(mainModelUsage(usage, "opus"), { name: "claude-opus-4-6", contextWindow: 1000000 })
  assert.deepEqual(mainModelUsage(usage, "some-alias"), { name: "claude-opus-4-6", contextWindow: 1000000 }) // no alias match: the most tokens
  assert.deepEqual(mainModelUsage(usage, "haiku"), { name: "claude-haiku-4-5-20251001", contextWindow: 200000 })
  assert.equal(mainModelUsage({}, "opus"), undefined)
})

test("newUserTurn: OpenCode's compaction checkpoint is not passed to Claude Code (it has its own memory)", () => {
  const u = (text) => ({ role: "user", content: [{ type: "text", text }] })
  const a = { role: "assistant", content: [{ type: "text", text: "old" }] }
  const checkpoint = u(`<conversation-checkpoint>
The following is a summary...
<summary>
## Objective
- /compact: ...</summary>`)
  // recorded request after a compaction: system, the checkpoint, the owner's message
  assert.deepEqual(newUserTurn([{ role: "system", content: "s" }, checkpoint, u("1 — да, влей")]), [u("1 — да, влей")])
  assert.deepEqual(newUserTurn([a, checkpoint, u("ответ")]), [u("ответ")])
  // only a checkpoint (nothing new): nothing of it goes as the user's word
  assert.ok(!JSON.stringify(newUserTurn([{ role: "system", content: "s" }, checkpoint])).includes("conversation-checkpoint"))
})

test("resumeFor: a session is resumed only under the account it was started with", async () => {
  const { resumeFor, accountKey } = await import("../src/lib.js")
  const s = { ses1: "cc-1", [accountKey("ses1")]: "D:/acc/nv-lang", old: "cc-0" }
  assert.equal(resumeFor(s, "ses1", "D:/acc/nv-lang"), "cc-1")
  assert.equal(resumeFor(s, "ses1", "D:/acc/other"), undefined) // another account: a new session, not an error
  assert.equal(resumeFor(s, "old", "D:/acc/any"), "cc-0") // entries saved before accounts were recorded: resumed
  assert.equal(resumeFor(s, "none", "D:/acc/nv-lang"), undefined)
})

test("claudeConfigDir: the project's file overrides the provider options", async () => {
  const { settingsFor } = await import("../src/settings.js")
  const dir = mkdtempSync(path.join(os.tmpdir(), "ccp-acc-"))
  mkdirSync(path.join(dir, ".opencode"), { recursive: true })
  writeFileSync(path.join(dir, ".opencode", "opencode-claude-code-provider.json"), JSON.stringify({ claudeConfigDir: "D:/acc/project" }))
  assert.equal(settingsFor({ claudeConfigDir: "D:/acc/global" }, dir).claudeConfigDir, "D:/acc/project")
  assert.equal(settingsFor({ claudeConfigDir: "D:/acc/global" }, os.tmpdir()).claudeConfigDir, "D:/acc/global")
})

test("backgroundWatch: the live set is the last background_tasks_changed, ambient watchers left out (plan 002)", () => {
  const b = backgroundWatch()
  assert.deepEqual(b.live(), [])
  b.onSdkMessage({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a", description: "Sleep", task_type: "local_bash" }, { task_id: "w", description: "watcher", ambient: true }] })
  assert.deepEqual(b.live().map((x) => x.task_id), ["a"])
  b.onSdkMessage({ type: "system", subtype: "background_tasks_changed", tasks: [] })
  assert.deepEqual(b.live(), [])
  assert.match(backgroundHint(true), /crew_watch/)
  assert.doesNotMatch(backgroundHint(false), /crew_watch/)
})

test("claudeEnv: account, threshold and the OpenCode session for the repository's hooks (plan 003)", () => {
  const env = claudeEnv({ PATH: "p" }, { account: "D:/acc", threshold: 500000, session: "ses_abc" })
  assert.deepEqual(env, { PATH: "p", CLAUDE_CONFIG_DIR: "D:/acc", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000", OPENCODE_SESSION_ID: "ses_abc" })
  assert.deepEqual(claudeEnv({ PATH: "p" }, {}), { PATH: "p" })
})

test("mainModelUsage picks the Fable entry for a fable window", () => {
  const u = { "claude-haiku-4-5": { contextWindow: 200000, inputTokens: 900 }, "claude-fable-5-1": { contextWindow: 1000000, inputTokens: 10 } }
  assert.equal(mainModelUsage(u, "fable").name, "claude-fable-5-1")
})
