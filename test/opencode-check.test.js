// node --test test/
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { checkOpenCodeFile, checkOpenCodeProgram, findOpenCode, openCodeVersion, readCheckState, watchOpenCode } from "../opencode-check.js"

// The parts of OpenCode 2.0.22's program the rules depend on (shortened, same shapes).
const GOOD = [
  "j=yield*i.request.title({session:l.session,agent:l.agent.id,model:l.model,system:[],messages:[fo.user(l.text)]})",
  "You are a title generator. You output ONLY a thread title.",
  "return r.compaction({session:C.session,agent:C.agent.id,model:C.model,tools:C.tools,system:ne.system,messages:ne.messages})",
  "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.",
  "Update the existing checkpoint in the conversation above into one consolidated summary.",
  "You MUST use this format for your response (you may omit sections) <template>\n## Objective\n- [..]\n</template>",
].join("\n")

test("the rules match OpenCode 2.0.22's shapes", () => {
  const r = checkOpenCodeProgram(GOOD)
  assert.equal(r.ok, true, r.problems.join("; "))
  assert.deepEqual(r.facts, ["title request without tools", "compaction request with tools"])
})

test("each change OpenCode could make is caught", () => {
  const broken = {
    "compaction wording": GOOD.replace("You MUST summarize the conversation above into a structured summary", "Summarize the conversation"),
    "checkpoint wording": GOOD.replace("Update the existing checkpoint", "Refresh the checkpoint"),
    "template heading": GOOD.replace("## Objective", "## Goal"),
    "title with tools": GOOD.replace("model:l.model,system:[]", "model:l.model,tools:l.tools,system:[]"),
    "title request gone": GOOD.replace(".request.title({", ".request.name({"),
  }
  for (const [what, text] of Object.entries(broken)) assert.equal(checkOpenCodeProgram(text).ok, false, what)
})

test("the version comes from OpenCode's User-Agent", () => {
  assert.equal(openCodeVersion({ "User-Agent": "opencode/latest/2.0.22/cli" }), "2.0.22")
  assert.equal(openCodeVersion({ "user-agent": "opencode/beta/2.1.0-rc.1/tui" }), "2.1.0-rc.1")
  assert.equal(openCodeVersion({}), undefined)
})

test("checked once per version; a failed check notifies and is remembered", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "occ-check-"))
  const bad = path.join(dataDir, "opencode-bad.exe")
  writeFileSync(bad, GOOD.replace("## Objective", "## Goal"))
  const notes = []
  assert.equal(watchOpenCode("9.9.9", { dataDir, file: bad, notify: (t, x) => notes.push([t, x]) }), undefined) // running
  for (let i = 0; i < 50 && !readCheckState(dataDir); i++) await new Promise((r) => setTimeout(r, 20))
  const state = watchOpenCode("9.9.9", { dataDir, file: bad, notify: () => notes.push("again") })
  assert.equal(state.ok, false)
  assert.equal(state.version, "9.9.9")
  assert.equal(notes.length, 1)
  assert.match(notes[0][0], /9\.9\.9/)
  // a new version is checked again
  const good = path.join(dataDir, "opencode-good.exe")
  writeFileSync(good, GOOD)
  watchOpenCode("10.0.0", { dataDir, file: good, notify: () => notes.push("bad") })
  for (let i = 0; i < 50 && readCheckState(dataDir)?.version !== "10.0.0"; i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(JSON.parse(readFileSync(path.join(dataDir, "claude-code-provider-check.json"), "utf8")).ok, true)
  assert.equal(notes.length, 1)
})

test("the installed OpenCode passes (skipped when OpenCode is not installed)", async (t) => {
  const file = findOpenCode()
  if (!file || !existsSync(file)) return t.skip("OpenCode not installed")
  const r = await checkOpenCodeFile(file)
  assert.equal(r.ok, true, r.problems.join("; "))
})
