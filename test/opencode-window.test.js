// The window OpenCode uses for a model, read from OpenCode's config (plan 001, decision 4).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { opencodeWindow, opencodeConfigFiles, parseJsonc } from "../src/opencode-window.js"
import { explicitSettingsFor } from "../src/settings.js"

const tmp = mkdtempSync(path.join(os.tmpdir(), "ccp-window-"))
const env = { XDG_CONFIG_HOME: path.join(tmp, "config") }
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
// global: opus 720k, sonnet 720k, compaction.reserved 20k (with comments and a URL in a string)
write(
  path.join(env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc"),
  `{
  "$schema": "https://opencode.ai/config.json", // a URL with // inside a string
  /* block comment */
  "compaction": { "auto": true, "reserved": 20000 },
  "providers": { "claude-code": { "package": "aisdk:file:///x/opencode-claude-code-provider/index.js",
    "models": { "opus": { "name": "Opus", "limit": { "context": 720000, "output": 64000 } },
                "sonnet": { "limit": { "context": 720000, "output": 64000 } }, }, }, },
}`,
)
// a project above its repositories (like D:/Sources/nv-lang): opus 520k
const nv = path.join(tmp, "nv")
const tab = path.join(nv, "repo", "src")
mkdirSync(tab, { recursive: true })
write(path.join(nv, ".opencode", "opencode.jsonc"), `{ "providers": { "claude-code": { "models": { "opus": { "limit": { "context": 520000, "output": 64000 } } } } } }`)
const elsewhere = path.join(tmp, "other", "repo")
mkdirSync(elsewhere, { recursive: true })

test("parseJsonc keeps // inside strings, drops comments and trailing commas", () => {
  assert.deepEqual(parseJsonc(`{ "u": "https://x//y", // c\n "a": [1, 2,], /* b */ }`), { u: "https://x//y", a: [1, 2] })
})

test("the threshold is limit.context - compaction.reserved; a project file above the repo overrides the global one", () => {
  assert.equal(opencodeWindow(tab, "opus", env).threshold, 500000)
  assert.equal(opencodeWindow(elsewhere, "opus", env).threshold, 700000)
  assert.equal(opencodeWindow(tab, "sonnet", env).threshold, 700000) // the project names only opus
})

test("no limit for the model, or no reserved: no threshold from OpenCode (the provider falls back)", () => {
  assert.equal(opencodeWindow(tab, "haiku", env).threshold, undefined)
  const bare = { XDG_CONFIG_HOME: path.join(tmp, "bare") }
  write(path.join(bare.XDG_CONFIG_HOME, "opencode", "opencode.json"), JSON.stringify({ providers: { "claude-code": { models: { opus: { limit: { context: 400000, output: 1 } } } } } }))
  assert.equal(opencodeWindow(elsewhere, "opus", bare).threshold, undefined) // reserved unknown -> not guessed
})

test("the config files apply global first, then from the root down to the tab", () => {
  const files = opencodeConfigFiles(tab, env)
  assert.ok(files[0].includes(path.join("config", "opencode")))
  assert.ok(files.at(-1).includes(path.join("nv", ".opencode")))
})

test("explicitSettingsFor: the provider options and the project file, without defaults", () => {
  assert.equal(explicitSettingsFor({}, tab).autoCompactWindow, undefined) // nothing explicit -> OpenCode's window decides
  write(path.join(nv, ".opencode", "opencode-claude-code-provider.json"), JSON.stringify({ autoCompactWindow: { opus: 450000 } }))
  assert.deepEqual(explicitSettingsFor({}, tab).autoCompactWindow, { opus: 450000 })
  rmSync(tmp, { recursive: true, force: true })
})
