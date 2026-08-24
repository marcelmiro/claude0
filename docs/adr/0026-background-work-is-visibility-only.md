# 26. Background work is one visibility-only surface

Date: 2026-08-24 (records decisions made when the feature shipped, 2026-07-21 → 27)
Status: accepted

## Context

A session waiting on a `run_in_background` script (e.g. pr-triage's Codex wait loop)
genuinely ends its turn — status correctly reads `ready` — so nothing on the phone or
in the tmux window said the session was still mid-work. Separately, async agents
finish and their reports are unreadable from the phone (tool_results are stripped from
the thread), so a finished agent simply vanished.

There is no live registry to ask. The harness records background work only in the
session's transcript: a `tool_use` launch, a `tool_result` confirming it, and much
later a `<task-notification>` when it completes. "Pending" must be recovered from that
record — and the record can lie: a session resumed under a new Claude process orphans
its tasks (the runner is dead, the notification never comes), leaving the transcript
saying "pending" forever. Real data had a 3-day-old wait on a live pane.

## Decision

### One surface for scripts and agents

Scripts and async agents are the same harness machinery — tasks plus
`<task-notification>` — so they share one surface rather than growing parallel ones:
the navbar 🤖/⏳ pill and its sheet on the phone, the ⏳ list marker and header 🔄
count, and the ⏳ window-name prefix on the Mac. `core/background-tasks.ts` recovers
both from the transcript with one parse.

### Visibility only

Pending background work never feeds notifications, attention (⚡), `claude0 next`,
sort order, status detection, or the status-right counts. A dead or intentionally
infinite script makes "pending" fundamentally unreliable as an input to anything that
demands action: a badge that lingers is a shrug; a notification or attention flag that
lingers is a lie that trains the user to ignore the tier. The ⏳ prefix ranks below ⚡
and 🔄 and exists purely so a `ready`-looking window reads as "churning, not waiting
on you".

### Detection is confirmation-gated (validated against real transcript history)

Each rule was checked against the full transcript history on disk:

- A candidate is a background `tool_use`: Bash with `run_in_background: true`, any
  `Workflow` call, any `Agent` call (background is the Agent tool's default and the
  key is often absent).
- The paired `tool_result` must **confirm** task creation ("Command running in
  background with ID: …" / "Async agent launched successfully… agentId: …"). Without
  it no notification will ever come: a Bash launch without it was denied or failed,
  and an Agent result without it ran synchronously — the result *is* its report.
  Gating on the result of a known background tool_use also means a foreground command
  that merely *prints* launch-shaped text can't false-positive.
- Completion arrives as a `<task-notification>` in one of three carriers: a `user`
  message (session idle), or a `queue-operation` / queued_command `attachment` record
  (session mid-turn). Paired by task-id or tool-use-id; unmatched notifications are
  ignored.

Prototype that validated the rules: branch `proto/bg-task-detection`.

Transcript-pending is computed for live-process sessions only (`pendingScriptsAt`):
without a Claude process the notification can never arrive, so a dead session would
badge forever.

### Transcript-pending is verified against reality by a runner-liveness probe

The runner holds an open fd on its `tasks/<id>.output` file for its whole life, so
`lsof` on that path definitively separates a live wait from an orphan.
`core/runner-verdicts.ts` is the single answer to "is this runner alive?" for all
three consumers (TUI, monitor, bridge). Its shape:

- **One `lsof` per probe round, never one per task.** `lsof` walks every process's fd
  table, so it costs ~115ms regardless of how many paths it's asked about; probing
  serially scaled with accumulated orphans (7 orphans = 807ms of a 985ms TUI launch,
  growing over time; batched, 118ms).
- Verdicts come from parsing the `-F n` output, **not** the exit code — one missing
  path makes `lsof` exit non-zero while still correctly reporting the rest. A path
  absent from the output reads dead, folding in the missing-file case for free.
- Matching is on `realpath`, because `lsof` reports resolved paths (macOS `/tmp` →
  `/private/tmp`); raw string matching would silently call a live runner dead.
- Dead verdicts are terminal and never re-probed (a runner never revives). Alive
  verdicts re-probe on a 15s TTL, applied per read — never trusted from the
  mtime-keyed parse cache, since a runner can die while its transcript sits still.

Flip side, accepted: an intentionally-infinite background daemon shows for as long as
it truly runs.

### Two on-disk caches, split by what they key on and how they may be shared

No consumer outlives the work — the TUI is a fresh process per `display-popup` open,
the monitor fresh per status tick — so nothing can live in memory. Two stores, with
deliberately different concurrency strategies:

- **`script-wait.json`**: the per-session transcript parse, keyed by (size, mtime), so
  a full transcript read happens only when a candidate's transcript changes. A single
  JSON document under re-read-merge/last-write-wins is fine here: it's a pure memo of
  the transcript, and the worst a lost entry costs is one re-read producing the same
  answer.
- **`verdicts/<taskId>`**: one file per task, atomic temp+rename (the
  `savePaneSessions` pattern). The three consumers probe overlapping-but-different
  task sets concurrently; a single shared JSON file loses a writer's slice whenever
  two callers re-read before either writes, and a lost verdict costs a fresh ~115ms
  `lsof` — or worse, resurrects a terminal dead verdict. Independent keys remove the
  read-modify-write race by construction.

### The sheet's fresh/older boundary is the last typed prompt

The pill's sheet orders: pending scripts (inert — no conversation behind a shell
loop), running agents, agents finished **since your last typed prompt** (fresh
reports), then older ones collapsed behind one toggle. The boundary is `lastPromptAt`
(backward windowed scan for the newest real prompt) vs each agent's `finishedAt` (its
immutable jsonl's mtime); an unknown boundary errs toward fresh — showing a stale
report is cheap, hiding a fresh one loses the only place a phone user can read it.
Completed/killed scripts are deliberately absent: no artifact, no action.

## Consequences

- The pill is a status while anything is live, an archive entry point after — the
  drill-in is the only phone surface for a finished agent's report.
- The 15s safety poll runs only while background work is live.
- Both the monitor (per tick) and the TUI (per refresh) compute ⏳ through the same
  entry point, `detectScriptWaits` in `core/script-wait.ts`, so the window prefix and
  the phone badge can't disagree.
- `verdicts/` is bounded by age-pruning (7 days untouched), since terminal-by-design
  entries would otherwise accumulate forever.

## Rejected

- **Pending scripts as a status or notification input** — a dead runner's "pending"
  is indistinguishable from a live one's without the probe, and even a probed-live
  infinite daemon needs nothing from the user. Every action tier stays keyed off
  Claude's own turn state.
- **Per-task `lsof`** — correctness-equivalent, but the cost scales with orphan count
  and it smears N snapshots across a second instead of one consistent one.
- **A shared verdicts JSON file** — loses concurrent writers' slices; narrowing the
  race (locks, retries) was rejected in favor of removing it structurally.
- **In-memory caching** — only helps a process that outlives the probe, and none
  does; the TUI re-proved the same permanently-dead verdicts on every launch.
