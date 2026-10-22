# 1. Portkey's changed-files view is a glance surface, not a review surface

Date: 2026-07-20
Status: accepted; amended 2026-08-24 (no thread file preview, chips open no diff)

How the change set is computed, served and rendered: [docs/changed-files.md](../changed-files.md).

## Context

Portkey (the mobile bridge) shows a "Changed files" card at the end of a session thread, a
full file list, and a per-file diff. The obvious way to grow it is toward code review —
reading arbitrary files, line numbers, syntax highlighting, search, per-file "viewed" marks,
a diff shown before you approve an `Edit`.

That growth direction assumes the phone is where changes get reviewed. It isn't. The
operator runs Claude in auto-accept mode and approves tool calls by default, deliberately, so
the agent isn't blocked waiting on a human. The review gate is the GitHub pull request, read
later at a desk. On the phone the question is never "is this code correct?" — it's "is the
agent doing roughly the right thing, or should I redirect it?"

## Decision

The changed-files view is scoped to **situational awareness**. It optimises for being
correct and cheap to glance at, not for depth.

In scope: the file list, per-file status and LOC delta, the per-file patch, and an honest
statement of what the numbers are measured against.

Explicitly out:

- **A diff on the approval card.** The operator approves by default; a diff at that moment is
  friction at a point they have chosen not to think. (`old_string`/`new_string` are already
  on the device, so this stays cheap to revisit if the working model changes.)
- **Reading files the session didn't change** — `repoTree()` / `readRepoFile()` were in the
  original plan and cut during implementation. This ratifies that cut.
- **Line numbers, syntax highlighting, search, filtering, per-file viewed state, split view,
  word-level intra-line diff, comment threads.** All serve review depth.
- **A file preview in the thread strip.** The list is ordered latest-modified, so its first
  rows are an arbitrary sample — and a sample at the end of a conversation reads as a summary.
- **Per-edit diffs from Edit/Write chips.** A chip's path often can't resolve inside the
  session's repo, and branch-vs-base is time-skewed for old chips. The changed-files page is
  the one diff surface.

Because a glance is exactly the mode where nobody double-checks, any surface that can show a
**wrong or empty picture with no signal that it is wrong** is a defect of the highest class
here — higher than any missing capability.

## Consequences

- Correctness and honesty work gets prioritised over capability work: literal pathspecs,
  a hunk-aware patch parser, a verified `origin/HEAD`, fetch failures that hold the last known
  list instead of asserting "nothing changed", and both endpoints containment-guarded to the
  session's repo root (`safeRepoPath`).
- The phone will keep saying less than a real review tool. That is the intended trade.
- If the operator's working model changes — reviewing from the phone, or approving
  selectively — this decision should be revisited before any of the "out" list is built.
