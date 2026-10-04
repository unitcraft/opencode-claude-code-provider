// Notes of the provider in the window's answer: lines OpenCode shows as part of the reply, written by
// the provider itself (no model call). Used to show that Claude Code is compacting its context: that can
// take a while, and without a note the window looks stuck.
//
// Claude Code reports compaction through the SDK hooks PreCompact / PostCompact (callbacks in this
// process). A note never splits a text block the model is streaming: while one is open, notes wait for
// its end.

import { texts } from "./texts.js"

export function noteChannel() {
  let ctl
  let seq = 0
  const open = new Set() // text blocks of the model now streaming
  const queue = []
  const emit = (text) => {
    const id = `provider-note-${seq++}`
    ctl.enqueue({ type: "text-start", id })
    ctl.enqueue({ type: "text-delta", id, delta: `\n\n_${text}_\n\n` })
    ctl.enqueue({ type: "text-end", id })
  }
  const flush = () => {
    if (!ctl || open.size) return
    while (queue.length) emit(queue.shift())
  }
  return {
    /** A note to show; before the stream is attached it waits (doGenerate reads them with take()). */
    push(text) {
      queue.push(text)
      flush()
    },
    /** Attach to the output stream's controller. */
    attach(controller) {
      ctl = controller
      flush()
    },
    /** Pass a model part through, keeping track of open text blocks. */
    pass(part) {
      if (part.type === "text-start") open.add(part.id)
      ctl.enqueue(part)
      if (part.type === "text-end") {
        open.delete(part.id)
        flush()
      }
    },
    /** Before the stream's finish: show whatever still waits. */
    drain() {
      while (ctl && queue.length) emit(queue.shift())
    },
    /** Notes not shown yet (doGenerate). */
    take() {
      return queue.splice(0)
    },
  }
}

/**
 * Claude Code's compaction in the window: the hook PreCompact shows the start, the SDK message
 * `compact_boundary` the end with the numbers (pre/post tokens, duration; measured order: status compacting
 * -> PreCompact -> PostCompact -> status done -> compact_boundary). A failed compaction (status with
 * compact_result "failed") shows the error. If the boundary never comes, finish() shows a plain end line.
 * Returns { hooks, onSdkMessage, finish } -- the user's own hooks and onSdkMessage keep working.
 */
export function compactionWatch(notes, { userHooks = {}, userOnSdkMessage, language = "en", onBoundary } = {}) {
  const t = texts(language)
  let started = 0
  let pending = false
  const seconds = (ms) => Math.max(1, Math.round(ms / 1000))
  const pre = async (input) => {
    started = Date.now()
    pending = true
    notes.push(t.compactStarted(input?.trigger))
    return { continue: true }
  }
  const onSdkMessage = (m) => {
    try {
      if (m?.type === "system" && m.subtype === "compact_boundary") {
        const meta = m.compact_metadata ?? {}
        pending = false
        onBoundary?.(meta)
        notes.push(t.compactEnded(seconds(meta.duration_ms ?? Date.now() - (started || Date.now())), meta.pre_tokens, meta.post_tokens))
      } else if (m?.type === "system" && m.subtype === "status" && m.compact_result === "failed") {
        pending = false
        notes.push(t.compactFailedNote(m.compact_error ?? "?"))
      }
    } finally {
      userOnSdkMessage?.(m)
    }
  }
  return {
    hooks: { ...userHooks, PreCompact: [...(userHooks.PreCompact ?? []), { hooks: [pre] }] },
    onSdkMessage,
    finish() {
      if (pending) notes.push(t.compactEnded(seconds(Date.now() - started)))
      pending = false
    },
  }
}
