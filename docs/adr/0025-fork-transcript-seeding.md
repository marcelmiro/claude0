# 25. Forks are seeded with a copy of the parent transcript

Date: 2026-08-24 (documents a decision shipped 2026-07-24 with the phone fork feature)
Status: accepted

## Context

`claude --fork-session` writes the fork's JSONL **lazily** — nothing lands on disk until
the fork's first turn. At the Mac that's invisible (the pane shows the resumed history
regardless), but the phone reads sessions from their transcripts, so a just-created fork
was broken twice over: the conversation rendered empty, and the fork was missing from
Home entirely — discovery blanks a live pane's session id when no JSONL backs it
(`buildActiveSession`; that rule exists to catch stale pane→session files and can't be
weakened for this case). `forkSession` blocks until the fork's prompt is live and hands
the client the new id, so the phone opened straight into a session the server then
couldn't describe — for as long as the user took to send the first message.

## Decision

After boot and before any turn — Claude has verifiably not created the file yet —
`seedForkTranscript` (`core/session-api.ts`) copies the parent's transcript to the
fork's path: `~/.claude/projects/<cwd with / → ->/<forkId>.jsonl`, keyed by the cwd the
fork was actually launched in (which may be the base repo, if the parent's worktree was
deleted and the launch relocated). Claude, finding an existing file under its session
id, treats it as the session history and **appends** the first turn (verified live: no
duplication) — which is exactly fork semantics: shared history up to the fork point,
clean divergence from the first message. The fork is readable and discoverable the
moment `forkSession` returns.

Supporting mechanism: the fork id is minted by the bridge and passed via `--session-id`,
and the pane→session map entry is written directly by `forkSession` — the SessionStart
hook records the *parent's* id for a `--fork-session` pane, so waiting on it would
mis-map the pane.

The seed is best-effort and never throws: an unreadable parent transcript or missing
destination dir degrades to the old behavior (empty until first turn), not a failed fork.

## Consequences

- Cost is one file copy per fork, of the parent's full JSONL.
- The lazy-write behavior is version-pinned (verified on Claude Code ~2.1.x). If a
  future Claude eagerly created the file at boot, the seed would overwrite it — with
  content-equivalent bytes (both are the parent history at the fork point), so the
  failure mode is benign.

## Rejected

- **Waiting for Claude to create the file** — the status quo: an empty, undiscoverable
  fork for an unbounded window (until the user's first message), on the exact surface
  that just asked to open it.
- **Special-casing discovery to trust the pane map without a backing JSONL** — makes
  the fork *listed* but still unreadable, and punches a hole in the blank-id rule that
  guards against stale pane files.
