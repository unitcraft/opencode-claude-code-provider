// Does the installed OpenCode still match this provider's rules?  npm run check-opencode [-- <path to opencode.exe>]
// Exit 0: yes. Exit 1: no -- see README, "When OpenCode is updated". The provider runs the same check by
// itself once per OpenCode version; this script is for doing it by hand (e.g. right after `opencode upgrade`).
import { checkOpenCodeFile, findOpenCode } from "../src/opencode-check.js"

const file = process.argv[2] || findOpenCode()
if (!file) {
  console.error("OpenCode's program not found; pass its path: npm run check-opencode -- <path to opencode.exe>")
  process.exit(2)
}
const r = await checkOpenCodeFile(file)
console.log(`OpenCode: ${file}`)
for (const f of r.facts) console.log(`  ok   ${f}`)
for (const p of r.problems) console.log(`  FAIL ${p}`)
console.log(r.ok ? "check-opencode: ok" : "check-opencode: FAIL -- README, section \"When OpenCode is updated\"")
process.exit(r.ok ? 0 : 1)
