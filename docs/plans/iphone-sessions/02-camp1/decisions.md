# Decisions — Impl #2 (Camp 1)

ADR-lite. These record the chosen approach and accepted risks; alternatives were
weighed in the adversarial pre-write pass and are not re-litigated here.

## ADR-1 — Event log is additive, separate, raw, and bounded
**Decision:** Add `events/<session_id>.jsonl` as a NEW per-session stream holding
the **raw hook payload verbatim, one JSON object per line** (no normalization).
Read without truncation; trimmed to the last 200 lines **only when over budget**
(`wc -l > 200`) via **atomic rename** (`.tmp` + `mv -f`) to survive the ~3s
concurrent readers — the common path stays a bare append (the A7-measured ~5ms). Leave the existing
`~/.config/claude0/hook-events` pane-map file and `processHookEvents()` (truncate-on-
read) completely untouched.
**Why raw verbatim:** the contract test `event-status.test.ts` casts the committed
fixtures (`hooks/*.json`) `as HookEvent` and feeds them straight to `deriveStatus`
— so `HookEvent` *is* the raw payload shape and a normalization layer would diverge
from the test. Bonus: `transcript_path` rides on every record, so Inc4 finds the
transcript without re-encoding `cwd` (retires that fragile path — see Open
questions).
**Why:** Chosen for stability without added complexity (user gate). Status
derivation needs recent edge *history*, which is fundamentally incompatible with
the pane-map's consume-and-truncate contract. Unifying the two streams would
rewrite working SessionStart plumbing for no functional gain; a durable+rotation
model adds backfill/rollback weight the feature doesn't need.
**Accepted risk:** two event files exist side by side (mild redundancy of
sessionId). Bounded by the 200-line trim; rotation in Inc7.
**How to apply:** never make event-status depend on `hook-events`; never make the
pane-map depend on the event log.

## ADR-2 — event-status is opt-in per session via log presence
**Decision:** Discovery uses `deriveStatus` only when `events/<sessionId>.jsonl`
exists; otherwise `status.ts` scraper. No global flag.
**Why:** Makes rollout and rollback **per-session and gradual** — pre-hook
sessions and mixed fleets always remain valid, and reverting `claude0 setup` cleanly
returns everything to the scraper. This is the backwards-compat shim (data-model §6).
**Accepted risk:** during transition, two sessions can use different status
sources; surfaced via `statusSource` for debugging.

## ADR-3 — Approval = attach-aware blocking PreToolUse; spike already done
**Decision:** Tool approval uses a blocking `PreToolUse` hook that exits neutral
(`ask`) when a tmux client is attached (instant desk prompt) and block-and-polls a
decision file when detached. Built as its own standalone increment (Inc6).
**Why:** Avoids the `send-keys` y/n race; arbitrates the desk/phone double-approval
race (only one surface is ever live). A6 proved all four sub-assumptions in a
contained, committed spike (doc 04: allow/deny suppress the TUI prompt; ask/exit-0
falls through; ~5s block stable; `tmux list-clients` branch works; 600s timeout).
**Accepted risk:** none new for the *attached* desk path — the risk surface is
already retired. Inc6 keeps a 1-minute pre-flight re-confirm against the current
`claude` version as a guard against version drift; on failure, fall back to
status-gated `send-keys` and document it. The desk TUI prompt is always the floor
(removing the hook strands nothing).
**Known gap — detached indiscriminate block (RESOLVED in hook v6; see Open
questions BLOCKER):** the original `pretooluse.sh` detached branch blocked on **every**
PreToolUse (writes `pending/` + polls up to 600s), not only tools that would
prompt. So a *detached* session hangs ~10 min on routine/auto-approved calls
(`Read`/`Grep`, the `Task` call, and — if they fire their own hooks — subagent
internal tools), making detached autonomous/subagent-heavy work unusable. This
does **not** affect attached desk use (the hook `exit 0`s instantly when a client
is attached), so Impl #2 desk dogfooding is unaffected and it was out of V3's
"tool awaiting permission" scope. **Fix direction:** in the detached branch,
`exit 0` when `permission_mode == "bypassPermissions"` (the mode autonomous
sessions run in), optionally also skip a read-only allow-list (`Read`/`Glob`/
`Grep`/…). The residual `default`-mode case can't perfectly know the user's
allow-list without replicating Claude's permission logic. **This must be
implemented and verified (a detached session running subagents does NOT stall on
auto-approved tools) before Impl #3's bridge/phone approval is considered
successful or pushed.** Tracked in Open questions below.

