# 6. Wrapping Claude Code: structured channels where they exist, guarded keystrokes where they don't

Date: 2026-07-16 (survey) · re-verified against the code 2026-07-21
Status: accepted

## Context

Claude0 wraps the **interactive** Claude Code TUI — tmux/`ps` discovery, hooks, the native status
file, JSONL transcripts — rather than driving Claude headless through the Agent SDK. That
choice is deliberate: the sessions Claude0 manages are real sessions you can attach to at the
desk. It is also a constraint, because some things Claude does are only ever expressed as
pixels in a terminal.

A survey of eight other tools that wrap Claude the same way was run on 2026-07-16 to answer:
where is Claude0 scrappy, and does anyone have a better mechanism worth adopting? Its findings
are recorded below. **Those competitor observations are a dated snapshot** — the repos were
cloned to scratch and are gone, so nothing here about another tool can be re-verified without
re-cloning. Everything stated about *Claude0's own* code was re-verified against `5f6b2bf`.

The survey's conclusion: the read/observe half (discovery, session-ID resolution, status,
content, subagents, notifications) is structured and in good shape. The remaining scrappiness
is concentrated in the **write path against the rendered TUI** — sending free text, answering
questions in attached mode, reading the current model/effort, driving `/rewind`.

## Decision

**Prefer a structured channel wherever one exists.** In practice that means Claude's hooks
(`PreToolUse` for approvals and questions, `SessionStart` for pane→session mapping), the
JSONL transcript for content, and `~/.claude/sessions/<pid>.json` for status.

**Where no structured channel exists, drive the rendered TUI — but never optimistically.**
Capture the pane, verify what's on screen matches what we expect, and abort on mismatch. UI
drift then fails closed rather than taking a wrong action.

**Do not leave Camp 1 to fix the write path.** The only structural escape is the SDK, which
gives up the interactive session, and that trade is refused.

### Adopted from the survey

- **`--session-id` dictation.** Sessions Claude0 launches get a UUID we mint, so the id is known
  before the process starts. This removed a launch→hook race and fixed forks, whose
  `SessionStart` hook records the *parent's* id. Live for the bridge (`tmux.ts`) and forks
  (`index.ts`). **Not yet on the TUI wizard's own launch path** — `buildLaunchCommand`
  (`core/launch-command.ts`) still emits a bare `claude`, so a session started with `n` still
  learns its id from the hook. `nativeSessionIdByPid` (`core/session-state.ts`) therefore
  remains load-bearing for externally-created forks; `dictatedSessionId` is tried first
  (`core/process.ts`).
- **Answering `AskUserQuestion` through the blocking `PreToolUse` hook**, via
  `hookSpecificOutput.updatedInput.answers`. This is a correctness fix, not a tidiness one:
  the tool has an undocumented ~60s Claude-owned timeout, so a question could expire before a
  phone could answer it. A hook that blocks *before* the tool runs means the clock never
  starts. Intercepting is gated (see Consequences) so the Mac's native widget still appears
  when you're looking at it.

### Rejected, with reasons that should not be re-litigated

- **Detecting the 1M context window via `usage.cache_creation.ephemeral_1h_input_tokens`.**
  That field is a prompt-cache TTL flag, not a window marker: it appears on sub-200k
  sessions, on Sonnet and Haiku, and 1h/5m TTLs coexist within one session. No transcript-side
  1M signal exists. `readContextUsage` (`core/session-api.ts`) keeps the `>200k ⇒ 1M`
  heuristic; the token sum itself is exact. The `[1m]` suffix `parseStatusline` produces is
  the *switcher's model argument* and is not wired to the usage denominator.
- **Dropping the statusline scrape for the current model/effort.** The native per-pid status
  file carries only `kind`, `sessionId`, `status`, `pid`, `updatedAt` — no model, no effort,
  no window size. There is no structured per-session source for effort anywhere, so the
  scrape is irreducible. See [ADR 4](0004-model-effort-switcher-scope.md).
- **Incremental byte-offset JSONL tailing.** Incompatible with the leaf→root branch
  reconstruction in `core/transcript.ts` (`parseActiveBranch` walks `parentUuid` upward from
  the last conversational record): a byte tail would leak turns from branches abandoned by a
  rewind. The current size+mtime-cached full re-parse is correct and self-heals partial
  writes.

### Deliberately kept as-is

- **The 250ms gap between text and Enter** (`core/tmux.ts`). Claude's TUI reads a coalesced
  burst as a paste. Every surveyed peer splits the same way with a hand-tuned delay. The same
  constant governs `sendKeysSequential` and the rewind picker.
- **`/rewind` picker driving** (`core/session-api.ts`). Presses Up, re-captures, and requires
  the cursor line to prefix-match the expected text — otherwise Escape and
  `reason: "rewind-mismatch"`. The alternative (fork the transcript and truncate after a
  message UUID) is content-only and loses Claude's file-state restoration, so it is not
  equivalent.
- **Keystroke answering as a fallback.** The hook did *not* replace send-keys; it demoted it.
  `answerQuestion` / `questionAnswerKeys` / `multiQuestionKeys` are still live behind a
  `if (!decideQuestion(...))` guard in three call sites. They are required infrastructure: a
  hook hold can be abandoned (its process dies), which `holdIsLive` detects by probing the
  marker's stamped pid, and the keystroke path is what keeps answering working when it does.
  Deleting them would reintroduce a hang.
- **Attached-mode tool approval by keystroke** (`decideAttachedApproval`). The `PreToolUse`
  hook exits neutral when you're attached, so no decision file exists to write; the pane is
  captured and re-checked for a live prompt before Enter/Escape is sent.

### Never adopt

Three patterns were observed and are explicitly out of bounds: auto-selecting "Yes, and don't
ask again" on injected commands; mapping an unrecognised permission prompt to a *guessed*
option instead of aborting; and binary-patching the Claude CLI to strip its anti-debug guards.
The first two trade correctness for convenience in exactly the place Claude0 refuses to; the third
is a supply-chain risk that breaks every release.

## Consequences

- Keystroke paths stay in the codebase permanently, and stay tested. "Replace the last
  send-keys call" is not a goal — some of them are the failure-mode safety net.
- Question interception is gated three ways before the hook answers: the pane must be
  Claude0-tracked, a phone must be connected (a `bridge-consumer` marker within 40s), and the
  window must not be focused — including a macOS frontmost-app check. Any ambiguity falls
  through to the native widget, so the desk experience is never degraded by a failed probe.
  This is the interaction model whose absence caused an earlier always-intercept version to be
  reverted.
- The version coupling on the write path is accepted, not solved. `updatedInput` for
  `AskUserQuestion` is undocumented, and the keystroke sequences are calibrated to a specific
  Claude release. The mitigation is the capture-verify-abort guard, not avoidance.
- The TUI wizard's launch path is asymmetric with the bridge's. Anyone touching
  `buildLaunchCommand` should know dictation was intended there too.
- Competitor claims here are frozen at 2026-07-16 and were not re-verified. Treat them as the
  reason a decision was made, not as current fact about another project.
