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
- **Account pinned explicitly, per project if needed.** `claudeConfigDir` (the project file, else the provider
  option, else the server's `CLAUDE_CONFIG_DIR`) is passed to Claude Code, so the account does not depend on how
  the OpenCode service was started, and one service serves projects with different accounts. A Claude Code
  session is resumed only under the account it started with; after a change of account the window starts anew.
- **The tab is known to hooks.** `OPENCODE_SESSION_ID` (the OpenCode session id) is in Claude Code's environment,
  so the repository's hooks know which tab they serve -- e.g. a `Stop` hook reads that session's opencode-peers
  status file ([plan 003](doc/plans/003-session-env.md)).
- **Permissions:** `permissionMode: auto`; anything that would need a question is denied
  (`permissionPrompts: none`) — OpenCode cannot relay Claude Code's prompts.
- **Models in the picker (plugin `models/`).** The plugin puts into OpenCode's catalog the models Claude Code
  itself offers (`supportedModels`, a control request, no model call): exact versions (`Claude Opus 5.5`,
  `Claude Fable 5.1`) and the aliases with what they point at now (`Claude Sonnet (рекомендуемая → 5)`); the provider is
  named `Claude Code · github.com/unitcraft`. The list is cached in `<OpenCode data>/claude-code-models.json` and
  refreshed in the background at start when it is 24 h old, or at once by `/cc-update-models`. A new model takes the
  settings (window, images) of its family in `opencode.jsonc` (Fable — of Opus). Register it next to the provider:
  `"plugins": [..., "<repo>/models"]`.
- **Images:** streaming input is always on (base64/data URLs; remote URLs are not supported
  by the package). The models must declare image input in `opencode.jsonc`, or OpenCode sends only
  the text `[Image 1]`:
  `"opus": { "name": "Opus", "modalities": { "input": ["text", "image"], "output": ["text"] }, "attachment": true, ... }`.
  File parts are passed in the package's shape whatever form they arrive in (a bare base64 string,
  bytes, a data URL; the package silently drops the untagged ones), and each turn's files are logged
  (`<session> files: image/png data 115K`).
- **Helper requests are plain calls.** OpenCode's helper agents (`title`, `summary`) send the
  window's session header but no tools and their own system prompt. Such a request runs Claude
  Code with that system prompt, no tools, no MCP, no settings, one turn, nothing persisted — not
  as a turn of the window's session. (Before 2026-10-04 it was a full turn: with `title` on
  `claude-code` the window's message was executed twice — a `peer_send` letter went out twice —
  and the title was the first line of that answer.) So `title` / `summary` may use `claude-code`.
- **`/compact` compacts Claude Code's memory.** Claude Code keeps the whole conversation in its
  own session; OpenCode's own compaction (a summary of OpenCode's history) could not shrink it --
  measured 2026-10-04: it cost a full Claude turn and appended its summary to Claude Code's
  session. The provider recognizes OpenCode's compaction request (auto or `/compact`) and runs
  Claude Code's own `/compact` in the window's session instead (measured: 34 s with Haiku, the
  next turn read ~26k tokens instead of ~40k, facts from the start remembered). OpenCode gets a
  short answer in its template: how long it took and the auto-compaction threshold. A window
  without a Claude Code session yet: "nothing to compact". If OpenCode changes its compaction
  wording, the request is no longer recognized and is a normal turn again (see below).
- **The user's text goes to Claude Code as typed.** The package prefixes every user message with
  `Human: ` (not configurable); a text-only message is passed as raw input instead, so Claude Code
  gets exactly the typed text and its own slash commands (e.g. `/flow` from `.claude/commands`)
  work. Messages with images or files keep the prefix.
- **Auto-compaction threshold per model** (`autoCompactWindow`): Claude Code compacts its memory
  when it reaches this size; unset -> Claude Code's own choice (measured: the full window for
  1M models). Claude Code clamps it to 100k ... the model's window (a larger value = the window).
  The keys are the model names OpenCode sends (the keys of `models` in the provider config:
  `opus`, `sonnet`, `haiku`) and match by family, so `opus` also covers `claude-opus-5-5` or
  `opus[1m]`; Claude Code maps the aliases to the current models itself.
- **Built-in tools switched off** (`tools: { "Name": false }`): removed from Claude Code's context.
  Measured 2026-10-04 (Haiku, empty folder): all 35 built-in tools ~27k tokens per turn of ~34k;
  without claude.ai artifacts, agent teams, scheduling and review tools (list below) 22k.
- **Claude Code compacting its context is shown.** When Claude Code's own memory fills up it
  compacts it (measured: 19-36 s with Haiku); the window would look stuck. The SDK hooks
  `PreCompact` / `PostCompact` put two lines into the answer: "⏳ Claude Code сжимает контекст…"
  and "✓ Контекст сжат за N с." (written by the provider, no model call; a line never splits a
  text block the model is streaming).
