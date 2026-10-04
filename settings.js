// The provider's settings in three layers, each one over the previous:
//   1. DEFAULTS below (what an OpenCode window on Claude Code needs out of the box);
//   2. the provider `settings` in opencode.jsonc (the whole machine);
//   3. the window's project: `.opencode/claude-code.json`, searched upward from the window's directory
//      (like `.opencode/nova-peers.json` of opencode-peers), so a repository carries its own settings.
// Object settings merge key by key (a project can switch one tool back on: `"tools": { "WebSearch": true }`),
// anything else is replaced. autoCompactWindow: a number means every model ({"*": n}) and replaces the set.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

export const PROJECT_FILE = path.join(".opencode", "claude-code.json")

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
})

const KEYS = ["language", "autoCompactWindow", "tools"]
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

/** The project's `.opencode/claude-code.json` nearest to `dir` (upward), or undefined. Broken JSON -> error. */
export function findProjectSettings(dir) {
  let d = dir ? path.resolve(dir) : ""
  for (let i = 0; d && i < 32; i++) {
    const file = path.join(d, PROJECT_FILE)
    if (existsSync(file)) {
      try {
        return { file, settings: JSON.parse(readFileSync(file, "utf8")) }
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
