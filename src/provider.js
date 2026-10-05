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
//   * `/cc-tools` typed in a window lists every Claude Code tool and skill there and whether it is on (no model call);
//   * skills switched off are left out of the session (Claude Code takes an allowlist: the provider learns the
//     full list once per directory from an interrupted turn, 0 tokens);
//   * timeStamp: the provider stamps HH:MM before each answer text and tells the model not to write the time;
//   * letters between OpenCode windows: OpenCode's tool list is dropped, so the opencode-peers tools
//     (peer_list, peer_send, ...) come to Claude Code as the MCP server `peers`, acting for the
//     requesting OpenCode session.
// OpenCode loads the FIRST export whose name starts with "create", so this module exports
// only the factory (the package itself exports createAPICallError first).
import { createClaudeCode as createBase } from "ai-sdk-provider-claude-code"
import os from "node:os"
import { appendFileSync } from "node:fs"
import path from "node:path"
import { noteChannel, compactionWatch } from "./notes.js"
import { texts, compactionAnswer } from "./texts.js"
import { DEFAULTS, explicitSettingsFor, settingsFor, toolSources, switchSources } from "./settings.js"
import { opencodeWindow } from "./opencode-window.js"
import { spawnClaudeCode } from "./spawn.js"
import { isToolsCommand, discoverClaude, contextUsage, toolsReport } from "./tools-report.js"
import { watchOpenCode, openCodeVersion, installedOpenCodeVersion, readCheckState, toast, CHECK_WARNING } from "./opencode-check.js"
import { accountKey, resumeFor, sessionDirectory, loadSessionMap, saveSessionMap, resolvePeersMcp, peersMcpServer, isHelperRequest, helperSettings, isCompactionRequest, autoCompactWindowFor, disabledTools, enabledSkills, TIME_HINT, backgroundHint, backgroundWatch, timeStamper, hhmm, rawUserTurn, newUserTurn, lastCallUsage, shortenToolInput, mainModelUsage, textResult, textStream } from "./lib.js"

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
  const skillLists = new Map() // directory -> every skill Claude Code discovers there
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
  // The auto-compaction threshold of this model for a tab in cwd (plan 001, decision 4): an explicit
  // autoCompactWindow (provider options, the project's file) wins; else OpenCode's own window for the model
  // (limit.context - compaction.reserved from OpenCode's config: one source, both compact at the same point);
  // else the provider's default.
  const thresholdFor = (modelId, cwd) =>
    autoCompactWindowFor(explicitSettingsFor(options, cwd).autoCompactWindow, modelId) ??
    opencodeWindow(cwd, modelId).threshold ??
    autoCompactWindowFor(DEFAULTS.autoCompactWindow, modelId)
  // Claude Code's own settings per request: the auto-compaction threshold of this model and the
  // built-in tools switched off (both from the provider options).
  // Claude Code's process of a window's turn: the empty result of a task-notification turn dropped (src/spawn.js)
  const spawnFiltered = (o) => spawnClaudeCode(o, log)
  const claudeSettings = (modelId, cfg, cwd) => {
    const threshold = thresholdFor(modelId, cwd)
    // the window's Claude account: claudeConfigDir of the project's file, else of opencode.jsonc (plan 001, Ph.2)
    const account = cfg.claudeConfigDir || configDir
    // `tools: { "Artifact": false, ... }` -- a tool set to false is removed from Claude Code's context
    const disabled = disabledTools(cfg.tools, userSettings.disallowedTools)
    return {
      env: { ...(userSettings.env ?? process.env), ...(account ? { CLAUDE_CONFIG_DIR: account } : {}), ...(threshold ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(threshold) } : {}) },
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
      const limits = { model: modelNames.get(ocSession) ?? modelId, threshold: thresholdFor(modelId, cwd), contextWindow: contextWindows.get(ocSession) }
      const answer = (line) => (kind === "generate" ? textResult : textStream)(compactionAnswer(cfg.language, line, limits))
      const resume = resumeFor(sessions, ocSession, cfg.claudeConfigDir || configDir)
      if (!resume) return answer(t.compactNothing)
      if (!cwd) return answer(t.compactFailed("unknown directory"))
      // the end of Claude Code's compaction and its numbers come as the SDK message compact_boundary
      let boundary
      const onSdkMessage = (m) => {
        if (m?.type === "system" && m.subtype === "compact_boundary") boundary = m.compact_metadata ?? {}
        userSettings.onSdkMessage?.(m)
      }
      const started = Date.now()
      try {
        const inner = createBase({
          defaultSettings: { ...BASE_SETTINGS, ...userSettings, ...claudeSettings(modelId, cfg, cwd), ...peersSettings(ocSession), onSdkMessage, cwd, resume, spawnClaudeCodeProcess: spawnFiltered },
        }).languageModel(modelId)
        // raw "/compact" (a system-role message goes in without the package's "Human: " prefix)
        await inner.doGenerate({ ...callOptions, prompt: [{ role: "system", content: "/compact" }], tools: undefined, toolChoice: undefined })
      } catch (e) {
        log(`compact failed ${ocSession}: ${e}`)
        return answer(t.compactFailed(String(e?.message ?? e).slice(0, 200)))
      }
      const seconds = Math.max(1, Math.round((boundary?.duration_ms ?? Date.now() - started) / 1000))
      log(`compact ${ocSession}: ${boundary ? `done ${boundary.pre_tokens} -> ${boundary.post_tokens}` : "no compaction event"} in ${seconds} s`)
      return answer(boundary ? t.compactDone({ seconds, pre: boundary.pre_tokens, post: boundary.post_tokens }) : t.compactFailed("Claude Code reported no compaction"))
    }

    // Agent SDK options of a window for the interrupted discovery turn and the context estimate.
    const sdkOptions = (cfg, ocSession, cwd, disallowedTools) => {
      const c = claudeSettings(modelId, cfg, cwd)
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
    // The skills to load in a window: only needed when a skill is switched off. The full list (Claude Code
    // takes an allowlist) is learned once per directory; /cc-tools refreshes it.
    const skillsFor = async (cfg, ocSession, cwd) => {
      if (!Object.values(cfg.skills ?? {}).some((on) => on === false)) return undefined
      if (!skillLists.has(cwd)) {
        try {
          skillLists.set(cwd, (await discoverClaude(sdkOptions(cfg, ocSession, cwd, userSettings.disallowedTools ?? []))).skills)
        } catch (e) {
          log(`skills discovery failed ${cwd}: ${e}`)
          return undefined // all skills rather than none
        }
      }
      return enabledSkills(skillLists.get(cwd), cfg.skills)
    }

    // `/cc-tools`: Claude Code's tools and skills in this window and their status, without a model call.
    const toolsCommand = async (kind, callOptions, ocSession) => {
      const cwd = ocSession ? await sessionDirectory(ocSession) : undefined
      const cfg = settingsFor(options, cwd, log)
      const sdk = (disallowedTools) => sdkOptions(cfg, ocSession, cwd, disallowedTools)
      let text
      try {
        const own = userSettings.disallowedTools ?? []
        const [found, usage] = await Promise.all([discoverClaude(sdk(own)), contextUsage(sdk(disabledTools(cfg.tools, own))).catch(() => undefined)])
        if (cwd && found.skills.length) skillLists.set(cwd, found.skills)
        text = toolsReport({ all: found.tools, sources: toolSources(options, cwd), usage, language: cfg.language, alsoDisallowed: own, skills: { all: found.skills, sources: switchSources("skills", options, cwd) } })
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
      const cfg = settingsFor(options, cwd, log) // defaults < provider options < the project's file
      const account = cfg.claudeConfigDir || configDir
      const resume = resumeFor(sessions, ocSession, account) // a session of another account starts anew
      // Claude Code compacting its context shows in the window (it can take a while).
      const notes = noteChannel()
      if (check && !check.ok && !warned.has(`${check.version}:${ocSession}:${hour()}`)) {
        warned.add(`${check.version}:${ocSession}:${hour()}`)
        notes.push(CHECK_WARNING(check, cfg.language))
      }
      // the context size is the input of the turn's last model call, not the sum over its calls (lib.js)
      const usage = lastCallUsage()
      const background = backgroundWatch() // tasks alive at the end of the turn die with it (plan 002)
      const onSdk = (m) => {
        background.onSdkMessage(m)
        // Diagnostics, off by default: CLAUDE_CODE_PROVIDER_SDKLOG=<file> records Claude Code's messages of each turn.
        if (process.env.CLAUDE_CODE_PROVIDER_SDKLOG) appendFileSync(process.env.CLAUDE_CODE_PROVIDER_SDKLOG, `${new Date().toISOString()} ${ocSession} ${JSON.stringify(m).slice(0, 400)}
`)
        usage.onSdkMessage(m)
        userSettings.onSdkMessage?.(m)
      }
      const watch = compactionWatch(notes, { userHooks: userSettings.hooks, userOnSdkMessage: onSdk, language: cfg.language })
      const toolMax = Number(cfg.toolInputMax) || 0
      const skills = await skillsFor(cfg, ocSession, cwd)
      // timeStamp: a constant line appended to Claude Code's system prompt (cache-stable); the stamp itself below
      // + the background line (plan 002): constant per configuration, so the prompt cache holds
      const append = [cfg.timeStamp ? TIME_HINT : "", backgroundHint(Boolean(peersMcp))].filter(Boolean).join("\n\n")
      const timeHint = { systemPrompt: { type: "preset", preset: "claude_code", append } }
      const stamp = cfg.timeStamp ? timeStamper() : (part) => part
      const inner = createBase({
        defaultSettings: { ...BASE_SETTINGS, ...userSettings, ...timeHint, ...claudeSettings(modelId, cfg, cwd), ...peersSettings(ocSession), ...(skills ? { skills } : {}), hooks: watch.hooks, onSdkMessage: watch.onSdkMessage, cwd, ...(resume ? { resume } : {}), spawnClaudeCodeProcess: spawnFiltered },
      }).languageModel(modelId)
      // The user's text goes to Claude Code as typed (no "Human: " prefix of the package).
      const prompt = rawUserTurn(resume ? newUserTurn(callOptions.prompt) : callOptions.prompt.filter((m) => m.role !== "system"))
      const opts = { ...callOptions, prompt, tools: undefined, toolChoice: undefined }

      const noteWindow = (meta) => {
        const main = mainModelUsage(meta?.["claude-code"]?.modelUsage, modelId) // not the helper model Claude Code also calls
        if (main) contextWindows.set(ocSession, main.contextWindow)
        if (main) modelNames.set(ocSession, main.name)
      }
      const remember = (id) => {
        if (id && (sessions[ocSession] !== id || sessions[accountKey(ocSession)] !== (account ?? ""))) {
          sessions[ocSession] = id
          sessions[accountKey(ocSession)] = account ?? ""
          saveSessionMap(sessions)
        }
      }
      if (kind === "generate") {
        const r0 = await inner.doGenerate(opts)
        const r = { ...r0, usage: usage.apply(r0.usage), content: r0.content.map((c) => (c.type === "tool-call" && toolMax ? { ...c, input: shortenToolInput(c.input, toolMax) } : c)) }
        remember(claudeSessionFrom(r))
        noteWindow(r.providerMetadata)
        watch.finish()
        if (background.live().length) notes.push(texts(cfg.language).backgroundStopped(background.live().map((x) => x.description).join("; ")))
        const shown = notes.take().map((text) => ({ type: "text", text: `_${text}_\n\n` }))
        // timeStamp: HH:MM before the first answer text
        const first = cfg.timeStamp ? r.content.findIndex((c) => c.type === "text" && c.text) : -1
        const content = first < 0 ? r.content : r.content.map((c, i) => (i === first ? { ...c, text: `${hhmm()}\n\n${c.text}` } : c))
        return shown.length || first >= 0 ? { ...r, content: [...shown, ...content] } : r
      }
      const r = await inner.doStream(opts)
      const stream = r.stream.pipeThrough(
        new TransformStream({
          start(ctl) {
            notes.attach(ctl)
          },
          transform(part0, ctl) {
            // tool calls: long values cut for display; the streamed pieces of the input are not shown (the call is)
            if (toolMax && part0.type === "tool-input-delta") return
            let part = toolMax && part0.type === "tool-call" ? { ...part0, input: shortenToolInput(part0.input, toolMax) } : part0
            if (part.type === "finish") {
              part = { ...part, usage: usage.apply(part.usage) }
              remember(claudeSessionFrom(part))
              noteWindow(part.providerMetadata)
              watch.finish()
              if (background.live().length) notes.push(texts(cfg.language).backgroundStopped(background.live().map((x) => x.description).join("; ")))
              notes.drain() // anything still waiting goes out before the end
            }
            notes.pass(stamp(part))
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
