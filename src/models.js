// МОДЕЛИ CLAUDE CODE В КАТАЛОГЕ OPENCODE (2026-10-06). Владелец: «реальные версии должны обновляться автоматически
// по команде или каждый день не чаще чем через 24 часа от предыдущего обновления и быть доступными для выбора».
// Список берётся у самого Claude Code (supportedModels — запрос управления, без вызова модели, 0 токенов) и лежит в
// кэше <данные OpenCode>/claude-code-models.json; плагин models/plugin.js кладёт его в каталог провайдера.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const REFRESH_MS = 24 * 3_600_000
export const PROVIDER_ID = "claude-code"
export const PROVIDER_NAME = "Claude Code · github/unitcraft"
const ALIASES = ["fable", "opus", "sonnet", "haiku"]

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

/**
 * Установленный на машине Claude Code (npm: рядом с командой claude лежит node_modules/@anthropic-ai/claude-code/bin/claude.exe):
 * он новее встроенного в SDK и знает свежие модели (Sonnet 5.5, пока встроенный отдаёт Sonnet 5). Не найден — undefined.
 */
export function systemClaude(env = process.env) {
  for (const dir of String(env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!dir) continue
    for (const rel of ["claude.exe", path.join("node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")]) {
      const f = path.join(dir, rel)
      try {
        if (statSync(f).isFile()) return f
      } catch {}
    }
  }
  return undefined
}

/**
 * Чем запускать Claude Code окна (опция провайдера claudeExecutable): путь — его; "bundled" или false — встроенный в SDK;
 * не задана — установленный на машине (systemClaude), если есть, иначе встроенный. Возвращает путь или undefined.
 */
export function executableFor(option, env = process.env) {
  if (option === false || option === "bundled") return undefined
  if (typeof option === "string" && option) return option
  return systemClaude(env)
}

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
      out.set(id, { id, name: `Claude ${cap(id)} (рекомендуемая${target && versionOf(target) ? ` → ${versionOf(target)}` : ""})`, family: id, template: id, alias: true, released: releasedOf({ alias: true, family: id }, target) })
      if (target && !out.has(target)) out.set(target, { id: target, name: nameOf(target, m.displayName), family: id, template: id, alias: false, released: releasedOf({ alias: false, id: target, family: id }) })
      continue
    }
    const f = family(id)
    if (!f) continue
    out.set(id, { id, name: nameOf(id, m.displayName), family: f, template: f === "fable" ? "opus" : f, alias: false, released: releasedOf({ alias: false, id, family: f }) })
  }
  return [...out.values()]
}

/**
 * Порядок в выборе модели: OpenCode сортирует по дате выхода (новые сверху), а у модели Claude Code её нет, поэтому
 * дата выдумана по версии: 5.5 новее 5.1 новее 5; при равной версии — fable, opus, sonnet, haiku; псевдоним — прямо над
 * своей точной версией.
 */
const FAMILY_RANK = { fable: 4, opus: 3, sonnet: 2, haiku: 1 }
export function releasedOf(entry, target) {
  const v = Number(versionOf(entry.alias ? target : entry.id)?.split(".").slice(0, 2).join(".")) || 0
  return Date.UTC(2020, 0, 1) + Math.round(v * 100) * 86_400_000 + (FAMILY_RANK[entry.family] ?? 0) * 60_000 + (entry.alias ? 1000 : 0)
}

/** Текст ответа /cc-update-models. */
export function modelsReport(entries, at, error) {
  if (error) return `/cc-update-models: не обновлено — ${error}`
  const when = new Date(at).toISOString().slice(0, 16).replace("T", " ")
  return [`Модели Claude Code обновлены (${when} UTC), в выборе модели:`, ...entries.map((e) => `  ${e.name}${e.alias ? "" : `  (${e.id})`}`)].join("\n")
}
