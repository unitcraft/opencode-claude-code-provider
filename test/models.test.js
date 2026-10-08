// node --test test/models.test.js
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { catalogEntries, fetchModels, modelsReport, nameOf, readModels, stale, versionOf, writeModels } from "../src/models.js"

// what Claude Code answered on 2026-10-06 (supportedModels), shortened
const LIST = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5" },
  { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8" },
]

test("versions and names from model ids", () => {
  assert.equal(versionOf("claude-opus-5-5"), "5.5")
  assert.equal(versionOf("claude-haiku-4-5-20251001"), "4.5")
  assert.equal(versionOf("claude-sonnet-5"), "5")
  assert.equal(nameOf("claude-fable-5-1"), "Claude Fable 5.1")
  assert.equal(nameOf("claude-new-thing", "New Thing"), "Claude New Thing")
})

test("catalog entries: exact versions and aliases with what they point at", () => {
  const e = Object.fromEntries(catalogEntries(LIST).map((x) => [x.id, x]))
  assert.equal(e.opus.name, "Claude Opus (рекомендуемая → 5.5)")
  assert.equal(e.sonnet.name, "Claude Sonnet (рекомендуемая → 5)")
  assert.equal(e["claude-opus-5-5"].name, "Claude Opus 5.5")
  assert.equal(e["claude-sonnet-5"].name, "Claude Sonnet 5")
  assert.equal(e["claude-haiku-4-5-20251001"].name, "Claude Haiku 4.5")
  assert.equal(e["claude-fable-5-1"].name, "Claude Fable 5.1")
  assert.equal(e["claude-fable-5-1"].template, "opus", "fable takes opus's settings")
  assert.equal(e.default, undefined, "default is the same as opus")
})

test("the cache: stale when absent or 24 h old", () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "occ-models-")), "m.json")
  assert.equal(stale(readModels(file)), true)
  writeModels(LIST, file, 1_000)
  assert.equal(stale(readModels(file), 1_000 + 23 * 3_600_000), false)
  assert.equal(stale(readModels(file), 1_000 + 24 * 3_600_000), true)
})

test("fetchModels asks supportedModels without a model turn and closes", async () => {
  let closed = false
  let prompt
  const fake = ({ prompt: p }) => ((prompt = p), { supportedModels: async () => LIST, close: () => (closed = true) })
  assert.deepEqual(await fetchModels(fake), LIST)
  assert.ok(closed && typeof prompt[Symbol.asyncIterator] === "function", "streaming input that sends nothing")
})

test("the report names every model", () => {
  const r = modelsReport(catalogEntries(LIST), Date.UTC(2026, 9, 6, 18))
  assert.match(r, /Claude Fable 5\.1 {2}\(claude-fable-5-1\)/)
  assert.match(r, /Claude Sonnet \(рекомендуемая → 5\)/)
  assert.match(modelsReport([], 0, "нет связи"), /не обновлено — нет связи/)
})

