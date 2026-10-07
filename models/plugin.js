// ПЛАГИН МОДЕЛЕЙ провайдера claude-code (2026-10-06). Кладёт в каталог OpenCode модели, которые предлагает сам Claude
// Code: точные версии («Claude Opus 5.5») и псевдонимы с тем, на что они указывают («Claude Sonnet (рекомендуемая →
// 5)»); имя провайдера — «Claude Code · github/unitcraft». Список — из кэша src/models.js; обновляется в фоне при
// старте, если кэшу 24 часа, и командой /cc-update-models (без ограничения). Настройки новой модели (окно, картинки) —
// как у её семейства в opencode.jsonc. Что получилось с каталогом — в журнал (opencode-plugins.log).
import { appendFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { PROVIDER_ID, PROVIDER_NAME, catalogEntries, fetchModels, modelsReport, readModels, stale, writeModels } from "../src/models.js"

const LOG = path.join(os.tmpdir(), "opencode-plugins.log")
const log = (line) => {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} claude-code-models ${line}\n`)
  } catch {}
}

let refreshing
/** Спросить Claude Code и записать кэш; один запрос за раз. */
async function refresh() {
  refreshing ??= (async () => {
    try {
      const models = await fetchModels(query, { cwd: os.tmpdir() })
      writeModels(models)
      log(`refreshed: ${models.map((m) => m.value).join(", ")}`)
      return { ok: true }
    } catch (e) {
      log(`refresh failed: ${e}`)
      return { ok: false, error: String(e?.message ?? e).slice(0, 300) }
    } finally {
      refreshing = undefined
    }
  })()
  return refreshing
}

export default {
  id: "claude-code-provider.models",
  async setup(ctx) {
    const catalog = ctx.catalog
    if (!catalog?.transform) return log("no catalog API: models are not added")
    const reg = await catalog.transform((ed) => {
      try {
        ed.provider.update(PROVIDER_ID, (p) => {
          p.name = PROVIDER_NAME
        })
      } catch (e) {
        log(`provider name: ${e}`)
      }
      const cache = readModels()
      if (!cache) return
      let added = 0
      for (const e of catalogEntries(cache.models)) {
        const template = ed.model.get(PROVIDER_ID, e.template) ?? ed.model.get(PROVIDER_ID, "opus")
        try {
          ed.model.update(PROVIDER_ID, e.id, (m) => {
            if (template && m !== template && !m.limit) for (const [k, v] of Object.entries(structuredClone(template))) if (k !== "id" && k !== "name") m[k] = v
            m.name = e.name
          })
          if (ed.model.get(PROVIDER_ID, e.id)) added++
        } catch (err) {
          log(`model ${e.id}: ${err}`)
        }
      }
      log(`catalog: ${added} of ${catalogEntries(cache.models).length} models (cache ${new Date(cache.at).toISOString()})`)
    })
    const cmd = await ctx.command?.transform?.((ed) =>
      ed.add({
        name: "cc-update-models",
        description: "Обновить модели Claude Code в выборе модели (провайдер claude-code)",
        execute: async ({ sessionID }) => {
          const r = await refresh()
          if (r.ok) await catalog.reload()
          const cache = readModels()
          const text = modelsReport(cache ? catalogEntries(cache.models) : [], cache?.at ?? Date.now(), r.ok ? undefined : r.error)
          try {
            await (typeof ctx.session.synthetic === "function" ? ctx.session.synthetic({ sessionID, text, resume: false }) : ctx.session.prompt({ sessionID, text, resume: false }))
          } catch (e) {
            log(`report to ${sessionID}: ${e}`)
          }
        },
      }),
    )
    await ctx.command?.reload?.()
    if (stale(readModels())) void refresh().then((r) => r.ok && catalog.reload())
    log(`setup: models plugin on (cache ${readModels() ? "present" : "absent"})`)
    return async () => {
      await reg?.dispose?.()
      await cmd?.dispose?.()
    }
  },
}