## ADR-3b — One command per hook event; PreToolUse is a single combined handler
**Decision:** `claude0 setup` registers exactly **one** command per event type. The
five non-blocking events share `event.sh` (log + exit). `PreToolUse` gets its own
`pretooluse.sh`: Inc3 makes it log-then-`exit 0`; Inc6 extends the **same** script
to add attach-aware approval after the log append.
**Why:** avoids depending on Claude Code running multiple commands per event in a
defined order. Logging and approval for `PreToolUse` are the same handler, so the
event is always logged before the (possibly blocking) approval decision, with no
dispatch-ordering assumption.

## ADR-4 — Missed-edge backstop via transcript, no CPU sampling — **REVERSED: pure edges, no backstop**
**Outcome (post-dogfood):** the entire transcript backstop was **removed**. Status is
now exactly the newest determining hook edge (`deriveStatus(events)`), no transcript
read, no timeout, no pairing. Both demotion halves fired on genuinely-working
sessions: the mtime-quiet (`QUIET_MS`) rule demoted any long-silent running session
(long Bash, auto-mode, subagent orchestration all go quiet) — a probation log caught
**351 false demotions in minutes**; the pairing rule demoted a *fresh* running turn
whenever an **old** dangling `PreToolUse` (dropped `PostToolUse`) from a prior turn
had its `tool_result` in the transcript. Both produced constant spurious
`turnComplete` ⚡ pings (the `cos-l2-tickets` report). A dropped *terminal* edge — the
only thing the backstop guarded — is rare and self-heals on the session's next event,
so trusting edges is both simpler and more correct. Pinned by `hook-events.test.ts`
(stale-dangling-tool → still running) + `event-status.test.ts`. The original decision
is kept below for history.

**Decision (original, superseded):** Trust the last hook edge as primary; gate "running" on pane/proc
liveness each refresh; demote running→ready only when a secondary signal confirms
(a `tool_result` after the dangling `PreToolUse`, or transcript mtime quiet ~2–3
min). `deriveStatus` reads the transcript (`opts.transcript`) for this.
**Why:** Hooks fire edges, not a heartbeat; a dropped terminal edge would otherwise
strand "running" forever. CPU sampling is too noisy. (Resolved decisions, doc 00.)
**Accepted risk:** a genuinely long silent tool stays "running" up to the mtime
threshold — correct, not a bug.
**Refinement (dogfood bug fix):** the tool_result-pairing demotion originally fired
on *any* transcript with the dangling tool's result — but between back-to-back
tools the transcript holds a `tool_result` a few ms before its `PostToolUse` edge
is logged, so a monitor poll landing in that window demoted an actively-working
session to `ready` (~1 false `turnComplete` ping/1–2 min for a tool-heavy session;
confirmed in `debug.log`). Fix: the pairing demotion is now **gated on the
transcript being settled** (`SETTLE_MS ≈ 12s` quiet) — an actively-working session
rewrites its transcript every few seconds so its mtime never ages past the gate
(→ stays running), while a genuinely dropped terminal edge lets the transcript go
quiet (→ demote). Logic extracted to the pure `backstopStatus(events, transcript,
mtimeAgeMs)` and pinned by `hook-events.test.ts` (in-flight→running, settled→ready).

## ADR-5 — Change-notification (watch events dir) deferred to Impl #3
**Decision:** Do **not** build the debounced `watch(eventsDir)` SSE-push primitive
in Impl #2.
**Why:** It has no consumer here — the TUI and monitor already poll a 3s loop.
Building it now is speculative (violates simplicity-first). Its only consumer is
the bridge, so it is Impl #3's first increment.
**How to apply:** if a watch is *incidentally* needed for monitor responsiveness,
keep it private to `monitor.ts`; don't promote it to the public `core/` API yet.

## ADR-6 — Keep Darwin-only calls out of `core/`
**Decision:** `pbcopy`, `osascript`, `terminal-notifier`, `afplay`, `caffeinate`
stay in `index.ts`/`ui`/platform shims — never in `core/` or the future
`src/bridge/`. Inc7 adds an import-boundary guard test.
**Why:** EC2 (Linux) is a later iteration; the move must be config, not a port
(doc 00). Today these live in `index.ts:174`, `monitor.ts:184`,
`notifications.ts:121–165` — acceptable (not in `core/`); the guard prevents
regression as event-sourcing moves logic around.

## ADR-7 — Monitor/notifications reconciliation is in scope (Inc7)
**Decision:** Event-source the *whole* attention path (tmux status-right + ⚡/🔄
prefixes), not just the TUI list.
**Why:** Otherwise the scroll-up bug persists in the monitor/status-right path —
the headline bug would only be half-fixed. (User gate: in scope.)

## Sourced assumption log

