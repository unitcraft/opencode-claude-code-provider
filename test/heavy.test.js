// node --test test/heavy.test.js
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { heavyCommandsFor, heavyGuard, heavyIn, withHeavyGuard } from "../src/heavy.js"

// nova's list (2026-10-07)
const LIST = ["gate.sh", "gate-novac.sh", "gates.sh", "double-build.sh", "nova test", "nova.exe test", "cargo build", "cargo test", "check-novac-differential", "check-novac-self-accepted"]

test("a heavy run is recognized however it is launched", () => {
  for (const c of [
    "bash scripts/gate.sh",
    "NOVA_GATE_TIER=loop bash scripts/gate.sh",
    "cd /d/Sources/nv-lang/worktrees/x && NOVAC_TIER=loop bash scripts/gate-novac.sh",
    "./scripts/gate.sh --tier push",
    "timeout 600 bash scripts/gate.sh",
    "bash /d/Temp/t26-gates.sh",
    "cargo build --release",
    "nova-cli/target/release/nova.exe test novac/src",
    'bash -c "cd x && bash scripts/gate-novac.sh"',
    "python scripts/guards/check-novac-self-accepted.py .",
  ])
    assert.ok(heavyIn(c, LIST), c)
})

test("a mention is not a run", () => {
  for (const c of ["grep -n gate.sh scripts/README.md", "cat scripts/gate.sh", "git log -- scripts/gate.sh", "echo cargo build", "ls scripts", "cargo --version", "nova check x.nv"]) assert.equal(heavyIn(c, LIST), undefined, c)
})

test("the hook denies a heavy Bash command with the queue hint, lets others pass", async () => {
  const g = heavyGuard(LIST, "ru")
  const r = await g({ tool_name: "Bash", tool_input: { command: "bash scripts/gate.sh" } })
  assert.equal(r.hookSpecificOutput.permissionDecision, "deny")
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /очередь машины/)
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /machine: true/)
  assert.deepEqual(await g({ tool_name: "Bash", tool_input: { command: "git status" } }), { continue: true })
  assert.deepEqual(await g({ tool_name: "Read", tool_input: { file_path: "gate.sh" } }), { continue: true })
})

test("withHeavyGuard adds the Bash hook only when the list is not empty", () => {
  const h = { PreCompact: [{ hooks: [() => {}] }] }
  assert.equal(withHeavyGuard(h, []), h)
  const w = withHeavyGuard(h, LIST)
  assert.equal(w.PreToolUse[0].matcher, "Bash")
  assert.equal(w.PreCompact, h.PreCompact)
})

test("the list comes from the committed project settings; heavy_block off turns it off", async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "occ-heavy-"))
  const g = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" })
  g("init", "-q", "-b", "main")
  mkdirSync(path.join(repo, ".opencode"))
  writeFileSync(path.join(repo, ".opencode", "opencode-peers.json"), JSON.stringify({ heavy_commands: ["gate.sh"] }))
  g("add", "-A")
  g("commit", "-q", "-m", "s")
  assert.deepEqual(await heavyCommandsFor(repo, 1), ["gate.sh"])
  writeFileSync(path.join(repo, ".opencode", "opencode-peers.json"), JSON.stringify({ heavy_commands: ["gate.sh"], heavy_block: "off" }))
  g("commit", "-q", "-am", "off")
  assert.deepEqual(await heavyCommandsFor(repo, 10 * 60_000), [], "read again after the cache, off")
  assert.deepEqual(await heavyCommandsFor(path.join(os.tmpdir(), "no-such-repo-x")), [])
})
