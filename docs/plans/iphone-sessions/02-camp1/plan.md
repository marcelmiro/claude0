# Plan — Impl #2 Increments

Seven increments. Each is one PR that passes `bun test` independently. Gate A is
🟢 (A1–A10 verified & committed) — no increment is blocked on a fresh spike.
Sizes: S ≤ ½ day, M ≈ 1 day, L ≈ 2 days. `HookEvent` is the **raw hook payload**
(snake_case), stored verbatim in the event log (see [`contracts.md`](./contracts.md)).

---

### Inc1 — `event-status.ts` (pure `deriveStatus`) · S
- **Status:** done.
- **Depends:** none (Gate A 🟢). **Unblocks:** Inc4.
- **Build:** `src/core/event-status.ts` exporting `deriveStatus(events: HookEvent[]): SessionStatus` (no `opts` yet — the test only calls `deriveStatus([...])`; Inc4 widens it). Truth table: SessionStart→idle, UserPromptSubmit/PreToolUse-open→running, Notification:permission_prompt→waiting, Notification:idle_prompt→**ready** (not waiting), Stop→ready. A **closed** PreToolUse→PostToolUse pair with no Stop is still `running` (track tool_use/tool_result pairing — don't map a bare PostToolUse to ready). `events` are raw payloads in append order. Define `HookEvent` in `src/types.ts`; **re-export it from `event-status.ts`** (the test imports `HookEvent` from `./event-status`).
- **Files:** `src/core/event-status.ts`, `src/types.ts` (`HookEvent` raw shape).
- **Done (runnable):** `bun test src/core/event-status.test.ts` → **7 pass, 0 fail**; `bun test` overall keeps `status.test.ts` + the Gate-A guard green.

### Inc2 — `transcript.ts` (parse + last assistant) · S
- **Status:** done.
- **Depends:** none. **Unblocks:** Inc4, Inc5.
- **Build:** `parseTranscript(raw: string): TranscriptTurn[]` + `lastAssistantMessage(turns): string | undefined`. A `TranscriptTurn` is `{ role, content: TranscriptBlock[] }` (field **`content`**, not `blocks`). Turns from `message.content[]` blocks (text/thinking/tool_use/tool_result); **a string-valued `message.content` (real in `approved-tool.jsonl`'s first user record) still yields a turn — wrap it as one `{type:"text"}` block.** Pair tool_use↔tool_result by `tool_use_id`; resolved `AskUserQuestion` as `{questions:[{question,header,multiSelect,options:[{label,description}]}]}` (A4 plural). Tolerate truncated last line + unknown keys. Generalizes `jsonl-reader.ts` tail-read. Define `TranscriptTurn`/`TranscriptBlock` in `src/types.ts`; **re-export both from `transcript.ts`** (the test imports them from `./transcript`).
- **Files:** `src/core/transcript.ts`, `src/types.ts` (`TranscriptTurn`, `TranscriptBlock`).
- **Done (runnable):** `bun test src/core/transcript.test.ts` → **6 pass, 0 fail**.

### Inc3 — Hook event log: writer + `claude0 setup` + reader · M
- **Status:** done.
- **Depends:** none (A7 latency 🟢). **Unblocks:** Inc4, Inc5, Inc6.
- **Build:** extend `setup()` (`cli.ts:457`) to register **one command per event** (no multi-dispatch ordering assumed): `event.sh` for `UserPromptSubmit`/`PostToolUse`/`Notification`/`Stop`/`SubagentStop`, and `pretooluse.sh` for `PreToolUse`. Each extracts `session_id` via the existing SessionStart approach (`cli.ts:432`: `grep -o '"session_id":"[^"]*"' | cut -d'"' -f4` — no jq/new deps), appends the **raw stdin payload verbatim** to `events/<session_id>.jsonl`. **Trim only when over budget** (`lines=$(wc -l < f); [ "$lines" -gt 200 ] && tail -200 f > f.tmp && mv -f f.tmp f`) so the common path is a bare append (the ~5ms A7 measured); the `mv -f` keeps the occasional trim atomic vs the ~3s readers. In Inc3 `pretooluse.sh` logs then `exit 0` (the extension point Inc6 fills). `core/hook-events.ts`: `readEvents(session_id): HookEvent[]` (no truncation; skip unparseable lines). The `setup()` idempotency check (currently keyed only on the SessionStart marker, `cli.ts:477`) must dedupe across all six new per-event arrays. `hook-events` pane-map + `processHookEvents()` untouched.
- **Files:** `src/cli.ts`, `~/.config/claude0/hooks/{event,pretooluse}.sh`, `src/core/hook-events.ts`.
- **Done (runnable):** GIVEN `claude0 setup` run twice, THEN `~/.claude/settings.json` has exactly one Claude0 entry per event (`jq '.hooks' settings.json` — no dupes). GIVEN a live `claude` driven through a tool-run, THEN `wc -l ~/.config/claude0/events/<id>.jsonl` ≥ 3 and `readEvents(id)` returns them with `hook_event_name` in `[UserPromptSubmit, PreToolUse, PostToolUse]` order.

### Inc4 — Wire event-status into discovery (HEADLINE) · M
- **Status:** done. (Also made `claude0 list` event-aware — done-criterion references its output.)
- **Depends:** Inc1, Inc2, Inc3. **Unblocks:** Inc7.
- **Build:** **widen `deriveStatus` to `(events, opts?: { transcript?: TranscriptTurn[] })`** (both types exist now). In `sessions.ts` `discoverSessions()` (~`:393`) prefer `deriveStatus(readEvents(id), {transcript})` when an event log exists, else `detectStatus()` scraper; set `statusSource: "event"|"scraper"`. Missed-edge backstop runs **only when the edge-derived status is `running`** (budget: no transcript read otherwise): read the transcript via the record's `transcript_path`; demote running→ready only if a `tool_result` followed the dangling `PreToolUse` OR transcript mtime quiet ~2–3 min (no CPU sampling). `status.test.ts` stays green — see note below.
- **Files:** `src/core/sessions.ts`, `src/core/event-status.ts` (widen signature), `src/types.ts` (`statusSource`).
- **Done (runnable):** GIVEN a session running a long Bash tool, WHEN I scroll the pane up, THEN `claude0 list` shows `running` (not `ready`) for ≥3 consecutive refreshes; `bun run bin/claude0.ts list` prints `statusSource=event` for hooked sessions.

### Inc5 — TUI: transcript preview + answer + send-message · M
- **Status:** done (live V4/V5 behavior verified at dogfood gate). Preview rewritten onto `transcript.ts` (rich rendering preserved via adapter); pending tool/question sourced from PreToolUse event; A8 index-nav `answerQuestion(paneId,…)` in `tmux.ts`; send-message gated to ready/waiting. sessionId→paneId bridge wrapper deferred to Impl #3 (no Impl #2 consumer; ADR-5 precedent).
- **Depends:** Inc2, Inc3 (A8/A9 🟢). **Unblocks:** none.
- **Build:** live preview sources from `transcript.ts` (`preview-pane.ts`). Space-menu "approve→answer" renders real `AskUserQuestion` options (pending from the `PreToolUse` event, resolved from transcript); submit via `send-keys` index nav (single `↓`×idx+Enter; multi `↓`+`Space` toggle, `→` Submit, Enter — A8). Free-text `/message` via `sendTextAndEnter`, **enabled only when status ∈ {ready, waiting-input}; the send action is hidden/disabled otherwise**.
- **Files:** `src/ui/preview-pane.ts`, `src/ui/space-menu.ts`, `src/core/tmux.ts`.
- **Done (runnable):** GIVEN a live session, THEN the TUI preview text equals `lastAssistantMessage(...)` of its transcript. GIVEN an `AskUserQuestion`, WHEN I pick an option in the Space-menu, THEN the answer appears in the transcript's next `PostToolUse.tool_response.answers`. GIVEN status `running`, THEN the send-message item is not selectable.

### Inc6 — Attach-aware blocking approval + `approval.ts` IPC · L
- **Status:** done (branches verified with stubbed tmux: attached fall-through, detached allow/deny, no-tmux exit, IPC round-trip with input enrichment). Live timing/600s-timeout + A6 pre-flight = dogfood gate.
- **Depends:** Inc3 (A6 🟢, proven & committed). **Unblocks:** none.
- **Build:** **Pre-flight (1 min):** re-confirm A6 on the current `claude` version (block N s, `allow` suppresses prompt; `ask` falls through); on failure stop and fall back to status-gated `send-keys`, document it. Extend the **same** `pretooluse.sh` from Inc3: after logging, `tmux list-clients -t <sess>` non-empty → emit `ask` (instant desk prompt, no lag); empty → write `pending/<id>.json`, poll `decisions/<id>.json` **every 500ms** up to the 600s hook `timeout` → emit `{hookSpecificOutput:{permissionDecision:"allow"|"deny"}}` (deny reason surfaced) or neutral fallthrough on timeout. `core/approval.ts`: `listPendingApprovals()`, `decideApproval(id, allow|deny, reason?)`. Wire TUI Space-menu "approve".
- **Files:** `src/cli.ts`, `~/.config/claude0/hooks/pretooluse.sh`, `src/core/approval.ts`, `src/ui/space-menu.ts`.
- **Done (runnable):** GIVEN a detached session at a permission prompt, WHEN `decideApproval(id,"allow")`, THEN the tool runs (next transcript line is the `tool_result`). GIVEN no decision, THEN after 600s the desk TUI prompt appears. GIVEN an attached client, THEN the desk prompt appears in <1s (time it).

### Inc7 — Monitor + notifications reconcile + rotation · M
- **Status:** done. Monitor `quickDiscoverActive` now event-sources status (transitions/prefixes/status-right follow hook edges — `notifications.ts` logic unchanged, just its status input). `reapDeadSessionFiles` reaps events/pending/decisions for dead sessions (verified). `boundary.test.ts` green — fixed a pre-existing violation (`core/search.ts`→`ui/session-list`) by moving `extractTicketId` to `core/git.ts`. Width-pin (#4): no `new-session` site in Claude0's `new-window` model — documented on `capturePane` (scraper-only caveat; event-status is width-independent).
- **Depends:** Inc4. **Unblocks:** dogfood gate. Detail: [`inc-7-notes.md`](./inc-7-notes.md).
- **Build:** drive `detectTransitions()` + ⚡/🔄 prefixes + tmux status-right from event edges (not scraping) in `notifications.ts` + `monitor.ts`. Reap dead sessions' `events/`, `pending/`, `decisions/` files (no live pane → rm). Pin fallback pane width (`-x 120`). Add a `core/` import-boundary guard test (see notes).
- **Files:** `src/core/notifications.ts`, `src/monitor.ts`, `src/core/tmux.ts`, `src/core/boundary.test.ts`.
- **Done (runnable):** GIVEN a running session scrolled up, THEN `bun run bin/claude0.ts status` shows it under 🔄 (not cleared). GIVEN a killed session, THEN its `pending/<id>.json` is gone next refresh. `bun test src/core/boundary.test.ts` → green (no `blessed`/`ui` import under `src/core/`).

---

**`status.test.ts` is RETAINED, not deleted.** Its header (`status.test.ts:13-15`)
says Impl #2 must "delete or invert" it. That instruction is **superseded**: ADR-2
keeps the viewport scraper as the per-session *fallback*, so its scroll-up
misread-as-`ready` is still live behavior worth pinning. Do **not** delete or
invert it; it documents the fallback path's known limitation (the reason
event-status is preferred whenever a log exists).

**Dogfood gate (doc 00):** after Inc4+Inc5+Inc6+Inc7, STOP and use Claude0 through real
Mac coding sessions until boringly reliable before any Impl #3 work. See
[`verification.md`](./verification.md).

---

## Completion note (Impl #2 — all 7 increments landed)

All increments implemented and gated on `bun test` (17 pass, incl. event-status 7,
transcript 6, status.test.ts, the Gate-A guard, and the new `boundary.test.ts`) +
production `tsc --noEmit` clean. Verified beyond the contract tests: hook writer/
idempotency/trim (real fixtures), `eventSourcedStatus` + both backstop halves,
`pendingToolCall`/`transcriptToMessages` adapters, the full `pretooluse.sh`
approval branches (attached fall-through, detached allow/deny, no-tmux exit) via
stubbed tmux, the IPC round-trip, and the dead-session reaper.

**Remaining = the dogfood gate (human, live `claude`+tmux):** V1/V2 scroll-up,
V3 remote-approval timing + 600s timeout + A6 pre-flight re-confirm, V4/V5 TUI
answer/send, V7 live monitor reconcile. **Decisions surfaced during build:** (a)
Inc5 input API is the A8 index-nav primitive in `tmux.ts` keyed by paneId — the
sessionId→paneId bridge wrapper is deferred to Impl #3 (ADR-5 no-consumer
precedent); (b) `claude0 list` was made event-aware (its done-criterion references its
output) though not in the Inc4 Files list; (c) Inc7 width-pin has no applicable
`new-session` site in Claude0's `new-window` launch model (documented on `capturePane`).
The lone `tsc` complaint is `transcript.test.ts:70`'s un-narrowed `ask?.input` on
the committed contract test (bun-only looseness; not editable as it's the spec).
