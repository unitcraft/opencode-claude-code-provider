// Before a test run (npm pretest): the temp folders of earlier runs (occ-*/ in the OS temp dir, older than an hour).
// The tests made them with mkdtemp and did not remove them: ~860 folders by 2026-10-06.
import { readdirSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

let removed = 0
for (const name of readdirSync(os.tmpdir())) {
  if (!/^occ-(?:[a-z]+-)?[A-Za-z0-9]{6}$/.test(name)) continue
  const dir = path.join(os.tmpdir(), name)
  try {
    if (Date.now() - statSync(dir).mtimeMs < 3_600_000) continue
    rmSync(dir, { recursive: true, force: true, maxRetries: 2 })
    removed++
  } catch {}
}
if (removed) console.log(`cleanup-tmp: ${removed} old test folders removed`)
