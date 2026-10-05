// The provider's settings in three layers, each one over the previous:
//   1. DEFAULTS below (what an OpenCode window on Claude Code needs out of the box);
//   2. the provider `settings` in opencode.jsonc (the whole machine);
//   3. the window's project: `.opencode/opencode-claude-code-provider.json`, searched upward from the window's directory
//      (like `.opencode/opencode-peers.json` of opencode-peers; the file is named after the package), so a
//      repository carries its own settings.
// Object settings merge key by key (a project can switch one tool back on: `"tools": { "WebSearch": true }`),
// anything else is replaced. autoCompactWindow: a number means every model ({"*": n}) and replaces the set.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

export const PROJECT_FILE = path.join(".opencode", "opencode-claude-code-provider.json")

export const DEFAULTS = Object.freeze({
  language: "en",
  // Claude Code compacts its memory at this size (tokens). Without it Claude Code picks the limit itself --
  // for 1M-window models the whole million, so every turn could re-read up to a million tokens.
  autoCompactWindow: { opus: 400_000, sonnet: 400_000, haiku: 160_000 },
  // Built-in Claude Code tools that are useless in an OpenCode window, removed from the context
  // (measured 2026-10-04: ~12k tokens of every turn's ~34k).
  tools: {
    Artifact: false, ArtifactComments: false, ArtifactData: false, DesignSync: false, // claude.ai artifacts
    Workflow: false, ListAgents: false, SendMessage: false, // Claude Code agent teams (letters go through opencode-peers)
    CronCreate: false, CronDelete: false, CronList: false, ScheduleWakeup: false, RemoteTrigger: false, PushNotification: false, // scheduling, cloud
    ReportFindings: false, // code review
  },
  // Skills (Claude Code's skill listing goes into every session, measured 2026-10-05: 51 skills, ~33k
  // characters): the ones useless in an OpenCode window are left out. The repository's own skills stay.
  skills: {
    "keybindings-help": false, "fewer-permission-prompts": false, // Claude Code's own terminal UI
    loop: false, schedule: false, "workflow-authoring": false, dataviz: false, // cloud/scheduling, Workflow (off), charts
    "artifact-design": false, "artifact-diagramming": false, "artifact-capabilities": false, // claude.ai artifacts (the Artifact tool is off)
    "anthropic-skills:docs": false, "anthropic-skills:docx": false, "anthropic-skills:google-workspace": false,
    "anthropic-skills:import-memory": false, "anthropic-skills:morning": false, "anthropic-skills:pdf": false,
    "anthropic-skills:pptx": false, "anthropic-skills:skill-creator": false, "anthropic-skills:xlsx": false, // claude.ai documents
  },
  // The provider stamps HH:MM at the start of each answer text and tells the model so (no `date` calls).
  timeStamp: false,
  // Claude Code's tool calls are shown in the window with long string values cut to this many characters
  // ("…(+N)"); 0 shows the whole input. Display only: Claude Code executes the tools.
  toolInputMax: 300,
})

const KEYS = ["language", "autoCompactWindow", "tools", "skills", "timeStamp", "toolInputMax"]
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const normalize = (key, v) => (key === "autoCompactWindow" && typeof v === "number" ? { "*": v } : v)

/** Layers merged in order; only the known keys. */
export function mergeSettings(...layers) {
  const out = {}
  for (const layer of layers) {
    for (const key of KEYS) {
      if (!layer || layer[key] === undefined) continue
      const v = normalize(key, layer[key])
      // a single number for autoCompactWindow means every model: it replaces, not merges
      const replaces = key === "autoCompactWindow" && typeof layer[key] === "number"
      out[key] = !replaces && isObject(v) && isObject(out[key]) ? { ...out[key], ...v } : v
    }
  }
  return out
}

/** The project's `.opencode/opencode-claude-code-provider.json` nearest to `dir` (upward), or undefined. Broken JSON -> error. */
export function findProjectSettings(dir) {
  let d = dir ? path.resolve(dir) : ""
  for (let i = 0; d && i < 32; i++) {
    const file = path.join(d, PROJECT_FILE)
    if (existsSync(file)) {
      try {
        // a BOM at the start (Notepad, PowerShell 5.1 "utf8") is not part of the JSON
        return { file, settings: JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) }
      } catch (e) {
        return { file, error: String(e?.message ?? e) }
      }
    }
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  return undefined
}

/** Effective settings of a window: defaults, then the machine's options, then the project's file. */
export function settingsFor(options, dir, log = () => {}) {
  const project = dir ? findProjectSettings(dir) : undefined
  if (project?.error) log(`project settings ignored: ${project.file}: ${project.error}`)
  return mergeSettings(DEFAULTS, options, project?.settings)
}

/** For every tool (key "tools") or skill (key "skills") a layer mentions: on/off and the deciding layer. */
export function switchSources(key, options, dir) {
  const project = dir ? findProjectSettings(dir) : undefined
  const out = {}
  for (const [by, layer] of [["default", DEFAULTS], ["machine", options], ["project", project?.settings]]) {
    for (const [name, on] of Object.entries(layer?.[key] ?? {})) if (typeof on === "boolean") out[name] = { on, by }
  }
  return { [key]: out, tools: key === "tools" ? out : undefined, projectFile: project?.file }
}
export const toolSources = (options, dir) => switchSources("tools", options, dir)
