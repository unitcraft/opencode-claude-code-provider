// OpenCode provider `claude-code`: every request is served by the OFFICIAL Claude Code
// (Claude Agent SDK, via ai-sdk-provider-claude-code), with no header spoofing.
//
// What this wrapper adds on top of the package:
//   * runs Claude Code in the directory of the OpenCode session that made the request
//     (header `x-opencode-session-id` -> OpenCode database), never in the server's cwd;
//   * Claude Code's own system prompt, settings, CLAUDE.md and hooks of that repository
//     (OpenCode's system prompt describes OpenCode tools Claude Code does not have);
//   * one Claude Code session per OpenCode session (`resume`): a turn sends only the new
//     user message, Claude Code keeps its own transcript, the prompt cache works as in CLI;
//   * images: streaming input is always on;
//   * helper requests of OpenCode (title, summary: no tools) are plain model calls, not turns;
//   * OpenCode's compaction is answered without Claude: Claude Code compacts its own session;
//   * Claude Code compacting its context is shown in the window (it can take a while);
//   * after every OpenCode update the rules above are checked against OpenCode's program; a failed
//     check notifies (Windows notification, a warning in each window once, the log);
//   * letters between OpenCode windows: OpenCode's tool list is dropped, so the opencode-peers tools
//     (peer_list, peer_send, ...) come to Claude Code as the MCP server `peers`, acting for the
//     requesting OpenCode session.
// OpenCode loads the FIRST export whose name starts with "create", so this module exports
// only the factory (the package itself exports createAPICallError first).
import { createClaudeCode as createBase } from "ai-sdk-provider-claude-code"
import os from "node:os"
import { appendFileSync } from "node:fs"
import path from "node:path"
import { noteChannel, compactionHooks } from "./notes.js"
import { watchOpenCode, openCodeVersion, CHECK_WARNING } from "./opencode-check.js"
import { sessionDirectory, loadSessionMap, saveSessionMap, resolvePeersMcp, peersMcpServer, isHelperRequest, helperSettings, isCompactionRequest, COMPACTION_SUMMARY, textResult, textStream } from "./lib.js"

const BASE_SETTINGS = {
  systemPrompt: { type: "preset", preset: "claude_code" },
  settingSources: ["user", "project", "local"],
  permissionMode: "auto",
  permissionPrompts: "none",
  streamingInput: "always",
}