for (const style of ["ctx.provider/ctx.model (OpenCode 2.0)", "ctx.catalog (older)"]) {
  test(`the plugin (${style}): models into the catalog, the provider renamed, /cc-update-models registered`, async () => {
    const data = mkdtempSync(path.join(os.tmpdir(), "occ-models-"))
    process.env.XDG_DATA_HOME = data
    const { modelsFile } = await import("../src/models.js")
    writeModels(LIST, modelsFile(), Date.now()) // fresh: no refresh at setup
    const models = new Map([
      ["opus", { id: "opus", name: "Opus", limit: { context: 720000 }, capabilities: { attachment: true } }],
      // OpenCode already carries these with a default limit of its own
      ["claude-fable-5-1", { id: "claude-fable-5-1", limit: { context: 200000, output: 32000 } }],
    ])
    const provider = { name: "Claude Code Provider" }
    const modelEd = {
      get: (_p, id) => models.get(id),
      update: (_p, id, fn) => {
        const m = models.get(id) ?? { id, limit: { context: 200000, output: 32000 } } // OpenCode's own default for a new model
        fn(m)
        models.set(id, m)
      },
    }
    const providerEd = { update: (_id, fn) => fn(provider) }
    let transforms = [], commands = []
    const reg = async (cb) => (transforms.push(cb), { dispose() {} })
    const ctx = {
      command: { transform: async (cb) => (cb({ add: (d) => commands.push(d) }), { dispose() {} }), reload: async () => {} },
      session: {},
    }
    if (style.startsWith("ctx.provider")) Object.assign(ctx, { provider: { transform: async (cb) => reg((_) => cb(providerEd)), reload: async () => {} }, model: { transform: async (cb) => reg((_) => cb(modelEd)), reload: async () => {} } })
    else ctx.catalog = { transform: async (cb) => reg((_) => cb({ provider: providerEd, model: modelEd })), reload: async () => {} }
    const plugin = (await import("../models/plugin.js")).default
    await plugin.setup(ctx)
    for (const t of transforms) t()
    assert.equal(provider.name, "Claude Code · github/unitcraft")
    assert.equal(models.get("claude-fable-5-1")?.name, "Claude Fable 5.1")
    assert.equal(models.get("claude-fable-5-1")?.limit?.context, 720000, "a model with OpenCode's default limit takes its family's settings")
    assert.equal(models.get("opus")?.name, "Claude Opus (рекомендуемая → 5.5)")
    assert.deepEqual(commands.map((c) => c.name), ["cc-update-models"])
  })
}

test("plugin folder has an index.ts entry (OpenCode loads a folder plugin only through index.ts)", async () => {
  const entry = await import("../models/index.ts")
  const plugin = await import("../models/plugin.js")
  assert.equal(entry.default, plugin.default)
})

test("order in the picker: newer on top, an alias right above its exact version", async () => {
  const { catalogEntries: ce } = await import("../src/models.js")
  const list = ce([
    { value: "opus", resolvedModel: "claude-opus-5-5" },
    { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1" },
    { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
    { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
    { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6" },
    { value: "claude-fable-5", resolvedModel: "claude-fable-5" },
  ])
  const order = [...list].sort((a, b) => b.released - a.released).map((e) => e.name)
  assert.deepEqual(order, [
    "Claude Opus (рекомендуемая → 5.5)",
    "Claude Opus 5.5",
    "Claude Sonnet (рекомендуемая → 5.5)",
    "Claude Sonnet 5.5",
    "Claude Fable 5.1",
    "Claude Fable 5",
    "Claude Opus 4.6",
    "Claude Haiku (рекомендуемая → 4.5)",
    "Claude Haiku 4.5",
  ])
})

test("systemClaude finds claude.exe on PATH, or next to the npm shim", async () => {
  const { systemClaude } = await import("../src/models.js")
  const { mkdirSync, writeFileSync } = await import("node:fs")
  const dir = mkdtempSync(path.join(os.tmpdir(), "occ-path-"))
  assert.equal(systemClaude({ PATH: dir }), undefined)
  const bin = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, "claude.exe"), "")
  assert.equal(systemClaude({ PATH: dir }), path.join(bin, "claude.exe"))
})

test("executableFor: a path is taken as is, bundled/false means the SDK's copy, otherwise the installed one", async () => {
  const { executableFor, systemClaude } = await import("../src/models.js")
  const { mkdirSync, writeFileSync } = await import("node:fs")
  const dir = mkdtempSync(path.join(os.tmpdir(), "occ-exe-"))
  const bin = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, "claude.exe"), "")
  const env = { PATH: dir }
  assert.equal(executableFor(undefined, env), systemClaude(env))
  assert.equal(executableFor("bundled", env), undefined)
  assert.equal(executableFor(false, env), undefined)
  assert.equal(executableFor("X:/my/claude.exe", env), "X:/my/claude.exe")
  assert.equal(executableFor(undefined, { PATH: path.join(dir, "empty") }), undefined)
})

