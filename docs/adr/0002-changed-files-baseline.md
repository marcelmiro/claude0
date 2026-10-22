# 2. The changed-files baseline is the merge-base, and it is stated in the UI

Date: 2026-07-20
Status: accepted

How the baseline and change set are computed: [docs/changed-files.md](../changed-files.md).

## Context

"Changed files" has to be measured against something, and the phone shows the totals next to
a session's conversation — which invites reading them as *what this session did*.

Three candidate baselines:

1. **`HEAD`** — uncommitted work only. Once the agent commits, its work vanishes from the
   phone and the session looks like it did nothing.
2. **`@{upstream}`** — for a pushed feature branch that resolves to `origin/<same branch>`,
   so the merge-base is the branch tip and the view collapses to unpushed-only.
3. **Merge-base with the default branch** (`origin/HEAD`, else a local `main`/`master`/…) —
   the "PR view": everything on this branch that isn't on the base, committed or not.

A fourth option is not a baseline at all: derive the change set from the `tool_use` file
paths in the transcript, to show only what *this session* touched.

## Decision

Diff from the **merge-base with the repo's default branch** to the working tree, and include
untracked files as all-additions (`baseRef` / `changedFiles` in `core/repo-files.ts`).

Reject transcript-derived attribution. It silently drops every Bash-driven mutation
(formatters, codegen, `git mv`, lockfiles), every subagent edit (separate transcripts), and
everything from a compacted earlier session. A confidently-incomplete change set is worse
than an honestly-labelled superset.

Since the data is therefore a superset — the branch's work, including your own earlier edits
and any parallel session in the same worktree — **every surface states the baseline**:
`branch vs base` on the card and the file list, and in the empty-state copy ("No changes vs
main."). Fixing the label was chosen over narrowing the data.

## Consequences

- A session that has committed its work still shows it. A session in a shared worktree shows
  its neighbour's work too, and says so.
- When no base branch can be discovered the code falls back to `HEAD` and labels it `HEAD`,
  rather than implying a full branch diff.
- The label is load-bearing, not decoration: changing the baseline means changing the copy.
