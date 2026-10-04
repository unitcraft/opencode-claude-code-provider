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
//   * OpenCode's /compact runs Claude Code's own /compact in the window's session (OpenCode's
//     summary of a history Claude Code does not read would only cost a turn);
//   * Claude Code compacting its context is shown in the window (it can take a while);
//   * after every OpenCode update the rules above are checked against OpenCode's program; a failed
//     check notifies (Windows notification, a warning in each window once, the log);
//   * settings in three layers: built-in defaults, the provider options, the project's
//     .opencode/opencode-claude-code-provider.json (settings.js);
//   * `/cc-tools` typed in a window lists every Claude Code tool there and whether it is on (no model call);
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
import { texts, compactionAnswer } from "./texts.js"
import { settingsFor, toolSources } from "./settings.js"
import { isToolsCommand, listClaudeTools, contextUsage, toolsReport } from "./tools-report.js"
import { watchOpenCode, openCodeVersion, installedOpenCodeVersion, readCheckState, toast, CHECK_WARNING } from "./opencode-check.js"
import { sessionDirectory, loadSessionMap, saveSessionMap, resolvePeersMcp, peersMcpServer, isHelperRequest, helperSettings, isCompactionRequest, autoCompactWindowFor, disabledTools, rawUserTurn, textResult, textStream } from "./lib.js"

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
  const warned = new Set() // `version:session:hour` -- a failed check is repeated in each window once an hour
  const contextWindows = new Map() // OpenCode session -> the model's window Claude Code reported last
  const modelNames = new Map() // OpenCode session -> the real model Claude Code ran (claude-haiku-4-5-...)
  // The OpenCode check runs at load too (no request needed) and reminds every hour while it fails.
  const hour = () => Math.floor(Date.now() / 3_600_000)
  if (options.watchOpenCode !== false) startWatch()
  function startWatch() {
  watchOpenCode(installedOpenCodeVersion(), { log })
  setInterval(() => {
    const version = installedOpenCodeVersion()
    const state = watchOpenCode(version, { log })
    if (state && !state.ok) {
      log(`opencode ${state.version}: still failing: ${state.problems.join("; ")}`)
      toast(`claude-code: OpenCode ${state.version} changed`, state.problems.join("; "))
    }
  }, 3_600_000).unref?.()
  }
  // Claude Code's own settings per request: the auto-compaction threshold of this model and the
  // built-in tools switched off (both from the provider options).
  const claudeSettings = (modelId, cfg) => {
    const threshold = autoCompactWindowFor(cfg.autoCompactWindow, modelId)
    // `tools: { "Artifact": false, ... }` -- a tool set to false is removed from Claude Code's context
    const disabled = disabledTools(cfg.tools, userSettings.disallowedTools)
    return {
      ...(threshold ? { env: { ...(userSettings.env ?? process.env), CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(threshold) } } : {}),
      ...(disabled.length ? { disallowedTools: disabled } : {}),
    }
  }
  // opencode-peers MCP server: `peersMcp` (path to its mcp.ts, false = off), default the sibling checkout.
  const peersMcp = resolvePeersMcp(options.peersMcp)
  const peersSettings = (ocSession) => {
    if (!peersMcp) return {}
    return {
      mcpServers: { ...(userSettings.mcpServers ?? {}), peers: peersMcpServer(peersMcp, ocSession, { node: options.peersNode || "node" }) },
      // Auto-allowed (no prompt can be shown). The package passes allowedTools and disallowedTools both
      // (its warning that only allowedTools is used is not what its code does).
      allowedTools: [...(userSettings.allowedTools ?? []), "mcp__peers"],
    }
  }

  const model = (modelId) => {
    // OpenCode's /compact (auto or manual): Claude Code's own /compact in the window's Claude Code session --
    // it really shrinks what Claude reads every turn. OpenCode gets a short answer in its template instead of
    // a summary (it keeps that as its own history, which Claude Code does not read).
    const compact = async (kind, callOptions, ocSession) => {
      const cwd = ocSession ? await sessionDirectory(ocSession) : undefined
      const cfg = settingsFor(options, cwd, log)
      const t = texts(cfg.language)
      const limits = { model: modelNames.get(ocSession) ?? modelId, threshold: autoCompactWindowFor(cfg.autoCompactWindow, modelId), contextWindow: contextWindows.get(ocSession) }
      const answer = (line) => (kind === "generate" ? textResult : textStream)(compactionAnswer(cfg.language, line, limits))
      const resume = ocSession ? sessions[ocSession] : undefined
      if (!resume) return answer(t.compactNothing)
      if (!cwd) return answer(t.compactFailed("unknown directory"))
      let compacted = false
      const hooks = { ...(userSettings.hooks ?? {}), PostCompact: [...(userSettings.hooks?.PostCompact ?? []), { hooks: [async () => ((compacted = true), { continue: true })] }] }
      const started = Date.now()
      try {
        const inner = createBase({
          defaultSettings: { ...BASE_SETTINGS, ...userSettings, ...claudeSettings(modelId, cfg), ...peersSettings(ocSession), hooks, cwd, resume },
        }).languageModel(modelId)
        // raw "/compact" (a system-role message goes in without the package's "Human: " prefix)
        await inner.doGenerate({ ...callOptions, prompt: [{ role: "system", content: "/compact" }], tools: undefined, toolChoice: undefined })
      } catch (e) {
        log(`compact failed ${ocSession}: ${e}`)
        return answer(t.compactFailed(String(e?.message ?? e).slice(0, 200)))
      }
      const seconds = Math.max(1, Math.round((Date.now() - started) / 1000))
      log(`compact ${ocSession}: ${compacted ? "done" : "no compaction event"} in ${seconds} s`)
      return answer(compacted ? t.compactDone({ seconds }) : t.compactFailed("Claude Code reported no compaction"))
    }

    // `/cc-tools`: Claude Code's tools in this window and their status, without a model call.
    const toolsCommand = async (kind, callOptions, ocSession) => {
      const cwd = ocSession ? await sessionDirectory(ocSession) : undefined
      const cfg = settingsFor(options, cwd, log)
      const sdk = (disallowedTools) => {
        const c = claudeSettings(modelId, cfg)
        const peers = peersSettings(ocSession)
        return {
          model: modelId,
          systemPrompt: BASE_SETTINGS.systemPrompt,
          settingSources: userSettings.settingSources ?? BASE_SETTINGS.settingSources,
          permissionMode: BASE_SETTINGS.permissionMode,
          cwd: cwd ?? os.tmpdir(),
          env: c.env ?? userSettings.env ?? process.env,
          ...(peers.mcpServers ? { mcpServers: peers.mcpServers } : {}),
          ...(disallowedTools.length ? { disallowedTools } : {}),
        }
      }
      let text
      try {
        const own = userSettings.disallowedTools ?? []
        const [all, usage] = await Promise.all([listClaudeTools(sdk(own)), contextUsage(sdk(disabledTools(cfg.tools, own))).catch(() => undefined)])
        text = toolsReport({ all, sources: toolSources(options, cwd), usage, language: cfg.language, alsoDisallowed: own })
      } catch (e) {
        log(`cc-tools failed ${ocSession}: ${e}`)
        text = `/cc-tools: ${String(e?.message ?? e).slice(0, 300)}`
      }
      return kind === "generate" ? textResult(text) : textStream(text)
    }

    const call = async (kind, callOptions) => {
      const ocSession = sessionIdOf(callOptions)
      // Diagnostics, off by default: CLAUDE_CODE_PROVIDER_PROBE=<file> records what OpenCode sends (the window's
      // text included) -- for adapting to a new OpenCode (README, "When OpenCode is updated").
      if (process.env.CLAUDE_CODE_PROVIDER_PROBE) recordRequest(process.env.CLAUDE_CODE_PROVIDER_PROBE, kind, callOptions)
      // Once per OpenCode version: do the rules below still match OpenCode? (runs in the background)
      const check = options.watchOpenCode === false ? undefined : (watchOpenCode(openCodeVersion(callOptions.headers), { log }) ?? readCheckState())
      // OpenCode's compaction: Claude Code's own /compact in the window's session instead.
      if (isCompactionRequest(callOptions.prompt)) return compact(kind, callOptions, ocSession)
      if (isToolsCommand(callOptions.prompt)) return toolsCommand(kind, callOptions, ocSession)
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
      const cfg = settingsFor(options, cwd, log) // defaults < provider options < the project's file
      // Claude Code compacting its context shows in the window (it can take a while).
      const notes = noteChannel()
      if (check && !check.ok && !warned.has(`${check.version}:${ocSession}:${hour()}`)) {
        warned.add(`${check.version}:${ocSession}:${hour()}`)
        notes.push(CHECK_WARNING(check, cfg.language))
      }
      const hooks = compactionHooks(notes, userSettings.hooks, cfg.language)
      const inner = createBase({
        defaultSettings: { ...BASE_SETTINGS, ...userSettings, ...claudeSettings(modelId, cfg), ...peersSettings(ocSession), hooks, cwd, ...(resume ? { resume } : {}) },
      }).languageModel(modelId)
      // The user's text goes to Claude Code as typed (no "Human: " prefix of the package).
      const prompt = rawUserTurn(resume ? lastUserTurn(callOptions.prompt) : callOptions.prompt.filter((m) => m.role !== "system"))
      const opts = { ...callOptions, prompt, tools: undefined, toolChoice: undefined }

      const noteWindow = (meta) => {
        const [real, u] = Object.entries(meta?.["claude-code"]?.modelUsage ?? {}).find(([, u]) => u?.contextWindow) ?? []
        if (u) contextWindows.set(ocSession, u.contextWindow)
        if (real) modelNames.set(ocSession, real)
      }
      const remember = (id) => {
        if (id && sessions[ocSession] !== id) {
          sessions[ocSession] = id
          saveSessionMap(sessions)
        }
      }
      if (kind === "generate") {
        const r = await inner.doGenerate(opts)
        remember(claudeSessionFrom(r))
        noteWindow(r.providerMetadata)
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
              noteWindow(part.providerMetadata)
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
