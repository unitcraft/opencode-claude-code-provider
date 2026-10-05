// The window OpenCode uses for a model, read from OpenCode's own config (plan 001, decision 4).
//
// OpenCode compacts a session when its context reaches limit.context - compaction.reserved of the model (measured
// on OpenCode 2.0.22, 2026-10-05), and shows the context as a percentage of limit.context. Claude Code compacts
// its own memory at CLAUDE_CODE_AUTO_COMPACT_WINDOW. One source for both: the provider takes Claude Code's threshold
// from OpenCode's config, so the percentage in the window means "how far to compaction" and both compact at the
// same point (OpenCode's compaction is passed to Claude Code anyway). An explicit autoCompactWindow still wins.
//
// OpenCode collects its config from the global file and from opencode.json(c) and .opencode/opencode.json(c)
// upward from the tab's directory (measured: a parent folder of the repository counts), deeper files override.

import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/** JSONC: comments outside strings and trailing commas removed. */
export function parseJsonc(text) {
  let out = ""
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === "\\") out += text[++i] ?? ""
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
    } else out += c
  }
  return JSON.parse(out.replace(/^﻿/, "").replace(/,(\s*[}\]])/g, "$1"))
}

const read = (file) => {
  try {
    return existsSync(file) ? parseJsonc(readFileSync(file, "utf8")) : undefined
  } catch {
    return undefined
  }
}

/** OpenCode's config files that apply to dir, global first, then from the root down to dir. */
export function opencodeConfigFiles(dir, env = process.env) {
  const configDir = env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, "opencode") : path.join(os.homedir(), ".config", "opencode")
  const files = ["opencode.json", "opencode.jsonc"].map((n) => path.join(configDir, n))
  const chain = []
  let d = dir ? path.resolve(dir) : ""
  for (let i = 0; d && i < 64; i++) {
    chain.unshift(d)
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  for (const c of chain) for (const n of ["opencode.json", "opencode.jsonc", path.join(".opencode", "opencode.json"), path.join(".opencode", "opencode.jsonc")]) files.push(path.join(c, n))
  return files.filter((f) => existsSync(f))
}

// The provider's entry in an OpenCode config: the key "claude-code", else a provider whose package is this one.
const providerOf = (cfg) => {
  const all = { ...(cfg?.provider ?? {}), ...(cfg?.providers ?? {}) }
  return all["claude-code"] ?? Object.values(all).find((p) => /claude-code-provider/.test(String(p?.package ?? p?.npm ?? "")))
}

const CACHE_MS = 5_000
const cache = new Map()

/** {context, reserved, threshold} of the model for a tab in dir, or undefined parts when OpenCode's config is silent. */
export function opencodeWindow(dir, modelId, env = process.env, now = Date.now()) {
  const key = `${env.XDG_CONFIG_HOME ?? ""}\0${dir}\0${modelId}` // which global config is read is part of the key
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_MS) return hit.value
  let context
  let reserved
  for (const file of opencodeConfigFiles(dir, env)) {
    const cfg = read(file)
    const limit = providerOf(cfg)?.models?.[modelId]?.limit
    if (typeof limit?.context === "number") context = limit.context
    if (typeof cfg?.compaction?.reserved === "number") reserved = cfg.compaction.reserved
  }
  const value = { context, reserved, threshold: context && reserved !== undefined && context > reserved ? context - reserved : undefined }
  cache.set(key, { at: now, value })
  return value
}
