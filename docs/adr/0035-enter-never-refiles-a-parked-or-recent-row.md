# 35. Enter never re-files a parked or recent row; peek is removed

Date: 2026-11-05
Status: accepted; amended 2026-11-05 — search's Enter previews, the preview's Enter opens

## Context

Enter on a PARKED or RECENT row used to **peek**. It resumed `claude` in a provisional window
while the disposition or archive stayed in place, and a reaper killed the window if nobody
viewed it for 60s. Peek did two jobs, *looking* at a session and *re-entering* it, and only
re-entering needs a process. Its reaper shipped with four bugs fixed within a day:
- a window reaped mid-turn;
- an unrelated window killed after tmux reused its `@N` id;
- zero grace on a re-peek;
- a due snooze killed while it was asking for attention.

Usage from Aug 19 to Nov 4 was 51 peeks. 19 were look-only, with no later event; 29 led to a
reply.

Making Enter re-enter instead would have turned each look-only open into a chore: a live Needs
You row to archive again by hand. It would also wipe a snooze's wake time on a stray keypress.

## Decision

- **Looking is preview; re-entering is a deliberate verb.** Enter (and double-click) on a PARKED
  or RECENT row opens the read-only preview (ADR 34), with no process and no state change. `b`
  (unpark) and `e` (restore) are the only ways back in. Live rows keep Enter = switch.
- **Search's Enter previews; the preview's Enter opens whatever the state.** Search is a
  deliberate act, and the preview confirms it found the right session before anything spawns.
  The result row shows the state, and a flash names what was cleared, for example "unparked,
  was snoozed until Fri".
- **Every path back in clears inbox state explicitly:**
  - sidebar `b` (unpark) and `e` (restore; it spawns nothing);
  - the preview's Enter, once its window has spawned;
  - portkey's Restore, once `restoreSession` succeeds.
  Clearing only after a successful spawn means a failed open keeps the snooze or block. None of
  them relies on discovery reading a `claude -r` boot spinner as a reply. That side
  effect is accidental. It also hides a session whose archive is older than 24h: the session
  goes live, but its old `archivedAt` keeps it off the sidebar.

## Consequences

- These go: the `peeks` store table, the reaper, `PEEK_GRACE_MS`, and the reply-observed gate in
  discovery. Reply-observed now runs unconditionally.
- Preview has to be good enough to answer "is this the session I want?" without reopening it.
