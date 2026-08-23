# References — Claude Code mechanisms & competitor research

> **Status:** Research notes for plan authors. Capabilities below are from
> official docs; **exact field names marked "(inferred)" must be confirmed during
> Schema Pinning** (doc 01 / doc 02 §1b.0) before code relies on them.

## Claude Code hooks (the status source for Camp 1)

Docs: https://code.claude.com/docs/en/hooks · https://code.claude.com/docs/en/hooks-guide

Hooks run a script with a JSON payload on stdin. All payloads include
`session_id`, `cwd`, `transcript_path`, `hook_event_name`.

| Hook | Triggers when | Key payload fields | Can block? |
|------|---------------|--------------------|------------|
| `SessionStart` | session begins/resumes/clears/compacts | `source` (startup/resume/clear/compact) | no |
| `UserPromptSubmit` | before processing a submitted prompt | `user_message` (inferred name) | yes |
| `PreToolUse` | before a tool executes | `tool_name`, `tool_input`, `permission_mode` | **yes** — `permissionDecision: allow/deny`, can also rewrite `updatedInput` |
| `PostToolUse` | after a tool succeeds | `tool_name`, `tool_input`, `tool_result` | no (already ran) |
| `Notification` | Claude needs attention | `notification_type`: `permission_prompt` vs `idle_prompt` (+ `tool_name`/`tool_input` for permission) | no |
| `Stop` | Claude finishes responding (turn done) | `stop_hook_active` | yes (can force continue) |
| `SubagentStop` | a subagent finishes | `agent_type`, `agent_id`, `agent_result` (inferred) | yes |

**Most important facts for this project:**
- `Notification` distinguishes "needs tool permission" from "idle waiting for
  input" via `notification_type`. This is the exact signal Claude0 currently scrapes
  for — delivered cleanly by Claude itself.
- `PreToolUse` can **block and decide** the permission — the basis for the
  blocking-hook approval IPC (doc 02 §1b.3). **Verify** that a blocking decision
  suppresses the TUI prompt and that a neutral exit falls through to it.

## JSONL transcript (the content source)

Docs: https://code.claude.com/docs/en/sessions

- Location: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, append-only NDJSON.
- One JSON object per line: user message, assistant message, tool_use,
  tool_result, or metadata.
- A pending `tool_use` is reportedly written **before** approval — lets us render
  "Claude wants to run X" from structured data. **Verify shape during pinning.**
- `AskUserQuestion` is a tool, so its question + options are structured
  `tool_input` in the transcript → render real buttons, not scraped `☐`.
- Claude0 already tail-reads this for *archived* sessions; doc 02 §1b.2 generalizes it
  to live sessions.

> ⚠️ The research agent reported some transcript line shapes (e.g. `user_message`
> / `assistant_message` / `user_question` type tags) that look **inferred**. The
> real transcript likely uses different discriminators (e.g.
> `{"type":"user","message":{...}}`). Pin the real keys before writing the parser.

## Headless / programmatic (Camp 2 — NOT chosen, for reference)

Docs: https://code.claude.com/docs/en/headless · https://code.claude.com/docs/en/cli-reference ·
https://platform.claude.com/docs/en/agent-sdk/overview

- `claude -p --output-format stream-json --verbose` → NDJSON event stream
  (`system/init` carries `session_id`, then `assistant`, `tool_use`, `result`).
- `--input-format stream-json` → bidirectional: stream follow-up user messages +
  control-protocol replies over stdin to a persistent process.
- `--permission-prompt-tool <mcp-tool>` → route permission prompts to an MCP tool
  in non-interactive mode (enables human-in-the-loop approval headlessly).
- `--resume/-r <id>`, `--fork-session`, `--session-id`.
- Agent SDK (`@anthropic-ai/claude-agent-sdk`) — streaming input, `canUseTool`
  callback, resume, programmatic hooks.

**Why not chosen:** Camp 2 means the app *owns* the process and rebuilds the whole
UX; it discards Claude0 and the "real sessions I can SSH into" model. One-shot `-p`
cannot do interactive approval at all (must pre-approve or auto-decide). See
`00-overview.md`.

## Competitor research — how wrappers capture sessions

Two clear camps. Sources are GitHub repos / docs; some closed-source internals
are inferred from maintainer statements.

