// Every line the provider itself shows in a window, in English (default) and Russian: provider option
// `language: "en" | "ru"`. Compaction answers keep the heading "## Objective" from OpenCode's template --
// OpenCode accepts a summary only with one of its headings.

const k = (n, lang) => (lang === "ru" ? `${Math.round(n / 1000)} тыс. токенов` : `${Math.round(n / 1000)}k tokens`)
const clamp = (threshold, contextWindow) => Math.min(Math.max(threshold, 100_000), contextWindow ?? Infinity) // as Claude Code does

const en = {
  compactStarted: (trigger) => (trigger === "auto" ? "⏳ Claude Code is compacting its context (automatically: the window's memory is full)…" : "⏳ Claude Code is compacting its context…"),
  compactEnded: (s) => `✓ Context compacted in ${s} s.`,
  checkWarning: (state, prompt) =>
    `⚠ claude-code: OpenCode ${state.version} changed — ${state.problems.join("; ")}. Compaction or helper requests may spend Claude turns again. Fix: give an agent the ready prompt ${prompt} (reminder every hour until fixed).`,
  threshold: ({ model, threshold, contextWindow }) => {
    const win = contextWindow ? `${model ?? "model"} window ${k(contextWindow)}` : `${model ?? "model"}`
    return threshold
      ? `Claude Code compacts automatically at ~${k(clamp(threshold, contextWindow))} (setting autoCompactWindow; ${win}).`
      : `Claude Code compacts automatically at a limit it picks itself (${win}; set your own with the setting autoCompactWindow).`
  },
  compactDone: ({ seconds }) => `/compact: Claude Code compacted this window's memory in ${seconds} s. The model continues from its own Claude Code session.`,
  compactNothing: "/compact: nothing to compact yet — this window has no Claude Code session yet.",
  compactFailed: (why) => `/compact: Claude Code did not compact (${why}). The window continues as it was.`,
  important: "Important Context",
}

const ru = {
  compactStarted: (trigger) => (trigger === "auto" ? "⏳ Claude Code сжимает контекст (автоматически, память окна заполнилась)…" : "⏳ Claude Code сжимает контекст…"),
  compactEnded: (s) => `✓ Контекст сжат за ${s} с.`,
  checkWarning: (state, prompt) =>
    `⚠ claude-code: OpenCode ${state.version} изменился — ${state.problems.join("; ")}. Сжатие или служебные запросы могут снова тратить ходы Claude. Что делать: дать агенту готовый промпт ${prompt} (напоминание — раз в час, пока не исправлено).`,
  threshold: ({ model, threshold, contextWindow }) => {
    const win = contextWindow ? `окно модели ${model ?? ""} — ${k(contextWindow, "ru")}`.replace("  ", " ") : `модель ${model ?? ""}`.trim()
    return threshold
      ? `Claude Code сжимает память сам, когда она дорастёт до ~${k(clamp(threshold, contextWindow), "ru")} (настройка autoCompactWindow; ${win}).`
      : `Claude Code сжимает память сам у предела, который выбирает сам (${win}; свой порог — настройка autoCompactWindow).`
  },
  compactDone: ({ seconds }) => `/compact: Claude Code сжал память окна за ${seconds} с. Модель продолжает из своей сессии Claude Code.`,
  compactNothing: "/compact: сжимать пока нечего — у окна ещё нет сессии Claude Code.",
  compactFailed: (why) => `/compact: Claude Code не сжал память (${why}). Окно продолжает как было.`,
  important: "Important Context",
}

export const texts = (language) => (String(language ?? "en").toLowerCase().startsWith("ru") ? ru : en)

/** The answer to OpenCode's compaction request (what OpenCode stores and shows instead of a summary). */
export function compactionAnswer(lang, line, threshold) {
  const t = texts(lang)
  return `## Objective\n- ${line}\n\n## ${t.important}\n- ${t.threshold(threshold ?? {})}`
}
