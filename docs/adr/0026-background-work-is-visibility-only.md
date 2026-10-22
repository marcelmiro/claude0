# 26. Background work is one visibility-only surface

Date: 2026-08-24 (records decisions made when the feature shipped, 2026-07-21 → 27)
Status: accepted

How detection, the runner-liveness probe, the caches and the phone sheet work:
[docs/background-work.md](../background-work.md).

## Context

A session waiting on a `run_in_background` script (e.g. pr-triage's Codex wait loop)
genuinely ends its turn, so its status correctly reads `ready`, and nothing on the phone or
in the tmux window said the session was still mid-work. Separately, async agents finish
and their reports can't be read from the phone (tool_results are stripped from the
thread), so a finished agent simply vanished.

There is no live registry to ask. The harness records background work only in the
session's transcript: a `tool_use` launch, a `tool_result` confirming it, and much later a
`<task-notification>` when it completes. "Pending" has to be recovered from that record,
and the record can lie. A session resumed under a new Claude process orphans its tasks:
the runner is dead and the notification never comes, so the transcript says "pending"
forever. Real data had a 3-day-old wait on a live pane.

## Decision

- **One surface for scripts and agents.** Both are the same harness machinery (tasks plus
  `<task-notification>`), so they share one surface rather than growing parallel ones: the
  navbar 🤖/⏳ pill and its sheet on the phone, the ⏳ list marker and header 🔄 count, and
  the ⏳ window-name prefix on the Mac. One transcript parse recovers both.
- **Visibility only.** Pending background work never feeds notifications, attention (⚡),
  `claude0 next`, sort order, status detection, or the status-right counts. A dead or
  intentionally infinite script makes "pending" unreliable as an input to anything that
  demands action. A badge that lingers is a shrug; a notification or attention flag that
  lingers is a lie that trains the user to ignore the tier. The ⏳ prefix ranks below ⚡
  and 🔄, and exists so a `ready`-looking window reads as "churning, not waiting on you".
- **A pending task counts only once the harness confirms it and a live runner backs it.**
  A Bash or Agent launch counts only when its `tool_result` confirms a task was created:
  without that, no notification will ever come (it was denied, or ran synchronously). Every pending task is then checked against reality: the
  runner holds an open fd on its output file for its whole life, so one `lsof` per probe
  round separates a live wait from an orphan.
- **Liveness verdicts are one file per task.** The TUI, monitor and bridge probe
  overlapping task sets at the same time. A shared file loses a writer's slice, and with
  it a terminal dead verdict.

## Consequences

- The pill shows status while anything is live, and is an entry point to finished work
  afterwards: its drill-in is the only phone surface for a finished agent's report.
- An intentionally infinite background daemon shows for as long as it truly runs.
- `verdicts/` is age-pruned (7 days untouched): dead verdicts are kept forever by design,
  so without pruning they would pile up.

## Rejected

- **Pending scripts as a status or notification input.** Without the probe, a dead
  runner's "pending" looks the same as a live one's, and even a probed-live infinite daemon
  needs nothing from the user. Every action tier stays keyed off Claude's own turn state.
- **Per-task `lsof`.** It gives the same answers, but its cost scales with the number of
  orphans (7 orphans took 807ms of a 985ms TUI launch, versus 118ms batched), and it spreads
  N snapshots across a second instead of taking one consistent one.
- **A shared verdicts JSON file.** It loses concurrent writers' slices. Narrowing the race
  with locks or retries was rejected in favor of removing it structurally.
- **In-memory caching.** It only helps a process that outlives the probe, and none does:
  the TUI re-proved the same permanently-dead verdicts on every launch.
