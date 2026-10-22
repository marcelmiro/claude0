# 13. Inbox: sessions carry a lifecycle, panes exist only for active work

Date: 2026-08-06
Status: accepted; amended 2026-08-08 → 2026-09-08 by lived-with revisions folded into the Decision and Rejected lists below (a snooze wake reopens the pane, Parked always expanded, every prompt-sitter is Needs You, a daemon owns wakes, portkey's Home is the inbox, Needs You is one band); systemd unit ownership (once provision.sh) superseded by ADR 22 (2026-08-23: `claude0 setup --role host` installs the units)

How the inbox works — store, daemon, sidebar grammar, glyphs, the snooze form, freshness,
process shape (formerly this ADR's addenda) — is in [docs/inbox.md](../inbox.md).

## Context

Keeping a tmux pane open was the only way to remember a session — "come back in a few days," "blocked on X," "forgot to reply" all meant leaving a window up, which bloated the bar to 15–20 windows and made silent loss routine (a glance cleared ⚡, then the session aged out of sight until a manual sweep found it).

## Decision

The inbox item **is** the session (keyed by UUID — no free-standing work-item object, no item without a transcript), with one thin layer of authored state on top of the always-derived activity status: a **disposition**, either *snoozed* (`until` time) or *blocked* (free-text note). Everything else stays derived.

The aim is inbox zero for agent sessions — where the name **Claude0** comes from. Needs You is *the inbox*: every verb (reply, snooze, block, done) is a way of getting a row out of it, and an empty Needs You means you are genuinely free. Anything that makes clearing fast and trustworthy is core; anything else is chrome.

The load-bearing rules, each a real trade-off:

- **"Done" is not a state.** Archiving (kill the pane) is the done verb and History is the done pile; "Recently done" is just the derived 24h archived window, and done toggles back from there. An authored `done` would duplicate History and rot.
- **Every disposition and done kills the pane, no keep-the-pane option.** A live pane exists only for sessions actively working. What makes this safe for the most common verb is that **a snooze wake auto-reopens the pane** (detached `claude -r`, no focus steal) — snooze means "it literally comes back." Letting snooze keep its pane was tried and reverted. Rows outlive panes; re-engaging a pane-less row resumes it on demand. This is what shrinks the window bar; an opt-out would split the model in half.
- **Nothing leaves "Needs you" by being looked at.** Only a reply (observed as the session running again), snooze/blocked, or archive dispose an item — never focus, glance, or notification tap. A `ready` session with no reply nags indefinitely; no silent decay. A notification may still quiet on focus (bell ≠ list).
- **Every live session sitting at a prompt is Needs You.** A prompt-sitter is unfinished business.
- **A snooze wake is a full attention event** — it re-enters Needs you and rides the notification tiers (push to the portkey device that set the snooze; a Mac-set snooze gets the native banner where one exists, broadcast push elsewhere). A wake that only mutates a list recreates the original forgetting.
- **Lifecycle sections are the primary axis; repo demotes to a row label.** The pain is lifecycle-shaped, not repo-shaped. Sections: Needs you (oldest-ignored first) → Running → Parked (always expanded — hiding it made snoozed work invisible in exactly the way the inbox exists to prevent) → Recently done (muted).
- **A kept-alive daemon owns wakes and is the single snapshot producer.** The status-right monitor runs only while a tmux client is attached, so a midnight wake with no terminal open would silently not fire. Renderers and verbs never write discovery state. One host owns the inbox: two daemons against two tmux servers would be two divergent inboxes.
- **One section brain for every surface.** The bridge serves sections pre-derived from the store, so the sidebar and portkey's Home (which *is* the inbox) cannot disagree.
- **The sidebar replaces the popup TUI as the triage surface** — triage logic lives in one place. The inbox is an additional way to navigate, not a replacement: the tmux ⚡ prefix and `claude0 next` stay.

## Rejected

- **A free-standing work-item/task object** — first step toward a second, worse Linear; the escape hatch for idea-without-a-session is a Linear ticket that links to sessions.
- **Priority/relevance scoring** — no natural signal at 10–20 self-spawned sessions; an opaque ranking that can't be trusted forces a full rescan and is net negative. Oldest-ignored-first is the whole ordering.
- **Authored read/unread** — derived status self-updates, so the only non-derivable fact is the deferral decision, which snooze already is.
- **Transition-gated Needs You** (only sessions observed going running→ready; built and retired 2026-08-12) — it filed real decisions under a dim OPEN section.
- **A question/approval band above plain prompt-sitters** (2026-08-18 → 09-08) — a minute-old question floating over a day-old ready session read as the sidebar reordering itself under you. What kind of reply is due lives in the row glyph.
- **Re-deriving sections bridge-side from its own discovery** — two derivations drift.
- **Triage verbs in the TUI space-menu or as CLI verbs** (`claude0 snooze <fuzzy>`) — a dead surface and clutter.
- **Session content in rows** (question text, last-message gists) — the inbox stays labels-only.
- **A separate-terminal-window dashboard, nested tmux, or an out-of-tmux window** — Claude0's dependency contract is tmux + Bun only.
- **A multi-host inbox** — speculative.

## Consequences

- Restore is the only way back to a parked session, so it must always work, including relocated and deleted worktrees.
- The daemon and the sidebar's self-heal are part of the contract: a sidebar that only works until the next reboot reads as broken.

## Follow-up (required to fully launch): session provenance

Two workflows create parent→child session relationships that today live only in the user's head (approximated by placing tmux windows adjacent): **forks** (parallel related work) and **handoffs** (fresh unbiased context for a delegated subtask, with the intent to return to the orchestrator once it lands). The inbox should group linked sessions and close the "go back to the orchestrator" loop. Deferred past the prototype week because its payoff is a wake rule *into* the disposition model, which must exist first.

- **Capture at creation, never infer post-hoc.** Forks are free: `forkSession` and the TUI `f` key mint the child id themselves and just record the link. Handoffs need one line of cooperation from the handoff skill (stamp the parent session id into the doc, or drop a pending-link record that discovery resolves when a session cites that doc). Post-hoc inference is the fragile version — first prompts compact away, docs get deleted, and a fork's JSONL is a pre-seeded copy of the parent's, so content similarity is useless.
- **Storage:** the `links` table in `inbox.db` (child id → `{parent, kind: fork|handoff, createdAt}`, built ahead of the feature). One level of depth is modeled; chains render as chains.
- **Grouping:** children nest under their parent with a `↳`, exactly as worktrees nest under their base repo. Replaces the tmux-adjacency habit with something that survives window reordering.
- **Wake rule (handoffs only):** handing off leaves the orchestrator *blocked on the child*; when the child is **archived** (the done verb — the natural end of divide-and-conquer), the parent wakes into Needs you with a "child finished" reason, same derived-wake shape as a snooze wake. Forks get grouping only — neither side waits on the other — which is why `kind` exists. Rejected: auto-switching to the parent or auto-feeding the child's result into it; waking into Needs you is enough, the human decides when to context-switch.
- **Forward-compat hook:** the `blocked` disposition's note field must be able to hold a session ref, not just free text.

The rules above were settled by a week of daily-driving a throwaway sidebar prototype (2026-08-07 → 11); the prototype branch was not kept.
