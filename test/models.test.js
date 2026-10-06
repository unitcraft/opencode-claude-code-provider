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

test("the plugin: models into the catalog, the provider renamed, /cc-update-models registered", async () => {
  const data = mkdtempSync(path.join(os.tmpdir(), "occ-models-"))
  process.env.XDG_DATA_HOME = data
  const { modelsFile } = await import("../src/models.js")
  writeModels(LIST, modelsFile(), Date.now()) // fresh: no refresh at setup
  const models = new Map([["opus", { id: "opus", name: "Opus", limit: { context: 720000 }, capabilities: { attachment: true } }]])
  const provider = { name: "Claude Code Provider" }
  let transform, commands = []
  const ctx = {
    catalog: { transform: async (cb) => ((transform = cb), { dispose() {} }), reload: async () => {} },
    command: { transform: async (cb) => (cb({ add: (d) => commands.push(d) }), { dispose() {} }), reload: async () => {} },
    session: {},
  }
  const plugin = (await import("../models/plugin.js")).default
  await plugin.setup(ctx)
  transform({
    provider: { update: (_id, fn) => fn(provider) },
    model: {
      get: (_p, id) => models.get(id),
      update: (_p, id, fn) => {
        const m = models.get(id) ?? { id }
        fn(m)
        models.set(id, m)
      },
    },
  })
  assert.equal(provider.name, "Claude Code · github.com/unitcraft")
  assert.equal(models.get("claude-fable-5-1")?.name, "Claude Fable 5.1")
  assert.equal(models.get("claude-fable-5-1")?.limit?.context, 720000, "a new model takes its family's settings")
  assert.equal(models.get("opus")?.name, "Claude Opus (рекомендуемая → 5.5)")
  assert.deepEqual(commands.map((c) => c.name), ["cc-update-models"])
})