- **Letters and tasks between tabs** ([opencode-peers](https://github.com/unitcraft/opencode-peers)):
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

## Settings: defaults, machine, project

Three layers, each over the previous one (`src/settings.js`):

1. **Built-in defaults** -- nothing to configure for the usual case: English lines;
   `autoCompactWindow` opus 700k, sonnet 700k, haiku 200k tokens (owner's choice 2026-10-05); the built-in Claude Code tools
   that are useless in an OpenCode window switched off (claude.ai artifacts, agent teams,
   scheduling/cloud, code review: ~12k tokens of every turn).
2. **The machine**: the provider `settings` in `opencode.jsonc`.
3. **The project**: `.opencode/opencode-claude-code-provider.json` in the repository, searched upward from the
   window's directory.

**Skills**: `skills: { "name": false }`, like `tools`. Claude Code puts the listing of every skill into
each session (measured in nova-opencode: 51 skills, ~33k characters). The defaults leave out the
ones useless in an OpenCode window (Claude Code's own terminal UI, scheduling, claude.ai artifacts
and documents); the repository's skills stay. Claude Code takes an allowlist, so the provider
learns the full list once per directory from an interrupted turn (0 tokens) and passes "all but the
switched-off". A new session gets the filtered listing; a running one keeps the listing it started
with.

**Time stamp**: `timeStamp: true` -- the provider puts `HH:MM` before each answer text and adds one
constant line to Claude Code's system prompt telling the model not to write the time or run
`date` for it (opencode-windows-env stamps OpenCode's own HTTP responses; claude-code windows have
none, so without this Claude ran `date` on every message). Off by default. The system-prompt line
reaches new sessions (Claude Code records a session's system prompt); the stamp works at once.

**Tool calls in the window**: `toolInputMax` (default 300) -- Claude Code's tool calls are shown with
long string values cut to that many characters and "…(+N)" (a file written by one command used to
fill the screen); `0` shows everything. Display only: Claude Code executes the tools.

**Context size**: Claude Code makes several model calls in one turn; the window shows the input of
the last one (the real context), not the sum over the turn. It updates when the turn ends.

**One compaction threshold for OpenCode and Claude Code**: OpenCode compacts at
`limit.context − compaction.reserved` of the model (measured on 2.0.22) and shows the context as a
percentage of `limit.context`. Unless `autoCompactWindow` is set explicitly (provider options or the
project file), the provider gives Claude Code that same threshold, read from OpenCode's config: the
global `opencode.jsonc` and `opencode.json(c)` / `.opencode/opencode.json(c)` upward from the tab's
directory (a folder above the project's repositories counts). So both compact at one point and the
percentage means "how far to compaction". Example: `"compaction": { "reserved": 20000 }` and
`"limit": { "context": 520000, "output": 64000 }` → compaction at 500K. See
[plan 001](doc/plans/001-window-and-account.md).

**What is on in a window**: type `/cc-tools` as the whole message. The provider answers itself, no
model call: every tool Claude Code offers there (built-in and MCP), on or off, and which layer
decided (provider default, `opencode.jsonc`, project file, Claude Code), plus the context estimate.
It reads Claude Code's own tool list from the start of a turn it interrupts before the model is
asked (measured: 0 tokens). Switching tools per message is not offered: tool definitions come
first in the prompt, so every change of the set rewrites the whole history into the prompt cache
-- twice (on and back off); a project file changes it once.

Objects merge key by key (a project can switch one tool back on); `autoCompactWindow` as a single
number means every model and replaces the per-model values. A broken project file is ignored and
logged.

```jsonc
// opencode.jsonc -> "providers" -> "claude-code" -> "settings"
"settings": {
  "claudeConfigDir": "D:/Sources/.claude-accounts/nv-lang",
  "language": "ru",                                    // the provider's own lines: "en" (default) | "ru"
  "autoCompactWindow": { "opus": 500000 },             // per family (opus, sonnet, haiku, ...) or one number
  "tools": { "WebSearch": false },                     // false = removed from Claude Code's context
  "peersMcp": "D:/Sources/opencode-plugins/opencode-peers/mcp.ts" // default: the sibling checkout
}
```

```jsonc
// <repository>/.opencode/opencode-claude-code-provider.json -- this project only
{ "autoCompactWindow": { "haiku": 120000 }, "tools": { "Workflow": true },
  "claudeConfigDir": "D:/Sources/.claude-accounts/4px" }  // this project's Claude account
```

`autoCompactWindow` keys are the model names OpenCode sends (the keys of `models` in the provider
config) and match by family, so `opus` also covers `claude-opus-5-5` or `opus[1m]`; Claude Code
clamps the value to 100k ... the model's window.

## When OpenCode is updated

Two rules depend on OpenCode's own code and would stop working silently (no error, only wasted
Claude turns): compaction is recognized by OpenCode's wording, helper requests by having no tools.

**Automatic check.** Every request carries OpenCode's version (`User-Agent`). On the first request
of a new version the provider reads OpenCode's program (`opencode.exe`, its bundled JavaScript;
~0.3 s, no model call) and checks that the wording and the request shapes are still there. The
result is kept in `<opencode data>/claude-code-provider-check.json`. The check also runs when the
provider loads and every hour (so an `opencode upgrade` is noticed without any request). A failed
check, repeated every hour until fixed: a Windows notification, a warning line in each window, a
line in `%TEMP%/nova-opencode-plugins.log` -- all naming the ready prompt below.
The rules themselves stay safe: an unrecognized compaction or helper request is simply a normal
turn again. By hand: `npm run check-opencode`.

**Adapting to a new OpenCode**: give an agent the ready prompt `docs/adapt-to-opencode.md`
(paste it into a window opened in `D:/Sources/opencode-plugins`). The steps it follows:

1. `npm run check-opencode` -- which rule broke (`compaction: ...` or `title: ...`).
2. See what OpenCode sends now, in a scratch data dir so open windows are untouched:
   set `XDG_DATA_HOME` / `XDG_CONFIG_HOME` to scratch folders (copy `opencode.jsonc` there),
   set `CLAUDE_CODE_PROVIDER_PROBE=<file>` (records every request: tools, roles, text -- off by
   default because it writes the window's text), then:
   - compaction: `opencode serve --port 4799` (with `OPENCODE_PASSWORD` set), a session with
     three short turns (`opencode run --server http://127.0.0.1:4799 ...`), then
     `opencode api --server http://127.0.0.1:4799 session.compact --param sessionID=<id> --data "{}"`;
   - title: a new session with the `title` agent on `claude-code/...`.
3. In the probe file find the compaction request (last user message) and the title request
   (`tools`), and update `COMPACTION_OPENINGS` in `src/lib.js` (and the heading, if the template
   changed) or `isHelperRequest`; in `src/opencode-check.js` update the matching check.
4. `npm test` (the shapes in `test/opencode-check.test.js` follow the new OpenCode), then repeat
   step 2: compaction completed ("Claude Code compacted ..."), Claude Code's session shows its own
   `/compact` and no OpenCode summary request, the next turn reads fewer tokens; the
   title request does not repeat the window's message.
5. Delete `claude-code-provider-check.json` so the provider checks again; commit.

## Known limits

- Tools are Claude Code's, not OpenCode's: OpenCode plugins that act on OpenCode tool calls
  or inject into OpenCode's system prompt do not reach these windows.
- Every turn carries Claude Code's own part (measured 2026-10-04, Haiku): system prompt ~7k,
  built-in tools ~27k (~15k with the `tools` above), peers MCP ~0.2k,
  account settings ~0.8k, plus the repository's CLAUDE.md with its imports (nova: ~12k,
  nova-opencode: ~8k). Written to the prompt cache once, then read from it each turn.
- OpenCode plugins that add to OpenCode's system prompt (opencode-windows-env's time hint) or act on
  OpenCode's tool calls (opencode-claude-guards) do not reach these windows; the repository's own
  `.claude` settings and hooks do.
- Background work (Bash `run_in_background`, Monitor, background agents) does not outlive the turn: Claude Code's
  process ends with the turn and the task is killed (measured 2026-10-05). The next turn tells the model the task
  was stopped; the provider drops the empty turn Claude Code makes of that notice, which used to end the window's
  turn with no answer ([plan 002](doc/plans/002-background-tasks.md)). Claude Code's system prompt says so and points
  to opencode-peers' `peer_watch` (the plugin waits in the OpenCode server and wakes the tab); a turn that ends with
  live background tasks shows a note naming them.

## Related

Other OpenCode plugins of the same set (they work independently; together they are tested on one machine):

- [opencode-peers](https://github.com/unitcraft/opencode-peers) — letters and tasks between OpenCode sessions on one machine, across windows and projects, addressed by `project.role`
- [opencode-windows-env](https://github.com/unitcraft/opencode-windows-env) — a sane command environment on Windows and a time stamp on agent messages
- [opencode-claude-guards](https://github.com/unitcraft/opencode-claude-guards) — the repository's Claude Code rules (hooks, permissions) in OpenCode windows

## Layout and versions

- `index.js` -- the entry OpenCode loads (`aisdk:file:///<repo>/index.js`); it only re-exports the
  factory from `src/provider.js`.
- `src/` -- the provider: `provider.js` (requests), `lib.js` (sessions, recognizing OpenCode's
  requests, raw user text), `settings.js` (three layers), `notes.js` (lines shown in the window),
  `texts.js` (every such line, en/ru), `tools-report.js` (`/cc-tools`), `opencode-check.js`
  (the check after OpenCode updates).
- `ai-sdk-provider-claude-code` **4.x** (AI SDK v7, LanguageModelV4; Node >= 22). OpenCode 2.0.22
  bundles AI SDK 6 models but calls providers with its own code and accepts V4 models (measured
  2026-10-05: text, tool events and token accounting all arrive). From 4.x the provider uses
  `onSdkMessage`: Claude Code's `compact_boundary` gives the numbers of a compaction
  ("72k tokens -> 9k tokens") in the window line and in the `/compact` answer.

## Test

```sh
npm test
npm run check-opencode   # does the installed OpenCode still match the rules?
```
