# Implementation 2 — Camp 1 Migration (hooks + JSONL)

> **Status:** DRAFT — for agent iteration.
> **Depends on:** Implementation 1 (contract tests define the target).
> **Unblocks:** Implementation 3 (provides a stable, reliable internal API).
>
> **⛔ Gate:** Do not write code until **Gate A** in
> [`04-verification-gates.md`](./04-verification-gates.md) is 🟢 — especially
> **A6 (blocking-hook approval semantics)**, the highest-risk assumption in this
> implementation. See the Enforcement protocol in [`00-overview.md`](./00-overview.md).

## Goal

Migrate Claude0's sensing and input layers from **viewport scraping** to
**hook events + JSONL transcript**, while keeping the substrate exactly as it is
today: real interactive `claude` sessions running in tmux that you can also SSH
into from the Mac.

This implementation is **internal to Claude0**. It ships no mobile app. Its output is
(a) a Claude0 that reports status reliably regardless of scroll position, (b) a clean
structured view of each session's conversation and pending prompts, and (c) an
internal API surface that Implementation 3's bridge will consume.

> **Dogfood checkpoint (Resolved decisions, doc 00): STOP here.** This is the
> point to *stop and use Claude0 through real Mac coding sessions* until the
> scraper→JSONL migration is boringly reliable — before any bridge/app work. Do
> not start Implementation 3 until status no longer flips on scroll-up,
> transcript-driven preview/answers are correct, and desk approval via the IPC
> works in daily use.

## What changes, in one line

`capture-pane`-regex is demoted from "the status source" to "an optional
thumbnail." Status comes from hook edges; content comes from the transcript;
approvals come from a blocking hook; free-text input still uses `send-keys`.

## Reuse map

| Reused as-is | New | Demoted |
|--------------|-----|---------|
| `core/sessions.ts`, `core/process.ts`, `core/state.ts`, `core/tmux.ts` (send-keys/capture), `core/notifications.ts` (transition logic), `claude0 setup` hook plumbing | `core/event-status.ts`, `core/transcript.ts`, `core/hook-events.ts` (event log read/write), `core/approval.ts` (IPC) + new hook scripts | `core/status.ts` viewport regex → fallback only |

## Sub-phases

Each sub-phase is independently shippable and testable. Phases 1b.0–1b.1 already
fix the scroll-up bug for Claude0 itself, before any mobile work.

### 1b.0 — Schema pinning (shared with impl #1)

Same task as Implementation 1's "Schema Pinning." Capture real hook payloads and
transcript shapes; record in `test/fixtures/SCHEMA.md`. **Do not start 1b.1 until
this is closed** — everything downstream parses against these shapes.

### 1b.1 — Event-sourced status

The headline fix. Status becomes a pure function of the session's recent hook
events.

