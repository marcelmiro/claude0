# 5. The phone links out to the pull request rather than growing an in-app reviewer

Date: 2026-07-20
Status: accepted; amended 2026-09-08 (sidebar PR keyed on the edited checkout)

How the PR lookup, states and chip work: [docs/changed-files.md](../changed-files.md).

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
against live sessions); the prototype branch was not kept.

Across 20 live sessions: 10 on a branch with an open PR, 1 merged, 1 pushed with no PR,
5 on a default branch, the rest with no live repo.

## Decision

Add one row at the top of the changed-files list, linking to the branch's PR (`core/pull-request.ts`
via `GET /sessions/:id/pr`, `PrRow` in the client). The file list stays primary; the PR is a
labelled door beside it. Nothing from ADR 1's "out" list is built. The row is an exit, not a feature.

The sidebar's branch line carries the same lookup as a `#N` chip, keyed on **where the session's
work lands**, not the pane's cwd: a session that runs `git worktree add` and edits by absolute
path keeps its pane in the base checkout (five of eight live "main" sessions on 2026-09-08). For
a pane in the base checkout, the key is the checkout of the session's last in-repo edit — edits
are the ownership signal, reads are not. A pane already inside a worktree is explicit intent and
wins as-is. Once that worktree is removed, the session's own PR (the last one it created or
edited) stands in, because landed-and-cleaned-up is exactly when the merged chip matters.

## Rejected

- **A PR card in the thread outranking the changed-files card.** It surfaces state without a tap,
  but competes for the same slot on every session and is loud on the many that have no PR.
- **A per-file `↗` deep-linking into the PR's Files-changed tab.** Elegant, and undiscoverable —
  it lives only inside a diff the operator has already opened.
- **Keying the sidebar PR on the last edit anywhere** — it lands on memory files and scratchpad
  scripts.

## Consequences

- **PR state becomes a kill signal.** A worktree whose PR is already merged renders today as
  ordinary live work; the chip now says `merged`. This was the prototype's main finding and is
  worth more than the link itself.
- **The default branch renders nothing.** It has no PR to open and none to link — an earlier pass
  offered `compare/main`, i.e. merging main into itself. Silence beats a dead row on the repos
  worked directly on main, which is most of the operator's own.
- **`local-only` states it.** Absence would read as "no PR exists" when the truth is "this work has
  never left your Mac".
- No GitHub remote, and a failed `gh` lookup (not installed, network down, auth), collapse
  to `none`, which renders nothing: the exit may be missing, never wrong. Only `gh`'s own
  "no pull requests found" yields `no-pr` / `local-only`.
- The lookup is network-bound, so it gets a 60s TTL rather than `/changes`'s 1s.
