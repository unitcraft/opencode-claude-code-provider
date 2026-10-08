// WINDOWS OF THE FAMILIES FROM OPENCODE'S CONFIG FILES (2026-10-08). The models plugin gives the exact versions (Claude Sonnet 5.5) the
// window of their family. At the moment its transform runs, OpenCode has not applied the config's `limit` to the aliases yet (opus still
// shows the default 200000 / 32000), so the family's window cannot be read from the catalog: it is read from the same files OpenCode reads.
// Chain: the global file, then `.opencode/opencode.jsonc` and `opencode.jsonc` of the project's folder and of every folder above it (the
// nearest one wins). Only providers.<id>.models.<name>.limit is taken.
import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/** JSONC → value: comments and trailing commas removed, strings untouched. */
export function parseJsonc(text) {
  let out = ""
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
    } else {
      out += c
      i++
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

const read = (file) => {
  try {
    return existsSync(file) ? parseJsonc(readFileSync(file, "utf8")) : undefined
  } catch {
    return undefined
  }
}

/** Config files of the chain, from the weakest to the strongest. */
export function configChain(directory, env = process.env) {
  const files = []
  const cfg = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  for (const f of ["opencode.jsonc", "opencode.json"]) files.push(path.join(cfg, "opencode", f))
  const dirs = []
  for (let d = directory ? path.resolve(directory) : undefined; d; ) {
    dirs.push(d)
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  for (const d of dirs.reverse()) for (const f of [path.join(".opencode", "opencode.jsonc"), path.join(".opencode", "opencode.json"), "opencode.jsonc", "opencode.json"]) files.push(path.join(d, f))
  if (env.OPENCODE_CONFIG) files.push(env.OPENCODE_CONFIG)
  return files
}

/** { family: { context, output, ... } } of the provider's models from the config chain; later files override earlier ones key by key. */
export function familyLimits(providerId, directory, env = process.env) {
  const out = {}
  for (const f of configChain(directory, env)) {
    const models = read(f)?.providers?.[providerId]?.models ?? read(f)?.provider?.[providerId]?.models
    if (!models || typeof models !== "object") continue
    for (const [name, m] of Object.entries(models)) if (m?.limit && typeof m.limit === "object") out[name] = { ...out[name], ...m.limit }
  }
  return out
}
