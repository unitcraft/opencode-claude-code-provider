// The empty result of a task-notification turn is dropped (plan 002); everything else passes.
import { test } from "node:test"
import assert from "node:assert/strict"
import { notificationTurnFilter, lineFilter } from "../src/spawn.js"

const j = (o) => JSON.stringify(o)
const notice = j({ type: "system", subtype: "task_notification", status: "stopped" })
const empty = j({ type: "result", num_turns: 0, session_id: "s" })
const real = j({ type: "result", num_turns: 1, session_id: "s" })
const answer = j({ type: "assistant", message: { content: [] } })

test("resume after a killed background task: the notification's empty result is dropped, the real one kept", () => {
  const keep = notificationTurnFilter()
  const lines = [j({ type: "system", subtype: "init" }), notice, notice, empty, j({ type: "system", subtype: "init" }), answer, real]
  assert.deepEqual(lines.filter(keep), lines.filter((l) => l !== empty))
})

test("a result with an answer, or with no notification before it, is never dropped", () => {
  const keep = notificationTurnFilter()
  assert.equal(keep(notice), true)
  assert.equal(keep(answer), true)
  assert.equal(keep(empty), true) // the turn answered: a real result even with num_turns 0
  assert.equal(keep(empty), true) // no notification since the last result (e.g. /compact)
  assert.equal(keep("not json"), true)
})

test("lineFilter: lines split across chunks and UTF-8 split inside a character", async () => {
  const f = lineFilter(notificationTurnFilter())
  const text = [notice, empty, j({ type: "assistant", text: "ответ" }), real].join("\n") + "\n"
  const bytes = Buffer.from(text)
  const out = []
  f.on("data", (d) => out.push(d))
  const done = new Promise((r) => f.on("end", r))
  for (let i = 0; i < bytes.length; i += 7) f.write(bytes.subarray(i, i + 7))
  f.end()
  await done
  assert.equal(out.join(""), [notice, j({ type: "assistant", text: "ответ" }), real].join("\n") + "\n")
})