test("familyLimits: windows of the families from the config chain, the nearest file wins; JSONC comments and trailing commas", async () => {
  const { familyLimits, parseJsonc } = await import("../src/config-limits.js")
  const { mkdirSync, writeFileSync } = await import("node:fs")
  assert.deepEqual(parseJsonc('{ "a": "x // y", /* c */ "b": [1, 2,], // tail\n }'), { a: "x // y", b: [1, 2] })
  const root = mkdtempSync(path.join(os.tmpdir(), "occ-cfg-"))
  const cfg = path.join(root, "cfg")
  const proj = path.join(root, "work", "proj", "sub")
  mkdirSync(path.join(cfg, "opencode"), { recursive: true })
  mkdirSync(path.join(root, "work", ".opencode"), { recursive: true })
  mkdirSync(proj, { recursive: true })
  writeFileSync(path.join(cfg, "opencode", "opencode.jsonc"), '{ // global\n "providers": { "claude-code": { "models": { "sonnet": { "limit": { "context": 720000, "output": 64000 } }, "haiku": { "limit": { "context": 220000, "output": 32000 } } } } } }')
  writeFileSync(path.join(root, "work", ".opencode", "opencode.jsonc"), '{ "providers": { "claude-code": { "models": { "sonnet": { "limit": { "context": 520000 } } } } } }')
  const env = { XDG_CONFIG_HOME: cfg }
  assert.deepEqual(familyLimits("claude-code", proj, env), { sonnet: { context: 520000, output: 64000 }, haiku: { context: 220000, output: 32000 } })
  assert.deepEqual(familyLimits("claude-code", path.join(root, "elsewhere"), env).sonnet, { context: 720000, output: 64000 })
  assert.deepEqual(familyLimits("other", proj, env), {})
})

test("the plugin: an exact version takes the family's window from the config files when the catalog does not show it yet", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs")
  const root = mkdtempSync(path.join(os.tmpdir(), "occ-plug-"))
  mkdirSync(path.join(root, "cfg", "opencode"), { recursive: true })
  writeFileSync(path.join(root, "cfg", "opencode", "opencode.jsonc"), '{ "providers": { "claude-code": { "models": { "opus": { "limit": { "context": 720000, "output": 64000 } }, "haiku": { "limit": { "context": 220000, "output": 32000 } } } } } }')
  process.env.XDG_CONFIG_HOME = path.join(root, "cfg")
  process.env.XDG_DATA_HOME = path.join(root, "data")
  const { modelsFile } = await import("../src/models.js")
  writeModels(LIST, modelsFile(), Date.now())
  // at this moment the config is not applied yet: every model, aliases included, has OpenCode's default limit
  const models = new Map(["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"].map((id) => [id, { id, limit: { context: 200000, output: 32000 } }]))
  models.get("opus").limit = { context: 720000, output: 64000 } // the live catalog already shows the opus alias with the config window
  const ed = { get: (_p, id) => models.get(id), update: (_p, id, fn) => fn(models.get(id) ?? models.set(id, { id, limit: { context: 200000, output: 32000 } }).get(id)) }
  let transform
  const ctx = {
    location: { directory: path.join(root, "work") },
    provider: { transform: async () => ({ dispose() {} }), reload: async () => {} },
    model: { transform: async (cb) => ((transform = cb), { dispose() {} }), reload: async () => {} },
    command: { transform: async () => ({ dispose() {} }), reload: async () => {} },
    session: {},
  }
  await (await import("../models/plugin.js")).default.setup(ctx)
  transform(ed)
  assert.equal(models.get("claude-sonnet-5").limit.context, 720000, "exact Sonnet takes the window of its family (the config here describes opus only: opus window)")
  assert.equal(models.get("claude-fable-5-1").limit.context, 720000)
  assert.deepEqual(models.get("claude-haiku-4-5-20251001").limit, { context: 220000, output: 32000 }, "exact Haiku keeps its own family window, not the opus template one")
  delete process.env.XDG_CONFIG_HOME
})
