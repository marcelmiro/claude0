# 5. The phone links out to the pull request rather than growing an in-app reviewer

Date: 2026-07-20
Status: accepted

## Context

[ADR 1](0001-changed-files-is-a-glance-surface.md) scopes the changed-files view to situational
awareness and rules out review depth — highlighting, line numbers, search. It also names the
condition for revisiting: the operator wanting to review from the phone.

That came up. The pull request itself is the answer: GitHub's mobile PR view already has
highlighting, threads and suggestions, and it is the *same* surface the operator reads at their
desk, so a phone review and a Mac review cannot diverge. Rebuilding a worse copy inside Portkey
would.

The open question was whether a PR usually exists, and where the exit should live. Both were
settled by a throwaway prototype (three variants switchable via `?variant=`, judged on-device
against live sessions) — kept as primary source on the `prototype/portkey-pr-link` branch.

Across 20 live sessions: 10 on a branch with an open PR, 1 merged, 1 pushed with no PR,
5 on a default branch, the rest with no live repo.

## Decision

Add one row at the top of the changed-files list, linking to the branch's PR (`core/pull-request.ts`
via `GET /sessions/:id/pr`, `PrRow` in the client). The file list stays primary; the PR is a
labelled door beside it.

Rejected variants:

- **A PR card in the thread outranking the changed-files card.** It surfaces state without a tap,
  but competes for the same slot on every session and is loud on the many that have no PR.
- **A per-file `↗` deep-linking into the PR's Files-changed tab.** Elegant, and undiscoverable —
  it lives only inside a diff the operator has already opened.

Nothing from ADR 1's "out" list is built. The row is an exit, not a feature.

## Consequences

- **PR state becomes a kill signal.** A worktree whose PR is already merged renders today as
  ordinary live work; the chip now says `merged`. This was the prototype's main finding and is
  worth more than the link itself.
- **The default branch renders nothing.** It has no PR to open and none to link — an earlier pass
  offered `compare/main`, i.e. merging main into itself. Silence beats a dead row on the repos
  worked directly on main, which is most of the operator's own.
- **`local-only` states it.** Absence would read as "no PR exists" when the truth is "this work has
  never left your Mac".
- Every failure — no `gh`, no GitHub remote, network down — collapses to `none`, which renders
  nothing. The row can be missing but never wrong.
- The lookup is network-bound, so it gets a 60s TTL rather than `/changes`'s 1s.

## See also

- [0001 — changed-files is a glance surface](0001-changed-files-is-a-glance-surface.md)

## Addendum (2026-09-08): the sidebar keys the PR on the edited checkout, not the pane's cwd

The sidebar's branch line carries the same lookup (`core/pull-request.ts`, refreshed by
inbox discovery at ≤5 rows per tick on a 60s TTL). Keying it on the tmux pane's cwd went
blind on most sessions: a session that runs `git worktree add` and then edits by absolute
path keeps its pane in the base checkout, so it reported `main` and no PR. On 2026-09-08,
five of eight live "main" sessions were working in a worktree that way.

Discovery now resolves the checkout of the session's **last in-repo edit** (Edit / Write /
MultiEdit / NotebookEdit under the base repo — `core/edit-dir.ts`), scanned incrementally
from a byte cursor cached on the snapshot row, and runs the PR lookup there. Edits are the
ownership signal; reading or listing a worktree is not. Any edit inside a worktree counts,
`.plans/` included (a session moving on to a new worktree plans there first — one live
session was keyed to a landed PR instead of its open one until this was allowed); a `.plans/`
edit in the base checkout does not (pre-worktree planning and the cleanup move-back both
trail the code). The scan applies only to panes sitting in the base checkout — a pane already
inside a worktree is explicit intent and wins as-is (a session that edited base before moving
would otherwise be dragged back). The branch line shows that checkout's branch.

**A removed worktree keys on the last PR the session printed.** Landed-and-cleaned-up is
exactly when the merged chip matters (ADR 5's kill signal), and there is no checkout left to
key on. The same scan keeps the last `github.com/<slug>/pull/N` for the repo's slug the
transcript mentions — a session prints its own PR's URL when it creates it — and discovery
resolves that number by `gh pr view`. Checked against nine live sessions: the last URL was the
session's own PR in every case that had one, including a session whose worktree hosted two
successive branches (it names the later PR). Validated against the live sessions before building: every session with a
judgeable answer picked its own worktree, and the naive "last edit anywhere" variant was
rejected because it lands on memory files and scratchpad scripts.

Chip: always `#N`, colored by state — open white (muted read as inert metadata at the weight
of a sub-day age; GitHub's green is mint here, which means running), draft dim, merged purple
(GitHub's merged color), closed red. The earlier merged-only `✓` dropped the number and, in mint, read as
"running"; the number stays so the landed PR is identifiable at a glance.
