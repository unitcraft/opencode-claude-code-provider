// Notes of the provider in the window's answer: lines OpenCode shows as part of the reply, written by
// the provider itself (no model call). Used to show that Claude Code is compacting its context: that can
// take a while, and without a note the window looks stuck.
//
// Claude Code reports compaction through the SDK hooks PreCompact / PostCompact (callbacks in this
// process). A note never splits a text block the model is streaming: while one is open, notes wait for
// its end.

export const COMPACT_STARTED = (trigger) =>
  trigger === "auto" ? "⏳ Claude Code сжимает контекст (автоматически, память окна заполнилась)…" : "⏳ Claude Code сжимает контекст…"
export const COMPACT_ENDED = (seconds) => `✓ Контекст сжат за ${seconds} с.`

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

/** SDK hooks that put compaction notes into `notes` (merged with the user's own hooks). */
export function compactionHooks(notes, userHooks = {}) {
  let started = 0
  const pre = async (input) => {
    started = Date.now()
    notes.push(COMPACT_STARTED(input?.trigger))
    return { continue: true }
  }
  const post = async () => {
    notes.push(COMPACT_ENDED(Math.max(1, Math.round((Date.now() - (started || Date.now())) / 1000))))
    return { continue: true }
  }
  return {
    ...userHooks,
    PreCompact: [...(userHooks.PreCompact ?? []), { hooks: [pre] }],
    PostCompact: [...(userHooks.PostCompact ?? []), { hooks: [post] }],
  }
}
