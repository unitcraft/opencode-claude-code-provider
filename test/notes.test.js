// node --test test/
import assert from "node:assert/strict"
import { test } from "node:test"
import { compactionWatch, noteChannel } from "../src/notes.js"
import { texts } from "../src/texts.js"

function collector() {
  const out = []
  return { out, ctl: { enqueue: (p) => out.push(p) } }
}

test("a note between model blocks goes out at once; inside a text block it waits for the block's end", () => {
  const notes = noteChannel()
  const { out, ctl } = collector()
  notes.attach(ctl)
  notes.push("early")
  assert.deepEqual(out.map((p) => p.type), ["text-start", "text-delta", "text-end"])
  notes.pass({ type: "text-start", id: "m1" })
  notes.pass({ type: "text-delta", id: "m1", delta: "Hel" })
  notes.push("late")
  assert.equal(out.filter((p) => p.delta?.includes("late")).length, 0) // not inside the model's block
  notes.pass({ type: "text-delta", id: "m1", delta: "lo" })
  notes.pass({ type: "text-end", id: "m1" })
  const types = out.map((p) => `${p.type}:${p.id}`)
  assert.deepEqual(types.slice(3), ["text-start:m1", "text-delta:m1", "text-delta:m1", "text-end:m1", "text-start:provider-note-1", "text-delta:provider-note-1", "text-end:provider-note-1"])
  assert.match(out.find((p) => p.id === "provider-note-1" && p.type === "text-delta").delta, /late/)
})

test("drain shows what still waits; take hands notes to doGenerate", () => {
  const a = noteChannel()
  const { out, ctl } = collector()
  a.attach(ctl)
  a.pass({ type: "text-start", id: "m" })
  a.push("waiting")
  a.drain()
  assert.ok(out.some((p) => p.delta?.includes("waiting")))
  const b = noteChannel()
  b.push("for generate")
  assert.deepEqual(b.take(), ["for generate"])
  assert.deepEqual(b.take(), [])
})

test("compaction watch: start from PreCompact, the end with numbers from compact_boundary, user hooks kept", async () => {
  const notes = noteChannel()
  const mine = { hooks: [async () => ({ continue: true })] }
  const seen = []
  const w = compactionWatch(notes, { userHooks: { PreCompact: [mine], Stop: [mine] }, userOnSdkMessage: (m) => seen.push(m.subtype), language: "en" })
  assert.equal(w.hooks.PreCompact[0], mine)
  assert.equal(w.hooks.Stop[0], mine)
  assert.deepEqual(await w.hooks.PreCompact[1].hooks[0]({ trigger: "auto" }), { continue: true })
  w.onSdkMessage({ type: "system", subtype: "status", status: null, compact_result: "success" })
  w.onSdkMessage({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 34745, post_tokens: 1906, duration_ms: 14183 } })
  w.finish() // nothing pending any more
  assert.deepEqual(notes.take(), [texts("en").compactStarted("auto"), "✓ Context compacted in 14 s (35k tokens → 2k tokens)."])
  assert.deepEqual(seen, ["status", "compact_boundary"]) // the user's onSdkMessage still gets everything
})

test("compaction watch: a failed compaction is shown; no boundary -> a plain end line", async () => {
  const a = noteChannel()
  const wa = compactionWatch(a, { language: "ru" })
  await wa.hooks.PreCompact[0].hooks[0]({ trigger: "manual" })
  wa.onSdkMessage({ type: "system", subtype: "status", compact_result: "failed", compact_error: "prompt too long" })
  assert.deepEqual(a.take().slice(1), ["✗ Claude Code не смог сжать контекст: prompt too long"])
  const b = noteChannel()
  const wb = compactionWatch(b, {})
  await wb.hooks.PreCompact[0].hooks[0]({ trigger: "auto" })
  wb.finish()
  assert.match(b.take()[1], /^✓ Context compacted in \d+ s\.$/)
})
