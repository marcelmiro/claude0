# 1. Portkey's changed-files view is a glance surface, not a review surface

Date: 2026-07-20
Status: accepted

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

Because a glance is exactly the mode where nobody double-checks, any surface that can show a
**wrong or empty picture with no signal that it is wrong** is a defect of the highest class
here — higher than any missing capability.

## Consequences

- Correctness and honesty work gets prioritised over capability work. Concretely: literal git
  pathspecs (`literal()` in `core/repo-files.ts` wraps every one as `:(literal)…`) so a
  filename containing glob metacharacters — `app/[slug]/page.tsx` is a real name — can't
  render another file's patch; a hunk-aware patch parser (`shared/diff-lines.js`) so a
  deleted `-- ` line can't be eaten by a file-header pattern — matching git's header
  patterns against every line eats real content; a verified `origin/HEAD` so a dangling
  symref can't silently collapse the view; fetch failures that hold the last known list
  instead of asserting "nothing changed"; and both endpoints (`/changes`, `/diff`)
  containment-guarded to the session's repo root (`safeRepoPath`), so a crafted path can't
  read outside it.
- The phone will keep saying less than a real review tool. That is the intended trade.
- If the operator's working model changes — reviewing from the phone, or approving
  selectively — this decision should be revisited before any of the "out" list is built.

## Addendum (2026-08-24): the glance posture in the rendering

Decisions that keep the surface a glance, recorded because each has a tempting wrong
alternative:

- **The thread strip carries no file preview.** It shows totals, PR state and the baseline
  only. The file list is ordered latest-modified, so the first N of a 144-file branch are an
  arbitrary sample — and a sample at the end of a conversation reads as a summary. It is
  styled as thread furniture (full-bleed, unfilled, hairline-ruled) rather than a filled
  rounded box, because a filled box on `--surface` is exactly an assistant bubble.
- **Edit/Write chips in the thread are informational only** — filename bright, directory
  dimmed. They deliberately don't open a per-edit diff: a chip's path often can't resolve
  inside the session's repo (removed worktree, scratchpad or `~/.claude` edits), and the
  branch-vs-base answer is time-skewed for old chips. The changed-files page is the one
  diff surface.
- **Diffs are re-indented for phone width** (`narrowIndent` in `shared/diff-lines.js`):
  leading whitespace becomes 2 spaces per level, levels preserved, interior spacing
  untouched — a tab-indented repo stops spending 8 columns per level of a ~45-column
  viewport. Display transform only; the patch and the file are unchanged.
- **`/changes` has a 1s stale-while-revalidate cache, and `/diff` reuses it** to resolve a
  rename's old path — a file-list row shows the true rename without carrying the old path
  itself, and without trusting the caller to supply it.

## See also

- [0002 — the changed-files baseline is the merge-base](0002-changed-files-baseline.md)