| Assumption | Source | Confidence |
|------------|--------|------------|
| Hook common envelope (session_id, cwd, transcript_path, hook_event_name, permission_mode, effort.level) | SCHEMA.md A1; Gate A 🟢 | verified (claude v2.1.191) |
| `notification_type ∈ {permission_prompt, idle_prompt}` | SCHEMA.md A2 | verified |
| Pending tool absent from transcript pre-approval (lives in PreToolUse) | SCHEMA.md A3 | verified |
| `AskUserQuestion` = `tool_input.questions[]` (plural) | SCHEMA.md A4 | verified |
| Transcript discriminators (user/assistant + message.content[] blocks) | SCHEMA.md A5 | verified |
| Blocking PreToolUse controls approval; attach-aware branch | doc 04 A6 | verified (committed spike) |
| Event-writer hook latency ~5ms | doc 04 A7 | verified |
| `AskUserQuestion` answerable via send-keys index nav | doc 04 A8 | verified |
| `send-keys` lands in a detached pane | doc 04 A9 | verified |
| `processHookEvents` is truncate-on-read; pane-map format `<paneId> <sessionId>` | `state.ts:104–141` | verified (read) |
| Status union + `detectStatus` signature | `status.ts:5,117` | verified (read) |
| Contract fn names + signatures `deriveStatus(events,{transcript?})` / `parseTranscript` / `lastAssistantMessage` | the RED test files (read) | verified (the spec) |
| `HookEvent` = raw snake_case payload (`session_id`/`hook_event_name`/`transcript_path`/…), no `ts` | `event-status.test.ts` casts `hooks/*.json` as `HookEvent` | verified (read) |
| Test counts: event-status 7, transcript **6** | the RED test files (read) | verified (read) |
| `HookEvent` exported from `./event-status`; `TranscriptTurn`+`TranscriptBlock` from `./transcript` | `event-status.test.ts:22`, `transcript.test.ts:24-29` | verified (read) |
| `TranscriptTurn` field is `content` (not `blocks`); a `message.content` may be a bare string | `transcript.test.ts:14,36`; `approved-tool.jsonl` 1st user record | verified (read) |
| `deriveStatus` truth table incl. idle_prompt→ready, no SessionStart→ready | `event-status.test.ts:33-72` | verified (read) |
| `session_id` shell-extractable jq-free (existing hook) | `cli.ts:432` | verified (read) |

## Open questions (from review)

- **A7 budget vs amortized trim (SHOULD-FIX):** A7 measured *append* at ~5ms; the
  conditional trim (`wc -l`, tail, `mv -f`) fires only when >200 lines, so it's
  amortized — but it has not been measured on Claude's synchronous hot path. If
  dogfooding shows any hook-induced lag, re-measure with the trim included before
  trusting the 5ms figure.
- **`status.test.ts` retention (SHOULD-FIX, resolved):** the test's own header says
  Impl #2 should delete/invert it; the plan keeps it green because the scraper
  survives as the documented fallback (ADR-2). Recorded so an implementer doesn't
  obey the stale in-file instruction. Revisit only if the scraper fallback is ever
  removed.

- **cwd-encoding collision (CONSIDER):** the existing `repoPath.replace(/\//g,
  "-")` encoding (`sessions.ts:177`) can collide for paths differing only by `/`
  vs `-`. Impl #2 does **not** inherit this: event/pending/decision files are keyed
  by `session_id` (UUID), and Inc4 reads the transcript via the record's
  `transcript_path` rather than re-encoding `cwd`. Left as a pre-existing note for
  the scraper-fallback path only; no action in this plan.
- **Per-hook `session_id` extraction in shell (CONSIDER):** Inc3 reuses the
  existing SessionStart hook's extraction. If that approach is brittle, evaluate a
  minimal `bun`-based writer — but only if A7's ~5ms budget is preserved.
- **Decision-file poll interval (resolved to 500ms, revisit):** 500ms balances
  remote-approval latency vs syscall load (≤1,200 stats over a 600s window).
  Revisit if remote approval feels laggy in dogfooding — lower to 250ms.

- **Detached PreToolUse blocks indiscriminately (BLOCKER for Impl #3 — RESOLVED
  in hook v6):** the detached branch used to block on every PreToolUse, stalling a
  detached/subagent-heavy session up to 600s per call on routine/auto-approved
  tools. Fixed (`HOOK_VERSION = 6`): the detached branch now `exit 0`s when
  `permission_mode == "bypassPermissions"` or the tool is read-only
  (`Read|Glob|Grep|NotebookRead|TodoWrite|Task`); only tools that could actually
  prompt reach the block-poll. The residual `default`-mode case still can't know
  the user's allow-list without replicating Claude's permission logic, so an
  allow-listed `Bash` command still blocks (acceptable — approval works, it's just
  unnecessary for that case). Verified two ways: `src/cli.pretooluse.test.ts`
  (generated hook + stubbed tmux: read-only/bypass → neutral, `Bash`/default →
  still block-polls and honors an allow decision) and a live detached-tmux repro
  (`Read|Grep|Task|Bash+bypass` → neutral; `Bash`/default → blocks). Run
  `claude0 setup` to deploy v6.
