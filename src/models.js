// МОДЕЛИ CLAUDE CODE В КАТАЛОГЕ OPENCODE (2026-10-06). Владелец: «реальные версии должны обновляться автоматически
// по команде или каждый день не чаще чем через 24 часа от предыдущего обновления и быть доступными для выбора».
// Список берётся у самого Claude Code (supportedModels — запрос управления, без вызова модели, 0 токенов) и лежит в
// кэше <данные OpenCode>/claude-code-models.json; плагин models/plugin.js кладёт его в каталог провайдера.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const REFRESH_MS = 24 * 3_600_000
export const PROVIDER_ID = "claude-code"
export const PROVIDER_NAME = "Claude Code · github/unitcraft"
const ALIASES = ["opus", "sonnet", "haiku"]

export const dataDir = (env = process.env) => (env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, "opencode") : path.join(os.homedir(), ".local", "share", "opencode"))
export const modelsFile = (env = process.env) => path.join(dataDir(env), "claude-code-models.json")

/** Кэш: { at, models: ModelInfo[] } или undefined. */
export function readModels(file = modelsFile()) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"))
    return Array.isArray(j?.models) && Number.isFinite(j?.at) ? j : undefined
  } catch {
    return undefined
  }
}
export function writeModels(models, file = modelsFile(), now = Date.now()) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify({ at: now, models }, null, 1))
  renameSync(`${file}.tmp`, file)
}
/** Пора обновить: кэша нет или ему 24 часа. */
export const stale = (cache, now = Date.now()) => !cache || now - cache.at >= REFRESH_MS

/** Список у Claude Code: запрос управления supportedModels, без хода модели. */
export async function fetchModels(query, options = {}, timeoutMs = 60_000) {
  let release
  const input = (async function* () {
    await new Promise((r) => (release = r))
  })()
  const q = query({ prompt: input, options: { persistSession: false, ...options } })
  try {
    return await Promise.race([q.supportedModels(), new Promise((_, rej) => setTimeout(() => rej(new Error(`supportedModels: нет ответа за ${timeoutMs / 1000} с`)), timeoutMs))])
  } finally {
    release?.()
    q.close?.()
  }
}

const family = (id) => /fable|opus|sonnet|haiku/.exec(String(id).toLowerCase())?.[0]
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
/** «claude-opus-5-5» → «5.5», «claude-haiku-4-5-20251001» → «4.5» */
export function versionOf(id) {
  const m = /^claude-[a-z]+-(\d+(?:-\d{1,2})*)(?:-\d{8})?$/.exec(String(id))
  return m ? m[1].replace(/-/g, ".") : undefined
}
/** «Claude Opus 5.5» — по id; без версии — по displayName. */
export function nameOf(id, displayName) {
  const f = family(id)
  const v = versionOf(id)
  if (f && v) return `Claude ${cap(f)} ${v}`
  return displayName ? `Claude ${displayName}` : id
}

/**
 * Записи каталога из списка Claude Code: точные версии (id → «Claude Opus 5.5») и псевдонимы семейств с тем, на что
 * они сейчас указывают («Claude Sonnet (рекомендуемая → 5)»). template — семейство, у которого взять настройки
 * модели из конфига (окно, картинки): fable — как opus.
 */
export function catalogEntries(models) {
  const out = new Map()
  for (const m of models ?? []) {
    const id = String(m?.value ?? "")
    if (!id || id === "default") continue
    if (ALIASES.includes(id)) {
      const target = m.resolvedModel
      out.set(id, { id, name: `Claude ${cap(id)} (рекомендуемая${target && versionOf(target) ? ` → ${versionOf(target)}` : ""})`, family: id, template: id, alias: true })
      if (target && !out.has(target)) out.set(target, { id: target, name: nameOf(target, m.displayName), family: id, template: id, alias: false })
      continue
    }
    const f = family(id)
    if (!f) continue
    out.set(id, { id, name: nameOf(id, m.displayName), family: f, template: f === "fable" ? "opus" : f, alias: false })
  }
  return [...out.values()]
}

/** Текст ответа /cc-update-models. */
export function modelsReport(entries, at, error) {
  if (error) return `/cc-update-models: не обновлено — ${error}`
  const when = new Date(at).toISOString().slice(0, 16).replace("T", " ")
  return [`Модели Claude Code обновлены (${when} UTC), в выборе модели:`, ...entries.map((e) => `  ${e.name}${e.alias ? "" : `  (${e.id})`}`)].join("\n")
}
