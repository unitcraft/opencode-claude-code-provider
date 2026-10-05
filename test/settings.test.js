// node --test test/
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { autoCompactWindowFor, disabledTools } from "../src/lib.js"
import { DEFAULTS, findProjectSettings, mergeSettings, settingsFor } from "../src/settings.js"

test("defaults alone: English, thresholds per family, the useless tools off", () => {
  const s = settingsFor({}, undefined)
  assert.equal(s.language, "en")
  assert.equal(autoCompactWindowFor(s.autoCompactWindow, "opus"), 700000)
  assert.equal(autoCompactWindowFor(s.autoCompactWindow, "claude-haiku-4-5"), 200000)
  assert.deepEqual(disabledTools(s.tools).sort(), Object.keys(DEFAULTS.tools).sort())
  assert.equal(disabledTools(s.tools).includes("Bash"), false)
})

test("the machine's options over the defaults: objects merge key by key, a number replaces the thresholds", () => {
  const s = mergeSettings(DEFAULTS, { language: "ru", tools: { WebSearch: false, Artifact: true }, autoCompactWindow: { opus: 300000 } })
  assert.equal(s.language, "ru")
  assert.equal(disabledTools(s.tools).includes("WebSearch"), true)
  assert.equal(disabledTools(s.tools).includes("Artifact"), false) // switched back on
  assert.equal(autoCompactWindowFor(s.autoCompactWindow, "opus"), 300000)
  assert.equal(autoCompactWindowFor(s.autoCompactWindow, "haiku"), 200000) // default kept
  const all = mergeSettings(DEFAULTS, { autoCompactWindow: 250000 })
  for (const m of ["opus", "sonnet", "haiku", "fable"]) assert.equal(autoCompactWindowFor(all.autoCompactWindow, m), 250000)
})

test("the project's .opencode/opencode-claude-code-provider.json, found upward from the window, is the last word", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "occ-settings-"))
  const repo = path.join(root, "repo")
  const deep = path.join(repo, "src", "deep")
  mkdirSync(path.join(repo, ".opencode"), { recursive: true })
  mkdirSync(deep, { recursive: true })
  writeFileSync(path.join(repo, ".opencode", "opencode-claude-code-provider.json"), JSON.stringify({ autoCompactWindow: { haiku: 120000 }, tools: { Workflow: true } }))
  const s = settingsFor({ language: "ru", autoCompactWindow: { haiku: 150000 } }, deep)
  assert.equal(autoCompactWindowFor(s.autoCompactWindow, "haiku"), 120000) // project over machine
  assert.equal(s.language, "ru") // machine kept where the project says nothing
  assert.equal(disabledTools(s.tools).includes("Workflow"), false) // the project wants it
  assert.equal(disabledTools(s.tools).includes("Artifact"), true) // default kept
  assert.equal(findProjectSettings(path.join(root, "elsewhere")), undefined)
})

test("a project file saved with a BOM (Notepad, PowerShell 5.1) is read", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "occ-settings-bom-"))
  mkdirSync(path.join(repo, ".opencode"))
  writeFileSync(path.join(repo, ".opencode", "opencode-claude-code-provider.json"), "\uFEFF" + JSON.stringify({ tools: { Bash: false } }))
  assert.equal(disabledTools(settingsFor({}, repo).tools).includes("Bash"), true)
})

test("a broken project file is ignored (logged), the rest still applies", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "occ-settings-bad-"))
  mkdirSync(path.join(repo, ".opencode"))
  writeFileSync(path.join(repo, ".opencode", "opencode-claude-code-provider.json"), "{ not json")
  const logs = []
  const s = settingsFor({ language: "ru" }, repo, (l) => logs.push(l))
  assert.equal(s.language, "ru")
  assert.match(logs[0], /project settings ignored/)
})
