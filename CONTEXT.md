# Claude0

Terminal TUI + mobile bridge ("portkey") for managing Claude Code sessions. This glossary pins the canonical terms; `CLAUDE.md` covers architecture and `docs/adr/` covers decisions.

## Language

**Session**:
One Claude Code conversation, identified by its UUID, backed by a transcript JSONL on disk.

**Archived session**:
A session with no live Claude process; its transcript remains on disk and it can be restored.
_Avoid_: closed, dead, old session

**History**:
The archive surface: every archived session Claude still retains, browsable by recency and searchable. Not time-windowed.
_Avoid_: archived list, archive view

**Restore**:
Resuming an archived session in a new tmux window (`claude --resume`), waking it back to live.
_Avoid_: resume (reserved for Claude's own CLI flag), reopen

**Restore states**:
*Restorable* — the session's original directory exists; restores in place. *Relocated* — its worktree is gone but the base repo exists; restores in the base repo. *Non-restorable* — base repo or transcript is gone; readable but not restorable.

**Role**:
What a machine does in a claude0 deployment, declared per-install in its config: *host* (owns tmux, the sessions, the daemon, the bridge, the inbox) or *client* (the human-facing terminal and alert surface — Ghostty, banners, desk presence). The default deployment is one machine holding both roles (local); a remote deployment splits them (Linux host, Mac client). Exactly one machine holds the host role at a time.
_Avoid_: mode (a deployment is the *pair* of role assignments, not a single switch)

**Inbox**:
A view over sessions grouped by lifecycle state. An inbox item *is* a session (keyed by its UUID) — there is no free-standing work-item object, and no item without a transcript.
_Avoid_: work item, task, thread

**Disposition**:
The authored lifecycle state of a session in the Inbox: *snoozed* (carries an `until` date) or *blocked* (carries a free-text note). Absence of a disposition is the normal case. Orthogonal to activity status, which is always derived, never authored. Setting a disposition archives the pane: a live pane exists only for sessions actively working.
_Avoid_: done (not a state — archiving is the done verb, History is the done pile)

**Parked**:
The Inbox section holding snoozed and blocked sessions, always expanded (a collapse toggle existed in the prototype, was never used, and was removed). A snoozed session whose wake date arrives leaves Parked and resurfaces in Needs you, marked as returned-from-snooze.

**Needs you**:
The Inbox section for sessions awaiting a human response — every live session sitting at a prompt files here, plus snooze wakes and turns that finished while unattended. The aim is to clear it by actioning each item. An item leaves only by reply/approve (observed as a derived status transition), snooze/blocked, or archive — never by focus, glance, or notification tap. No silent decay. (A transition-gated admission with a neutral "Open" section existed briefly and was retired 2026-08-12.)

**Recently done**:
Derived-archived sessions from the last 24h, shown muted at the bottom of the Inbox. Purely derived — no authored state.

**Safeguard row**:
An archived-labeled row kept on the live sessions list because it is pending or unread — covers discovery transiently mislabeling a live blocked session as archived.

**Junk floor** (rejected):
A proposed filter hiding sessions with no assistant reply. Decided against: History shows everything except naming sessions and sidechains.
