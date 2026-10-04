// node --test test/
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { TIME_HINT, enabledSkills, hhmm, timeStamper } from "../src/lib.js"
import { DEFAULTS, settingsFor, switchSources } from "../src/settings.js"
import { toolsReport } from "../src/tools-report.js"

test("skills: an allowlist of every discovered skill except those set to false; nothing off -> no filter", () => {
  const found = ["flow", "integrator", "dataviz", "anthropic-skills:docx", "code-review"]
  assert.deepEqual(enabledSkills(found, { dataviz: false, "anthropic-skills:docx": false, flow: true }), ["flow", "integrator", "code-review"])
  assert.equal(enabledSkills(found, { flow: true }), undefined)
  assert.equal(enabledSkills([], { dataviz: false }), undefined) // unknown list -> load all rather than none
})

test("default skills off are the ones useless in OpenCode; a project can switch one back on", () => {
  const off = Object.entries(DEFAULTS.skills).filter(([, on]) => on === false).map(([n]) => n)
  assert.ok(off.includes("keybindings-help") && off.includes("anthropic-skills:pptx"))
  assert.ok(!off.includes("code-review") && !off.includes("flow"))
  const repo = mkdtempSync(path.join(os.tmpdir(), "occ-skills-"))
  mkdirSync(path.join(repo, ".opencode"))
  writeFileSync(path.join(repo, ".opencode", "opencode-claude-code-provider.json"), JSON.stringify({ skills: { dataviz: true }, timeStamp: true }))
  const cfg = settingsFor({}, repo)
  assert.equal(cfg.skills.dataviz, true)
  assert.equal(cfg.skills.loop, false)
  assert.equal(cfg.timeStamp, true)
  assert.equal(settingsFor({}, undefined).timeStamp, false) // off by default
  assert.deepEqual(switchSources("skills", {}, repo).skills.dataviz, { on: true, by: "project" })
})

test("time stamp: HH:MM before the first piece of each model text block, never on the provider's notes", () => {
  const stamp = timeStamper(() => new Date(2026, 9, 5, 9, 7))
  const out = [
    { type: "text-start", id: "provider-note-0" },
    { type: "text-delta", id: "provider-note-0", delta: "note" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "Hel" },
    { type: "text-delta", id: "t1", delta: "lo" },
    { type: "text-start", id: "t2" },
    { type: "text-delta", id: "t2", delta: "Second" },
  ].map(stamp)
  assert.equal(out[1].delta, "note")
  assert.equal(out[3].delta, "09:07\n\nHel")
  assert.equal(out[4].delta, "lo")
  assert.equal(out[6].delta, "09:07\n\nSecond")
  assert.match(hhmm(), /^\d\d:\d\d$/)
  assert.match(TIME_HINT, /do not write the time/)
})

test("/cc-tools lists skills too, with the deciding layer", () => {
  const report = toolsReport({
    all: ["Bash"],
    sources: { tools: {} },
    language: "en",
    skills: { all: ["flow", "dataviz", "code-review"], sources: switchSources("skills", { skills: { flow: false } }, undefined) },
  })
  const row = (n) => report.split("\n").find((l) => l.startsWith(`| ${n} |`))
  assert.match(report, /## Claude Code skills in this window/)
  assert.match(row("flow"), /\| off \| opencode\.jsonc \|/)
  assert.match(row("dataviz"), /\| off \| provider default \|/)
  assert.match(row("code-review"), /\| on \| Claude Code \|/)
})
