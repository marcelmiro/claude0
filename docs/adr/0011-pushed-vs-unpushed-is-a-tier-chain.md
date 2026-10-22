# 11. Pushed vs unpushed is a chain of ranges, not a second baseline

Date: 2026-07-28
Status: accepted

How the chain is computed and served: [docs/changed-files.md](../changed-files.md).

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
- `/diff` accepts a tier's `from`/`to` only as a pair its own chain published: the refs reach
  git as a revspec, so a caller-supplied pair could pose as an option.
