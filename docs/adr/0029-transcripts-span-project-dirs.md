# A session's transcript spans project dirs — readers stitch, never pick one file

## Context

Claude Code keys transcript storage on the session's cwd: when the cwd moves between
project dirs (`EnterWorktree`, `cd` across repos), it RE-HOMES the JSONL — a new file
with the same session id opens under the new project dir, only new records land there,
and its first record parents onto a uuid that lives in the previous file. One session,
several files, of which only the newest-written is live.

Portkey read exactly one file per session (the newest by mtime). The active-branch walk
(`parseActiveBranch`) then hit the cross-file `parentUuid` on the new file's first
record, found nothing, and stopped — silently truncating the conversation to the
post-move suffix. A real session showed 12 turns instead of ~1,000.

A second, independent truncation: a `compact_boundary` record continues the conversation
through `logicalParentUuid` (its `parentUuid` is null), but Claude Code sometimes writes
a phantom uuid there — observed on a real manual `/compact`, where the referenced uuid
exists nowhere on disk and the true pre-compact tip (the `/compact` command record) sits
immediately before the boundary in file order. The walk dead-ended and everything before
the compaction vanished, even though it was in the same file, fully parseable.

## Decision

**Stitch, don't pick.** `resolveTranscriptPaths` (core/last-turn.ts) returns every file
holding the session's records, mtime-ordered oldest→newest; `resolveTranscriptPath`
stays the newest of those. The transcript read (`readActiveBranchCached`) streams all
files into one line array — the uuid index then spans the seam and the walk crosses it.
All four piggybacked parsers (branch, background tasks, queue replay, context usage) see
the merged lines: only the newest file was ever appended to, so concatenation IS true
write order, and the queue replay's delivery reconciliation keeps working across the
seam.

**Recover a dangling compact link by file order.** When the walk reaches a
`compact_boundary` whose logical parent is absent (or missing from the index), it
splices to the newest mainline (leaf-eligible, non-sidechain) record written before the
boundary in file order — what `logicalParentUuid` should have referenced. Only a
boundary gets this: an arbitrary dangling parent still stops the walk (the
deepest-intact-suffix behavior is deliberate; generalizing the splice could resurrect
abandoned branches).

**One revision over all files.** `rev` becomes `count:totalSize:maxMtime`
(`combinedRev`), computed identically by the full payload and the `/transcript?rev=`
fast path — a single-file rev would go stale-blind at the flip instant, when the
brand-new file is smaller than the frozen one. The count term covers the flip itself.
A file that vanishes between the glob and the stat (retention cleanup of an old dir)
is dropped from the read, not fatal to it — the survivors still serve, and the 3s
resolve TTL heals the path list.

**Session ids are validated inside the resolver.** They interpolate into the projects
Glob, so `resolveTranscriptPaths` rejects anything but `[A-Za-z0-9-]{1,100}` — no
caller can widen the scan past one session — and the bridge's transcript GET 400s the
same shape check that `/stream/open` already enforced.

**Subagents union.** Each transcript file has a sibling `<id>/subagents/` dir; agents
spawned before a move live under the old one. `listSubagents` takes all paths and
returns the union; the drill-in read tries each dir newest-first.

**Last-prompt boundary falls back.** The newest real prompt is almost always in the live
file; older files are consulted only when the live one holds no prompt yet (the window
between a cwd move and the user's next prompt).

## What stays single-file, and why

Age (`readLastTurnAt`), mark-read, restore, script-wait counts, and the changed-files
cwd all keep reading the live file: their question is "what is happening now", which
only the live file answers. The per-subscription JSONL watcher also watches the live
file resolved at subscribe time — after a mid-subscription flip it watches a frozen
file, but hook-event pushes and safety polls still drive updates, and the next
subscribe re-resolves. The search/history corpus likewise still indexes per file;
history's unit is the file, not the stitched session.

## Costs accepted

Frozen files are re-streamed whenever the live file changes (no per-file parse cache).
Bounded by what one large live file already costs per change, and the invalidation
cadence is unchanged — revisit only if bridge CPU shows it.
