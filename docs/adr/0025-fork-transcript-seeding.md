# 25. Forks are seeded with a copy of the parent transcript

Date: 2026-08-24 (documents a decision shipped 2026-07-24 with the phone fork feature)
Status: accepted; amended 2026-08-26 and 2026-10-09 (an unprompted session keeps its process-owned id)

## Context

`claude --fork-session` writes the fork's JSONL **lazily**: nothing lands on disk until
the fork's first turn. At the Mac that's invisible, because the pane shows the resumed
history regardless. But the phone reads sessions from their transcripts, so a just-created
fork was broken twice over:

- The conversation rendered empty.
- The fork was missing from Home entirely. Discovery blanks a live pane's session id when
  no JSONL backs it (`resolveActiveId`). That rule exists to catch stale pane→session
  files.

`forkSession` blocks until the fork's prompt is live and hands the client the new id, so
the phone opened straight into a session the server then couldn't describe, for as long as
the user took to send the first message.

Every new session has the same lazy window. A session launched with `--session-id` (from
the phone) or from a shell, then left unprompted, surfaced as an id-less row that no route
could open or archive, or didn't surface at all. Seeding can't help there: `claude
--session-id <id>` refuses to start when `<id>.jsonl` already exists ("Session ID … is
already in use", 2.1.246). Only `--fork-session` skips that check.

## Decision

- **Seed forks.** After boot and before any turn, while Claude verifiably hasn't created the
  file yet, `seedForkTranscript` copies the parent's transcript to the fork's path. The path
  is keyed by the cwd the fork actually launched in, which may be the base repo if the
  parent's worktree was deleted. Claude finds an existing file under its session id, treats
  it as the session history, and **appends** the first turn (verified live: no duplication).
  That is exactly fork semantics: shared history up to the fork point, clean divergence from
  the first message. The fork is readable and discoverable the moment `forkSession` returns.
- **The launcher owns the fork's id.** Every fork path (portkey's `forkSession`, the TUI's
  fork key, the sidebar's `f`) mints the fork id and pass it via `--session-id`, and `forkSession` writes the
  pane→session map entry itself. The SessionStart hook
  records the *parent's* id for a `--fork-session` pane (CLAUDE.md gotcha), so waiting on the
  hook would mis-map the pane.
- **The blank-id rule has exactly one exception: the id the pane's live process owns.** A
  known id with no transcript is kept only if it matches the live Claude process's own id:
  its `--session-id` argv, else Claude's per-pid native file
  (`~/.claude/sessions/<pid>.json`, written before the first turn, verified on 2.1.295). A
  stale pane file can't produce an id that belongs to the running pid, so the guard against
  stale mappings isn't weakened. An id learned any other way still resets to `""` when its
  JSONL is missing.
- The seed is best-effort and never throws. If the parent transcript is unreadable or the
  destination dir is missing, the fork falls back to staying empty until its first turn; the
  fork itself still succeeds.

## Consequences

- Each fork costs one copy of the parent's full JSONL.
- The lazy-write behavior is version-pinned (Claude Code ~2.1.x). If a future Claude created
  the file eagerly at boot, the seed would overwrite it with content-equivalent bytes (both
  are the parent history at the fork point), so that failure mode is benign.
- `/clear` writes the new session's JSONL eagerly (2.1.246), so it needs neither mechanism.

## Rejected

- **Waiting for Claude to create the file.** That was the status quo: an empty,
  undiscoverable fork for an unbounded window (until the user's first message), on the exact
  surface that had just asked to open it.
- **Trusting the pane map without a backing JSONL.** The fork would be *listed* but still
  unreadable, and it would punch a hole in the blank-id rule that guards against stale pane
  files. The process-owned-id exception is narrower: it can't match a stale file.
