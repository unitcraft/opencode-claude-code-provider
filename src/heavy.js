// ТЯЖЁЛЫЕ КОМАНДЫ — ТОЛЬКО ЧЕРЕЗ ОЧЕРЕДЬ МАШИНЫ (2026-10-07). Гейт, запущенный вкладкой в собственном Bash, плагин
// писем (crew_watch) не видит: очередь машины (machine_slots) соблюдалась на честном слове, и два-три
// гейта разом валили сервер OpenCode. Провайдер видит каждый вызов Bash до выполнения (хук PreToolUse): команда из
// списка проекта heavy_commands не выполняется, агент получает подсказку поставить её в очередь. Список — тот же, что
// у плагина: поле heavy_commands закоммиченного файла настроек проекта; выключить — heavy_block: "off" там же.
import { execFile } from "node:child_process"

const SETTINGS_FILES = [".opencode/crew-harness.json", ".opencode/opencode-peers.json"]
const TTL_MS = 5 * 60_000
const cache = new Map()

const git = (cwd, args) =>
  new Promise((res) => execFile("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 10_000 }, (e, out) => res(e ? undefined : String(out))))

/** heavy_commands проекта каталога cwd (из закоммиченного файла настроек ветки по умолчанию) или []. Кэш 5 мин. */
export async function heavyCommandsFor(cwd, now = Date.now()) {
  if (!cwd) return []
  const hit = cache.get(cwd)
  if (hit && now - hit.at < TTL_MS) return hit.list
  let list = []
  const top = (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim()
  if (top) {
    const head = (await git(top, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.trim()
    const branch = head ? head.replace(/^[^/]+\//, "") : "main"
    for (const f of SETTINGS_FILES) {
      const text = await git(top, ["show", `${branch}:${f}`])
      if (!text) continue
      try {
        const j = JSON.parse(text)
        if (j.heavy_block !== "off" && Array.isArray(j.heavy_commands)) list = j.heavy_commands.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
      } catch {}
      break
    }
  }
  cache.set(cwd, { at: now, list })
  return list
}

const WRAPPERS = new Set(["bash", "sh", "env", "timeout", "nohup", "time", "nice", "exec", "command", "python", "python3", "py", "node", "pwsh", "powershell"])
const base = (t) => t.replace(/^["']|["']$/g, "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "")
/** Слова команды без кавычек вокруг (грубо, но довольно для узнавания запуска). */
const words = (s) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ""))

/**
 * Запускает ли команда тяжёлый прогон из списка. Узнаётся ЗАПУСК, а не упоминание: команда делится на части по
 * && || ; | и переводам строк, у каждой части отбрасываются присваивания VAR=..., cd, обёртки (bash, timeout N, env, …),
 * и первое слово (имя без пути и .exe) сравнивается с записью списка: «gate.sh» — имя скрипта кончается на него
 * (t26-gates.sh ловится записью gates.sh), «cargo build» — программа и следующие слова. grep gate.sh, cat gate.sh — не запуск.
 */
export function heavyIn(command, list) {
  if (!command || !list?.length) return undefined
  for (const part of String(command).split(/&&|\|\||;|\||\n/)) {
    const w = words(part.trim())
    let i = 0
    for (;;) {
      if (i >= w.length) break
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++
      else if (w[i] === "cd") i += 2
      else if (WRAPPERS.has(base(w[i]))) {
        i++
        while (i < w.length && /^-/.test(w[i])) i++ // ключи обёртки (bash -c, timeout -k 5)
        if (i < w.length && /^\d+[smh]?$/.test(w[i])) i++ // timeout 600
      } else break
    }
    if (i >= w.length) continue
    // bash -c "…" — внутренняя команда проверяется так же
    if (i > 0 && base(w[i - 1]) === "-c") {
      const inner = heavyIn(w[i], list)
      if (inner) return inner
    }
    const prog = base(w[i])
    for (const entry of list) {
      const e = words(entry)
      if (!e.length) continue
      const first = base(e[0])
      const hitProg = prog === first || prog.endsWith(first) || prog.replace(/\.(sh|py|ps1|mjs|js)$/, "") === first
      if (!hitProg) continue
      if (e.slice(1).every((x, k) => (w[i + 1 + k] ?? "").toLowerCase() === x.toLowerCase())) return entry
    }
  }
  return undefined
}

/** Хук PreToolUse: тяжёлую команду Bash — не выполнять, подсказать очередь машины. */
export function heavyGuard(list, language = "en") {
  return async (input) => {
    if (input?.tool_name !== "Bash") return { continue: true }
    const command = String(input?.tool_input?.command ?? "")
    const hit = heavyIn(command, list)
    if (!hit) return { continue: true }
    const reason =
      language === "ru"
        ? `Тяжёлый прогон («${hit}» из heavy_commands проекта) запускается только через очередь машины, не в Bash вкладки: crew_watch {command: ${JSON.stringify(command)}, machine: true} — плагин запустит его, когда освободится место (machine_slots), и разбудит тебя с результатом. Закончи ход.`
        : `A heavy run ("${hit}" from the project's heavy_commands) goes only through the machine queue, not the tab's Bash: crew_watch {command: ${JSON.stringify(command)}, machine: true} -- the plugin runs it when a slot is free (machine_slots) and wakes you with the result. End the turn.`
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
  }
}

/** Хуки хода с проверкой тяжёлых команд (список пуст — хуки без изменений). */
export const withHeavyGuard = (hooks, list, language) => (list?.length ? { ...hooks, PreToolUse: [...(hooks?.PreToolUse ?? []), { matcher: "Bash", hooks: [heavyGuard(list, language)] }] } : hooks)
