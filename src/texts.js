// Every line the provider itself shows in a window, in English (default) and Russian: provider option
// `language: "en" | "ru"`. Compaction answers keep the heading "## Objective" from OpenCode's template --
// OpenCode accepts a summary only with one of its headings.

const k = (n, lang) => (lang === "ru" ? `${Math.round(n / 1000)} тыс. токенов` : `${Math.round(n / 1000)}k tokens`)
const clamp = (threshold, contextWindow) => Math.min(Math.max(threshold, 100_000), contextWindow ?? Infinity) // as Claude Code does

const en = {
  compactStarted: (trigger) => (trigger === "auto" ? "⏳ Claude Code is compacting its context (automatically: the window's memory is full)…" : "⏳ Claude Code is compacting its context…"),
  compactEnded: (s, pre, post) => `✓ Context compacted in ${s} s${pre && post ? ` (${k(pre)} → ${k(post)})` : ""}.`,
  compactFailedNote: (why) => `✗ Claude Code could not compact its context: ${why}`,
  checkWarning: (state, prompt) =>
    `⚠ claude-code: OpenCode ${state.version} changed — ${state.problems.join("; ")}. Compaction or helper requests may spend Claude turns again. Fix: give an agent the ready prompt ${prompt} (reminder every hour until fixed).`,
  threshold: ({ model, threshold, contextWindow }) => {
    const win = contextWindow ? `${model ?? "model"} window ${k(contextWindow)}` : `${model ?? "model"}`
    return threshold
      ? `Claude Code compacts automatically at ~${k(clamp(threshold, contextWindow))} (setting autoCompactWindow; ${win}).`
      : `Claude Code compacts automatically at a limit it picks itself (${win}; set your own with the setting autoCompactWindow).`
  },
  compactDone: ({ seconds, pre, post }) => `/compact: Claude Code compacted this window's memory in ${seconds} s${pre && post ? `: ${k(pre)} → ${k(post)}` : ""}. The model continues from its own Claude Code session.`,
  compactNothing: "/compact: nothing to compact yet — this window has no Claude Code session yet.",
  backgroundStopped: (list) => `Background tasks stopped with the end of this turn: ${list}. They do not outlive a turn in this window; to wait for something long use crew_watch.`,
  compactFailed: (why) => `/compact: Claude Code did not compact (${why}). The window continues as it was.`,
  important: "Important Context",
  on: "on", off: "off", notOffered: "not offered here",
  layer: { default: "provider default", machine: "opencode.jsonc", project: "project file", claude: "Claude Code" },
  toolsTitle: "Claude Code tools in this window",
  toolsSummary: (on, off, file) => `${on} on, ${off} off. Project file: ${file ?? "none"}.`,
  tool: "Tool", status: "Status", decidedBy: "Decided by",
  skillsTitle: "Claude Code skills in this window", skill: "Skill", onOff: (on, off) => `${on} on, ${off} off.`,
  contextNow: "Context now (estimate)", total: "total",
  toolsHow: 'Change: "tools" / "skills": { "Name": false } (off) or true (on) -- in the provider settings of opencode.jsonc (whole machine) or in .opencode/opencode-claude-code-provider.json of the project. Every change of the tool set rewrites the prompt cache once.',
}

const ru = {
  compactStarted: (trigger) => (trigger === "auto" ? "⏳ Claude Code сжимает контекст (автоматически, память окна заполнилась)…" : "⏳ Claude Code сжимает контекст…"),
  compactEnded: (s, pre, post) => `✓ Контекст сжат за ${s} с${pre && post ? ` (${k(pre, "ru")} → ${k(post, "ru")})` : ""}.`,
  compactFailedNote: (why) => `✗ Claude Code не смог сжать контекст: ${why}`,
  checkWarning: (state, prompt) =>
    `⚠ claude-code: OpenCode ${state.version} изменился — ${state.problems.join("; ")}. Сжатие или служебные запросы могут снова тратить ходы Claude. Что делать: дать агенту готовый промпт ${prompt} (напоминание — раз в час, пока не исправлено).`,
  threshold: ({ model, threshold, contextWindow }) => {
    const win = contextWindow ? `окно модели ${model ?? ""} — ${k(contextWindow, "ru")}`.replace("  ", " ") : `модель ${model ?? ""}`.trim()
    return threshold
      ? `Claude Code сжимает память сам, когда она дорастёт до ~${k(clamp(threshold, contextWindow), "ru")} (настройка autoCompactWindow; ${win}).`
      : `Claude Code сжимает память сам у предела, который выбирает сам (${win}; свой порог — настройка autoCompactWindow).`
  },
  compactDone: ({ seconds, pre, post }) => `/compact: Claude Code сжал память окна за ${seconds} с${pre && post ? `: ${k(pre, "ru")} → ${k(post, "ru")}` : ""}. Модель продолжает из своей сессии Claude Code.`,
  compactNothing: "/compact: сжимать пока нечего — у окна ещё нет сессии Claude Code.",
  backgroundStopped: (list) => `Фоновые задачи остановлены с концом хода: ${list}. В этом окне они не переживают ход; долгое ожидание — crew_watch.`,
  compactFailed: (why) => `/compact: Claude Code не сжал память (${why}). Окно продолжает как было.`,
  important: "Important Context",
  on: "вкл", off: "выкл", notOffered: "здесь не предлагается",
  layer: { default: "умолчание провайдера", machine: "opencode.jsonc", project: "файл проекта", claude: "Claude Code" },
  toolsTitle: "Инструменты Claude Code в этом окне",
  toolsSummary: (on, off, file) => `Включено ${on}, выключено ${off}. Файл проекта: ${file ?? "нет"}.`,
  tool: "Инструмент", status: "Статус", decidedBy: "Кто решил",
  skillsTitle: "Навыки Claude Code в этом окне", skill: "Навык", onOff: (on, off) => `Включено ${on}, выключено ${off}.`,
  contextNow: "Контекст сейчас (оценка)", total: "всего",
  toolsHow: 'Изменить: "tools" / "skills": { "Имя": false } (выкл) или true (вкл) — в настройках провайдера в opencode.jsonc (вся машина) или в .opencode/opencode-claude-code-provider.json проекта. Каждая смена набора инструментов один раз заново записывает кэш промпта.',
}

export const texts = (language) => (String(language ?? "en").toLowerCase().startsWith("ru") ? ru : en)

/** The answer to OpenCode's compaction request (what OpenCode stores and shows instead of a summary). */
export function compactionAnswer(lang, line, threshold) {
  const t = texts(lang)
  return `## Objective\n- ${line}\n\n## ${t.important}\n- ${t.threshold(threshold ?? {})}`
}