const LOG = path.join(os.tmpdir(), "nova-opencode-plugins.log")
const log = (line) => {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} claude-code ${line}\n`)
  } catch {}
}

function recordRequest(file, kind, o) {
  const text = (c) => (typeof c === "string" ? c : (c ?? []).map((p) => p.text ?? `[${p.type}]`).join(""))
  const entry = {
    time: new Date().toISOString(),
    kind,
    userAgent: o.headers?.["User-Agent"],
    session: sessionIdOf(o),
    tools: (o.tools ?? []).map((t) => t.name),
    compaction: isCompactionRequest(o.prompt),
    helper: isHelperRequest(o),
    prompt: o.prompt.map((m) => ({ role: m.role, text: text(m.content).slice(0, 2000) })),
  }
  try {
    appendFileSync(file, JSON.stringify(entry) + "\n")
  } catch {}
}

function sessionIdOf(options) {
  const h = options?.headers ?? {}
  return h["x-opencode-session-id"] ?? h["x-opencode-session"] ?? h["X-Session-Id"]
}

/** Only the newest user message (resumed session: Claude Code already has the rest). */
function lastUserTurn(prompt) {
  for (let i = prompt.length - 1; i >= 0; i--) if (prompt[i].role === "user") return [prompt[i]]
  return prompt.filter((m) => m.role !== "system")
}

function claudeSessionFrom(part) {
  return part?.providerMetadata?.["claude-code"]?.sessionId
}

export function createClaudeCode(options = {}) {
  // Which Claude account: `claudeConfigDir` from the provider options in opencode config,
  // else the server's own CLAUDE_CONFIG_DIR. Passed EXPLICITLY, so the account does not
  // depend on how the OpenCode background service happened to be started.
  const configDir = options.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR
  const userSettings = {
    ...(configDir ? { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } } : {}),
    ...(options.defaultSettings ?? {}),
  }
  const sessions = loadSessionMap()
  const warned = new Set() // OpenCode sessions that saw the failed-check warning for this version
  // opencode-peers MCP server: `peersMcp` (path to its mcp.ts, false = off), default the sibling checkout.
  const peersMcp = resolvePeersMcp(options.peersMcp)
  const peersSettings = (ocSession) => {
    if (!peersMcp) return {}
    return {
      mcpServers: { ...(userSettings.mcpServers ?? {}), peers: peersMcpServer(peersMcp, ocSession, { node: options.peersNode || "node" }) },
      // Auto-allowed (no prompt can be shown). With the user's own disallowedTools the package would drop
      // them in favour of allowedTools, so then the letters fall back to permissionMode.
      ...(userSettings.disallowedTools ? {} : { allowedTools: [...(userSettings.allowedTools ?? []), "mcp__peers"] }),
    }
  }

  const model = (modelId) => {
    const call = async (kind, callOptions) => {
      const ocSession = sessionIdOf(callOptions)
      // Diagnostics, off by default: CLAUDE_CODE_PROVIDER_PROBE=<file> records what OpenCode sends (the window's
      // text included) -- for adapting to a new OpenCode (README, "When OpenCode is updated").
      if (process.env.CLAUDE_CODE_PROVIDER_PROBE) recordRequest(process.env.CLAUDE_CODE_PROVIDER_PROBE, kind, callOptions)
      // Once per OpenCode version: do the rules below still match OpenCode? (runs in the background)
      const check = watchOpenCode(openCodeVersion(callOptions.headers), { log })
      // OpenCode's compaction: Claude Code keeps and compacts its own session, so answer without a turn.
      if (isCompactionRequest(callOptions.prompt)) return kind === "generate" ? textResult(COMPACTION_SUMMARY) : textStream(COMPACTION_SUMMARY)
      // Helper request (title, summary, ...): a plain model call, never a turn of the window's session.
      if (isHelperRequest(callOptions)) {
        const helper = createBase({
          defaultSettings: { ...BASE_SETTINGS, ...userSettings, ...helperSettings(callOptions.prompt), cwd: os.tmpdir() },
        }).languageModel(modelId)
        const opts = { ...callOptions, prompt: callOptions.prompt.filter((m) => m.role !== "system"), tools: undefined, toolChoice: undefined }
        return kind === "generate" ? helper.doGenerate(opts) : helper.doStream(opts)
      }
      const cwd = ocSession ? await sessionDirectory(ocSession) : undefined
      if (!cwd) {
        throw new Error(
          `claude-code: cannot resolve the directory of OpenCode session ${ocSession ?? "(no session header)"}; ` +
            "refusing to run Claude Code in an unknown directory",
        )
      }
      const resume = sessions[ocSession]
      // Claude Code compacting its context shows in the window (it can take a while).
      const notes = noteChannel()
      if (check && !check.ok && !warned.has(`${check.version}:${ocSession}`)) {
        warned.add(`${check.version}:${ocSession}`)
        notes.push(CHECK_WARNING(check))
      }
      const hooks = compactionHooks(notes, userSettings.hooks)
      const inner = createBase({
        defaultSettings: { ...BASE_SETTINGS, ...userSettings, ...peersSettings(ocSession), hooks, cwd, ...(resume ? { resume } : {}) },
      }).languageModel(modelId)
      const prompt = resume ? lastUserTurn(callOptions.prompt) : callOptions.prompt.filter((m) => m.role !== "system")
      const opts = { ...callOptions, prompt, tools: undefined, toolChoice: undefined }

      const remember = (id) => {
        if (id && sessions[ocSession] !== id) {
          sessions[ocSession] = id
          saveSessionMap(sessions)
        }
      }
      if (kind === "generate") {
        const r = await inner.doGenerate(opts)
        remember(claudeSessionFrom(r))
        const shown = notes.take().map((text) => ({ type: "text", text: `_${text}_\n\n` }))
        return shown.length ? { ...r, content: [...shown, ...r.content] } : r
      }
      const r = await inner.doStream(opts)
      const stream = r.stream.pipeThrough(
        new TransformStream({
          start(ctl) {
            notes.attach(ctl)
          },
          transform(part, ctl) {
            if (part.type === "finish") {
              remember(claudeSessionFrom(part))
              notes.drain() // anything still waiting goes out before the end
            }
            notes.pass(part)
          },
        }),
      )
      return { ...r, stream }
    }
    const probe = createBase({ defaultSettings: BASE_SETTINGS }).languageModel(modelId)
    return {
      specificationVersion: probe.specificationVersion,
      provider: "claude-code",
      modelId,
      supportedUrls: probe.supportedUrls ?? {},
      doGenerate: (o) => call("generate", o),
      doStream: (o) => call("stream", o),
    }
  }

  const provider = (modelId) => model(modelId)
  provider.languageModel = model
  provider.chat = model
  return provider
}
