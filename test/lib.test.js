// node --test test/
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { loadSessionMap, saveSessionMap, sessionDirectory } from "../lib.js"

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
