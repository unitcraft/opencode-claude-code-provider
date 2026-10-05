// Claude Code's process for a window's turn (plan 002): spawned like the Agent SDK does it, with one kind of output
// line dropped -- the empty result of a notification-only turn.
//
// Measured 2026-10-05 (Claude Code 2.1.283): a turn ends while a background task (Bash run_in_background, Monitor)
// is still running; the process exits and the task is killed. The next turn resumes the session, and before the
// window's message Claude Code reports the dead task -- task_notification "stopped" -- and closes a turn of its own
// with no model call: result, num_turns 0. The package ends the window's turn on the first result, so the window got
// an empty answer while Claude Code went on with the message and was cut off mid-work. Dropping that one result lets
// the turn run to its real end; the notification itself reaches the model (it learns the task was stopped).

import { spawn } from "node:child_process"
import { Transform } from "node:stream"
import { StringDecoder } from "node:string_decoder"

/** A per-process judge of output lines: false for the result of a turn that was only task notifications. */
export function notificationTurnFilter(log = () => {}) {
  let notified = false
  let answered = false
  return (line) => {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return true
    }
    if (m?.type === "assistant") answered = true
    else if (m?.type === "system" && m.subtype === "task_notification") notified = true
    else if (m?.type === "result") {
      const drop = notified && !answered && !m.num_turns
      notified = answered = false
      if (drop) {
        log(`dropped the empty result of a task-notification turn (session ${m.session_id})`)
        return false
      }
    }
    return true
  }
}

/** Newline-delimited output through keep(line); partial lines and split UTF-8 characters are carried over. */
export function lineFilter(keep) {
  const decoder = new StringDecoder("utf8")
  let rest = ""
  const pass = (line) => !line.trim() || keep(line)
  return new Transform({
    transform(chunk, _enc, done) {
      const lines = (rest + decoder.write(chunk)).split("\n")
      rest = lines.pop()
      done(null, lines.filter(pass).map((l) => `${l}\n`).join(""))
    },
    flush(done) {
      const last = rest + decoder.end()
      done(null, last && pass(last) ? last : "")
    },
  })
}

/** spawnClaudeCodeProcess of the Agent SDK: the SDK's own local spawn, stdout filtered. */
export function spawnClaudeCode({ command, args, cwd, env, signal }, log = () => {}) {
  const child = spawn(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  const stdout = child.stdout.pipe(lineFilter(notificationTurnFilter(log)))
  let tail = ""
  child.stderr.on("data", (d) => {
    tail = (tail + d).slice(-2000)
  })
  child.once("exit", (code) => {
    if (code) log(`Claude Code exited ${code}: ${tail.trim().slice(-500)}`)
  })
  return {
    stdin: child.stdin,
    stdout,
    get killed() {
      return child.killed
    },
    get exitCode() {
      return child.exitCode
    },
    get signalCode() {
      return child.signalCode
    },
    kill: (s) => child.kill(s),
    on: (e, f) => (child.on(e, f), undefined),
    once: (e, f) => (child.once(e, f), undefined),
    off: (e, f) => (child.off(e, f), undefined),
  }
}
