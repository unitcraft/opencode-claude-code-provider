# opencode-claude-code-provider

OpenCode provider `claude-code`: every request is served by the **official Claude Code**
(Anthropic's Claude Agent SDK, through
[`ai-sdk-provider-claude-code`](https://github.com/ben-vargas/ai-sdk-provider-claude-code)).
Nothing is spoofed: Claude Code runs under your own Claude login, exactly as in its CLI.

## What it does on top of the package

- **Right directory.** OpenCode runs one background server for all windows. Each request
  carries `x-opencode-session-id`; the provider looks the session's directory up in
  `opencode.db` (read-only) and starts Claude Code there. Unknown session -> the request is
  refused instead of running in some other directory.
- **Claude Code's own setup.** Its system prompt (`preset: claude_code`), and
  `settingSources: user, project, local` — so the repository's `CLAUDE.md`,
  `.claude/settings.json` permissions and hooks apply. OpenCode's system prompt and tool list
  are dropped (they describe tools Claude Code does not have).
- **One Claude Code session per OpenCode session** (`resume`). A turn sends only the newest
  user message; Claude Code keeps its own transcript and prompt cache. The mapping lives in
  `<opencode data>/claude-code-sessions.json`.
- **Account pinned explicitly.** `claudeConfigDir` (provider option) or the server's
  `CLAUDE_CONFIG_DIR` is passed to Claude Code, so the account does not depend on how the
  OpenCode service was started.
- **Permissions:** `permissionMode: auto`; anything that would need a question is denied
  (`permissionPrompts: none`) — OpenCode cannot relay Claude Code's prompts.
- **Images:** streaming input is always on (base64/data URLs; remote URLs are not supported
  by the package).
- OpenCode loads the first export whose name starts with `create`; this module exports only
  `createClaudeCode` (the package exports `createAPICallError` first).

## Install

```sh
git clone https://github.com/unitcraft/opencode-claude-code-provider D:/Sources/opencode-claude-code-provider
cd D:/Sources/opencode-claude-code-provider && npm install
```

`~/.config/opencode/opencode.jsonc`:

```jsonc
"provider": {
  "claude-code": {
    "npm": "file:///D:/Sources/opencode-claude-code-provider/index.js",
    "name": "Claude Code (official)",
    "options": { "claudeConfigDir": "D:\\Sources\\.claude-accounts\\nv-lang" },
    "models": { "haiku": {}, "sonnet": {}, "opus": {} }
  }
}
```

## Known limits

- Tools are Claude Code's, not OpenCode's: OpenCode plugins that act on OpenCode tool calls
  or inject into OpenCode's system prompt do not reach these windows.
- Each new Claude Code session starts with ~28k tokens of Claude Code's own system prompt and
  tools (cached afterwards, as in the CLI).

## Test

```sh
npm test
```
