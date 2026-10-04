// node --test test/
import assert from "node:assert/strict"
import { test } from "node:test"
import { compactionHooks, noteChannel } from "../notes.js"
import { texts } from "../texts.js"

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

test("compaction hooks: started and finished notes, the user's own hooks kept", async () => {
  const notes = noteChannel()
  const mine = { hooks: [async () => ({ continue: true })] }
  const hooks = compactionHooks(notes, { PreCompact: [mine], Stop: [mine] }, "ru")
  assert.equal(hooks.PreCompact[0], mine)
  assert.equal(hooks.Stop[0], mine)
  assert.deepEqual(await hooks.PreCompact[1].hooks[0]({ trigger: "auto" }), { continue: true })
  await hooks.PostCompact[0].hooks[0]({ trigger: "auto" })
  const shown = notes.take()
  assert.equal(shown[0], texts("ru").compactStarted("auto"))
  assert.equal(shown[1], texts("ru").compactEnded(1))
  assert.match(texts().compactEnded(3), /^✓ Context compacted in 3 s\.$/) // English by default
})