### Camp 1 — wrap the interactive TUI (tmux scrape + send-keys + hooks)
- **Claude-Code-Remote** (JessyTsui): tmux capture + hooks (`Stop`/`SubagentStop`)
  for notifications; `tmux send-keys` for input. Interactive TUI in tmux.
  https://github.com/JessyTsui/Claude-Code-Remote
- **ccgram** (jsayubi) — *the best Camp 1 model, closest to our target*: reads the
  **JSONL transcript** directly for status/content; uses **hooks**
  (`Stop`/`Notification`/`SessionStart`); answers questions via the hook
  `updatedInput` output; uses `tmux send-keys` / file-IPC (`/tmp/claude-prompts/`)
  for approvals; treats `capture-pane` as a display nicety only.
  https://github.com/jsayubi/ccgram
- Others: ccbot (https://github.com/six-ddc/ccbot), claudecode-telegram
  (https://github.com/hanxiao/claudecode-telegram), tap-to-tmux
  (https://github.com/flavio87/tap-to-tmux) — notification/remote-nudge tools, same
  pattern.

### Camp 2 — drive Claude headless (stream-json)
- **Crystal** (stravu): spawns `claude --verbose --output-format stream-json
  [--resume] -p`; parses events; tool approval via an injected **MCP permission
  server** over a Unix socket. https://github.com/stravu/crystal
- **vibe-kanban** (BloopAI) — *the Camp 2 reference for real remote interactivity*:
  `claude -p --permission-prompt-tool=stdio --input-format=stream-json
  --output-format=stream-json …`; bidirectional **stdin control protocol** blocks
  on a human Allow/Deny in the web UI. https://github.com/BloopAI/vibe-kanban
- **Claudia/opcode** (getAsterisk): stream-json for live runs + reads JSONL
  transcripts for history; auto-approves via `--dangerously-skip-permissions` (no
  human-in-loop). https://github.com/getAsterisk/claudia
- **Conductor** (conductor.build): drives Claude via the Agent/Code SDK against
  the local install. https://www.conductor.build/changelog
- **cmux** (manaflow-ai): multi-agent/worktree orchestrator; fits the Camp 2
  headless pattern (not fully confirmed at research time).

### What the mature GUIs converged on
Serious GUIs (Crystal, vibe-kanban, Claudia, Conductor) all chose **programmatic
control (Camp 2)**, not TUI scraping. The TUI camp is the lightweight
remote/notification tools — and even the best of those (ccgram) reaches for
**hooks + JSONL** rather than the rendered viewport.

**For us:** we deliberately stay Camp 1 because the goal is to observe *real*
sessions and keep the existing tmux/zsh/claude setup — but we adopt the ccgram
upgrade (hooks + JSONL, viewport as fallback) instead of the scrappy
viewport-scraping Claude0 uses today.

### Pitfalls the projects hit (heed these)
1. Viewport scraping is brittle — spinner glyphs, prompt strings, ANSI/chrome,
   and TUI redesigns break regex status detection. (This is exactly the bug we're
   fixing.)
2. `stream-json` needs `--verbose`; plain `json` only gives a final result.
   (Camp 2 only — informational.)
3. One-shot `-p` can't answer questions mid-run — needs `--input-format
   stream-json` + a control channel, or an MCP permission server. (Why we keep the
   interactive substrate.)
4. **Tool approval is the hard part in every camp.** Camp 1 `send-keys y/n` is
   racy → we use the **blocking `PreToolUse` hook** instead.
5. Session continuity: capture Claude's own `session_id`; don't invent IDs.
6. Hook freshness/desync — hooks reflect only state since they fired; guard with
   transcript mtime / live-pane reconciliation (we already know this from
   `claude0 next` state↔window desync).

## Doc source list
- Hooks: https://code.claude.com/docs/en/hooks , https://code.claude.com/docs/en/hooks-guide
- Sessions/transcript: https://code.claude.com/docs/en/sessions
- Headless: https://code.claude.com/docs/en/headless
- CLI reference: https://code.claude.com/docs/en/cli-reference
- Agent SDK: https://platform.claude.com/docs/en/agent-sdk/overview , https://code.claude.com/docs/en/agent-sdk/streaming-output
