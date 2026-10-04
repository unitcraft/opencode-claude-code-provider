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
//   * images: streaming input is always on.
// OpenCode loads the FIRST export whose name starts with "create", so this module exports
// only the factory (the package itself exports createAPICallError first).
import { createClaudeCode as createBase } from "ai-sdk-provider-claude-code"
import { sessionDirectory, loadSessionMap, saveSessionMap } from "./lib.js"

const BASE_SETTINGS = {
  systemPrompt: { type: "preset", preset: "claude_code" },
  settingSources: ["user", "project", "local"],
  permissionMode: "auto",
  permissionPrompts: "none",
  streamingInput: "always",
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

  const model = (modelId) => {
    const call = async (kind, callOptions) => {
      const ocSession = sessionIdOf(callOptions)
      const cwd = ocSession ? await sessionDirectory(ocSession) : undefined
      if (!cwd) {
        throw new Error(
          `claude-code: cannot resolve the directory of OpenCode session ${ocSession ?? "(no session header)"}; ` +
            "refusing to run Claude Code in an unknown directory",
        )
      }
      const resume = sessions[ocSession]
      const inner = createBase({
        defaultSettings: { ...BASE_SETTINGS, ...userSettings, cwd, ...(resume ? { resume } : {}) },
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
        return r
      }
      const r = await inner.doStream(opts)
      const stream = r.stream.pipeThrough(
        new TransformStream({
          transform(part, ctl) {
            if (part.type === "finish") remember(claudeSessionFrom(part))
            ctl.enqueue(part)
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
