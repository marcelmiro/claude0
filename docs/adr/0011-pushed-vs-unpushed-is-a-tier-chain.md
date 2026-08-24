# 11. Pushed vs unpushed is a chain of ranges, not a second baseline

Date: 2026-07-28
Status: accepted

## Context

The changed-files view measured everything against one baseline (the merge-base with the
default branch, [ADR 2](0002-changed-files-baseline.md)), so a file the agent had pushed an
hour ago and a file it had not yet committed rendered identically. On this machine that is not
an edge case: a survey of the seven live repos found un-landed work in six of them, and one sat
80 commits ahead of its own remote branch with nothing anywhere on the phone saying so.

"Has this left my Mac?" could have been answered by a second baseline — swap the comparison ref
for `origin/<branch>` behind a toggle — but a toggle asks the reader to hold two views in their
head and compare them, and it can only ever show one of the two answers at a time.

## Decision

Model it as a **chain** of three adjacent ranges rather than a set of overlapping filters:

    base ──────► origin/<branch> ──────► HEAD ──────► working tree
          pushed          committed,          uncommitted
                          not pushed

Each link is a real git diff range, so each carries its own file list, its own per-file LOC, its
own group total and its own openable patch — the way an editor's SCM panel gives staged and
unstaged their own rows and their own diffs. A file pushed and then edited again appears in two
groups with the churn of *that segment* in each. Groups are always expanded; empty ones are
dropped. The list header therefore states the baseline and no total: summing the groups would
double-count exactly the files the split exists to explain.

Both ref-to-ref ranges use **three-dot** revspecs (`base...origin/<branch>`,
`origin/<branch>...HEAD`), passed as one string. `git diff A B` means `A..B`, which compares the
tips directly and reports everything the far side has and this side lacks as a *deletion* — a
branch whose remote is one commit ahead (pushed from another worktree) grows a phantom `D` row
for a file nobody deleted, and a rebased branch grows one per commit the base moved past.

The comparison ref is `origin/<branch>` **by name**. `@{upstream}` is not it: two repos on this
machine point a feature branch's upstream at `origin/main`, which would report a branch as
hundreds of files out of sync with itself. `@{push}` errors outright on those same two
("cannot resolve 'simple' push to a single destination").

No action ships with it — no commit, no push, no stash. This stays a reading surface.

## Consequences

- This does **not** contradict ADR 2. That decision rejected `@{upstream}` as *the* baseline
  because it collapsed the view to unpushed-only; here unpushed-only is precisely one of the
  three answers, sitting next to the other two. The merge-base is still the outer baseline, and
  every surface still states it.
- It stays inside [ADR 1](0001-changed-files-is-a-glance-surface.md)'s scope: the question is
  "has this left my Mac", not "is this code correct". Depth still lives in the pull request
  ([ADR 5](0005-link-out-to-the-pull-request.md)).
- Detached HEAD and unborn HEAD have no branch to push, so there is no chain — the flat list
  stands alone, as it did before.
- A repo whose remote isn't named `origin` gets no pushed tier and renders as never-pushed,
  rather than erroring.
- The chain costs a handful of extra git subprocesses per `/changes` call, inside the route's
  existing 1s stale-while-revalidate window.

## Addendum (2026-08-24): how the chain is served

- **`tiers` ride the `/changes` payload** (`syncTiers` in `core/repo-files.ts`), so the
  thread card and the file list can never disagree about how far the work has travelled.
  The card trades the PR's LOC for `● N not pushed` — the *distinct* union of the two
  un-landed groups, since a file in both would double-count — or `● never pushed`.
- **`/diff` honours only a `from`/`to` pair its own chain published** (matched against the
  cached `/changes` tiers). The endpoints reach git as a revspec, so a caller-supplied pair
  could otherwise pose as an option (`--output=…`). A pair that no longer matches — the
  chain moved since the list was fetched — degrades to the branch-vs-base diff rather than
  erroring.
- **Routing**: the two ref-to-ref groups go through `rangeDiff`; the uncommitted group goes
  through `fileDiff` with a start-ref override, because a tier ending at the working tree
  still needs the untracked fallback and the NFD/NFC pathspec retry — only its start ref
  moves. Rename resolution is scoped to the tier being diffed: a rename committed but not
  pushed is a rename in one range and an ordinary file in the next.

## See also

- [0001 — changed-files is a glance surface](0001-changed-files-is-a-glance-surface.md)
- [0002 — the changed-files baseline](0002-changed-files-baseline.md)
- [0005 — link out to the pull request](0005-link-out-to-the-pull-request.md)
