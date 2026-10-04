// Does the installed OpenCode still send what this provider recognizes? Two rules depend on OpenCode's own
// code, and if OpenCode changes it they silently stop working (no error, just wasted Claude turns):
//   * COMPACTION: recognized by OpenCode's fixed wording (lib.js COMPACTION_OPENINGS + "## Objective");
//     unrecognized -> OpenCode's compaction is a full Claude turn again and lengthens Claude Code's memory;
//   * HELPER requests (title, ...): recognized by having NO tools; if OpenCode starts sending tools with
//     them, a title request is a full Claude turn again and repeats the window's message (letters twice).
// The check reads OpenCode's program (its bundled JavaScript inside opencode.exe), not a live request,
// so it costs nothing. The provider runs it once per OpenCode version (the version comes with every
// request in User-Agent) and warns when it fails; `npm run check-opencode` runs it by hand.
import { execSync, spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { COMPACTION_OPENINGS, opencodeDataDir } from "./lib.js"
import { texts } from "./texts.js"

/** Check OpenCode's program text. `problems` empty -> the provider's rules still match. */
export function checkOpenCodeProgram(text) {
  const problems = []
  const facts = []
  for (const o of COMPACTION_OPENINGS) {
    if (!text.includes(o)) problems.push(`compaction: OpenCode no longer contains the opening "${o}"`)
  }
  if (!text.includes("You MUST use this format for your response")) problems.push("compaction: the template introduction is gone")
  if (!text.includes("## Objective")) problems.push('compaction: the template heading "## Objective" is gone (the provider\'s answer to compaction uses it)')
  // the title request: OpenCode builds it with request.title({...}); it must carry no tools
  const t = text.indexOf(".request.title({")
  if (t < 0) problems.push("title: the title request (request.title) is not found")
  else {
    const call = text.slice(t, text.indexOf("messages:", t) + 1 || t + 400)
    if (call.includes("tools:")) problems.push("title: the title request now carries tools -- helper requests are no longer told apart by 'no tools'")
    else facts.push("title request without tools")
  }
  if (!text.includes("You are a title generator")) facts.push("title prompt wording changed (informational)")
  // the compaction request is built with the window's tools (that is why it is recognized by wording)
  if (/\.compaction\(\{session:[^;]{0,300}?tools:/.test(text)) facts.push("compaction request with tools")
  else facts.push("compaction request shape changed (informational)")
  return { ok: problems.length === 0, problems, facts }
}

/** OpenCode's executable: this process when running inside OpenCode, else the npm global install. */
export function findOpenCode() {
  if (/^opencode(\.exe)?$/i.test(path.basename(process.execPath))) return process.execPath
  try {
    const root = execSync("npm root -g", { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim()
    for (const f of ["opencode.exe", "opencode"]) {
      const p = path.join(root, "@opencode", "cli", "bin", f)
      if (existsSync(p)) return p
    }
  } catch {}
  return undefined
}

/** The installed OpenCode's version (package.json next to its program), without a request. */
export function installedOpenCodeVersion(file = findOpenCode()) {
  try {
    return JSON.parse(readFileSync(path.join(path.dirname(path.dirname(file)), "package.json"), "utf8")).version
  } catch {
    return undefined
  }
}

/** The ready prompt for an agent that adapts the provider to a new OpenCode. */
export const ADAPT_PROMPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "docs", "adapt-to-opencode.md")

/** "opencode/latest/2.0.22/cli" -> "2.0.22". */
export function openCodeVersion(headers) {
  const ua = headers?.["User-Agent"] ?? headers?.["user-agent"] ?? ""
  return /opencode\/[^/]*\/(\d+\.\d+\.\d+[^/]*)\//.exec(ua)?.[1]
}

export async function checkOpenCodeFile(file) {
  const text = (await readFile(file)).toString("latin1")
  return checkOpenCodeProgram(text)
}

const stateFile = (dataDir = opencodeDataDir()) => path.join(dataDir, "claude-code-provider-check.json")
export const readCheckState = (dataDir) => {
  try {
    return JSON.parse(readFileSync(stateFile(dataDir), "utf8"))
  } catch {
    return undefined
  }
}

/** A Windows notification (best effort, never throws). */
export function toast(title, text) {
  if (process.platform !== "win32") return
  const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c])
  const xml = `<toast><visual><binding template='ToastGeneric'><text>${esc(title)}</text><text>${esc(text)}</text></binding></visual></toast>`
  const ps =
    "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]>$null;" +
    "[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]>$null;" +
    "$x=New-Object Windows.Data.Xml.Dom.XmlDocument;$x.LoadXml($env:CCP_TOAST);" +
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))"
  try {
    spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { env: { ...process.env, CCP_TOAST: xml }, windowsHide: true, stdio: "ignore", detached: true }).unref()
  } catch {}
}

/**
 * Once per OpenCode version: check the program and remember the result in
 * <opencode data>/claude-code-provider-check.json. A failed check notifies (Windows notification, log).
 * Returns the state for this version once known (undefined while the check runs).
 */
export function watchOpenCode(version, { dataDir = opencodeDataDir(), file = findOpenCode(), notify = toast, log = () => {} } = {}) {
  if (!version) return undefined
  const state = readCheckState(dataDir)
  if (state?.version === version) return state
  if (watchOpenCode.running === version) return undefined
  watchOpenCode.running = version
  ;(async () => {
    let result
    try {
      result = file ? await checkOpenCodeFile(file) : { ok: false, problems: ["OpenCode's program file not found"], facts: [] }
    } catch (e) {
      result = { ok: false, problems: [`check failed: ${e}`], facts: [] }
    }
    const next = { version, file, checkedAt: new Date().toISOString(), ...result }
    try {
      writeFileSync(stateFile(dataDir), JSON.stringify(next, null, 1))
    } catch {}
    log(`opencode ${version}: ${result.ok ? "ok" : "PROBLEMS " + result.problems.join("; ")}`)
    if (!result.ok) notify(`claude-code: OpenCode ${version} changed`, `${result.problems.join("; ")}. Prompt: ${ADAPT_PROMPT}`)
  })().finally(() => {
    watchOpenCode.running = undefined
  })
  return undefined
}

/** The warning a window shows (every hour) while the check for this OpenCode version fails. */
export const CHECK_WARNING = (state, language) => texts(language).checkWarning(state, ADAPT_PROMPT)