- **Extend `claude0 setup`** to install hooks beyond `SessionStart`:
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`,
  `SubagentStop`. Keep it idempotent (it already is) and preserve any existing
  user hooks.
- **Hook script** (`~/.config/claude0/hooks/event.sh` or per-event scripts): append a
  normalized event record to a per-session log:
  ```
  ~/.config/claude0/events/<sessionId>.jsonl
  ```
  Each line: `{ ts, sessionId, cwd, event, notification_type?, tool_name?, ... }`.
  Keep the writer trivial and fast (hooks are on the hot path; a slow hook delays
  Claude). Truncate/rotate the log to a bounded size.
- **`core/hook-events.ts`**: read + tail the per-session event log; expose
  "latest events for session X."
- **`core/event-status.ts`**: derive `SessionStatus` from the last event edge
  (see Contract A in impl #1 for the truth table). Map to Claude0's existing
  `"running" | "waiting" | "ready" | "idle" | "archived"`.
- **Wire into discovery**: in `core/sessions.ts`, prefer `event-status` when an
  event log exists for the session; fall back to `status.ts` scraping when it
  does not (e.g. sessions started before hooks were installed). Surface which
  source was used (for debugging and the drift canary).
- **Validate** against the impl #1 contract tests — especially the scroll-up
  regression — and by diffing event-status vs scraper-status across live
  sessions in `claude0 list`.

**Edge cases to handle:**
- Session started before hooks installed → no event log → scraper fallback.
- `state ↔ window` desync (already a known problem from `claude0 next`): reconcile
  the event log against live panes on each refresh; an event log with no live
  pane = archived.
- Hooks fire edges, not a continuous heartbeat. "running" is inferred from
  "`PreToolUse`/`UserPromptSubmit` seen, no terminal edge yet."
  **Decided heuristic (Resolved decisions, doc 00) — transcript as cross-check:**
  trust the last event edge as primary; gate "running" on pane/proc liveness each
  refresh (already free); for a *dropped* terminal edge, demote running→ready only
  when a secondary signal confirms — a `tool_result` appeared in the transcript
  *after* the `PreToolUse`, or transcript mtime has gone quiet past a generous
  threshold (~2–3 min). **No CPU sampling** (too noisy). This means
  `event-status.ts` also reads the transcript for the missed-edge backstop — a
  small, deliberate coupling that avoids any eternal-stuck "running" state.

### 1b.2 — Live transcript reader

- **`core/transcript.ts`**: read `~/.claude/projects/<encoded-cwd>/<id>.jsonl`
  for a *live* session and return structured turns (this generalizes the existing
  archived-session tail-read in `preview-pane.ts`/`sessions.ts`). Output:
  - ordered turns (user / assistant-text / tool_use / tool_result),
  - the last assistant message (for preview + notification text),
  - any pending tool call `{ pending, tool, input }`,
  - any open `AskUserQuestion` `{ question, options:[{label, description}] }`.
- Must tolerate a partially-written final line (transcript is appended live) and
  unknown keys (forward-compat with Claude versions).
- Resolve the `encoded-cwd` → project-dir mapping (Claude0 already locates session
  index files; reuse that path logic).
- Validate against impl #1 Contract B fixtures.

### 1b.3 — Input & approval

Two **distinct** paths — keeping them separate is what makes the UX clean:

**(a) Tool approval → attach-aware blocking `PreToolUse` hook** (the good path;
avoids the `send-keys` y/n race the research flagged as fragile):

1. `PreToolUse` hook fires with `tool_name` + `tool_input`.
2. **The hook checks tmux attach state** (`tmux list-clients -t <target>`):
   - **Client attached (you're at the desk) → exit neutral immediately.** The
     normal interactive TUI prompt appears with no dead air. (A blocking hook
     halts Claude's loop, so the TUI prompt can't render until the hook returns —
     blocking unconditionally would add seconds of lag to *every desk approval*.
     This branch is what preserves the desk UX.)
   - **Detached (you're away) → block-and-poll.** The hook writes the request to
     `~/.config/claude0/pending/<sessionId>.json` and **blocks**, polling for a
     decision file (ccgram uses this file-IPC pattern).
3. A consumer (Claude0 TUI now; the bridge later) reads pending requests and writes
   the decision; hook returns the Claude Code permission decision
   (`{ permissionDecision: "allow" | "deny", ... }`).
4. **Timeout fallback:** if no decision arrives within a *long* timeout, the hook
   exits neutral → the normal interactive TUI prompt appears. Because the
   block-and-poll branch only runs when detached, the desk and the phone are never
   both live approval surfaces for the same prompt (no double-approval race).

   > **Verify in 1b.0 / Gate A6:** (a) a blocking decision actually *suppresses*
   > the TUI prompt; (b) a neutral exit cleanly falls through to it; (c) the block
   > doesn't destabilize Claude; (d) the hook can cheaply read attach state and
   > branch. If (a)/(b) fail, fall back to send-keys for approval and document the
   > race-mitigation (only send when status is `waiting`).

- **`core/approval.ts`**: the request/decision IPC (write pending, await
  decision, expose pending list). Used by both the TUI's existing Space-menu
  "approve" action and, later, the bridge.

**(b) Free-text message → `send-keys`** (`core/tmux.ts` `sendTextAndEnter`,
already exists): safe because we only enable it when status is `ready` /
`waiting-input` (cursor at the prompt). This is *not* the racy case — that was
y/n during a TUI redraw, which path (a) removes.

**(c) `AskUserQuestion` answer:** render options from the transcript; submit via
whichever 1b.0 determined — a hook-supplied answer if possible, else `send-keys`
arrow-to-index + Enter (robust because the option index is known from the
structured transcript).

### 1b.4 — Hardening

- Pin pane width for any fallback capture (`tmux new-session -x 120` or set on
  launch) so `status.ts` fallback stays deterministic.
- Event-log rotation/cleanup for ended sessions.
- Reconcile event-status with `core/notifications.ts` transition detection so the
  ⚡/🔄 prefixes and tmux status-right are driven by event edges, not scraping.
- Decide whether the `monitor.ts` poller also reads event logs (it should — it is
  "the sole authority for window naming" per CLAUDE.md).

## Internal API surface (the handoff to Implementation 3)

By the end of 1b, `core/` should expose, framework-agnostic and headless:

- `discoverSessions()` → sessions with **event-sourced** status.
- `getTranscript(sessionId)` → structured turns + pending prompt + open question.
- `listPendingApprovals()` / `decideApproval(sessionId, allow|deny)`.
- `sendMessage(sessionId, text)`.
- a change-notification primitive (watch the events dir) so the bridge can push
  updates without polling.

Implementation 3 builds the HTTP/SSE bridge directly on these — it should add
*no* new Claude-wrapping logic.

## Acceptance criteria

- Impl #1 Contract A & B tests pass; the scroll-up regression test is green.
- `claude0 list` / TUI status matches reality through a full tool-run + scroll-up
  cycle with no flicker to "ready."
- A tool permission request can be approved from outside the TUI (via the
  `approval.ts` IPC) and the session proceeds; timeout falls through to the TUI.
- An `AskUserQuestion` can be answered from structured options.
- Sessions started before hook install still work via scraper fallback.

## Risks / open questions

- [ ] Blocking-hook approval semantics (TUI suppression + neutral fallthrough) —
      **must** be verified in 1b.0; the whole approval UX hinges on it.
- [ ] Hook latency: hooks are synchronous on Claude's path. The event writer must
      be near-instant. Measure it.
- [ ] `AskUserQuestion` answer mechanism (hook vs send-keys).
- [ ] Event-log durability across reboots / tmux-resurrect (tie into the existing
      resurrect integration).
- [ ] "running" staleness heuristic when a long tool runs with no intermediate
      events.
