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
- **Helper requests are plain calls.** OpenCode's helper agents (`title`, `summary`) send the
  window's session header but no tools and their own system prompt. Such a request runs Claude
  Code with that system prompt, no tools, no MCP, no settings, one turn, nothing persisted — not
  as a turn of the window's session. (Before 2026-10-04 it was a full turn: with `title` on
  `claude-code` the window's message was executed twice — a `peer_send` letter went out twice —
  and the title was the first line of that answer.) So `title` / `summary` may use `claude-code`.
- **OpenCode's compaction is skipped** (auto or `/compact`). Claude Code keeps the whole
  conversation in its own session and compacts it itself; OpenCode's compaction could not shrink
  that, it only cost a full Claude turn and appended its summary to Claude Code's session
  (measured 2026-10-04). The provider recognizes OpenCode's compaction request and answers it with
  a short fixed note in OpenCode's format, without calling Claude. If OpenCode changes its
  compaction wording, the request is no longer recognized and is a normal turn again.
- **Letters between windows** ([opencode-peers](https://github.com/unitcraft/opencode-peers)):
  OpenCode's tool list is dropped, so the plugin's `peer_*` tools would be missing. Every request
  gets the peers MCP server (`node <opencode-peers>/mcp.ts`, tools `mcp__peers__peer_list`, ...,
  auto-allowed) acting for the requesting OpenCode session (`OPENCODE_PEERS_SESSION`, same
  `XDG_DATA_HOME` mailbox). Its location: provider setting `peersMcp` (path to `mcp.ts`, `false`
  turns it off), by default the sibling checkout `../opencode-peers/mcp.ts`; `peersNode` overrides
  the `node` command (node >= 24). The project list is not repeated here: the peers plugin shares
  its own. Incoming letters need nothing: the plugin puts them into the OpenCode session.
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
