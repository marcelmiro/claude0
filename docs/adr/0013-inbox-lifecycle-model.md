# Inbox: sessions carry a lifecycle, panes exist only for active work

Keeping a tmux pane open was the only way to remember a session — "come back in a few days," "blocked on X," "forgot to reply" all meant leaving a window up, which bloated the bar to 15–20 windows and made silent loss routine (a glance cleared ⚡, then the session aged out of sight until a manual sweep found it). We decided the inbox item **is** the session (keyed by UUID — no free-standing work-item object, no item without a transcript), with one thin layer of authored state on top of the always-derived activity status: a **disposition**, either *snoozed* (`until` date, day granularity) or *blocked* (free-text note). Everything else stays derived.

The load-bearing rules, each a real trade-off:

- **"Done" is not a state.** Archiving (kill the pane) is the done verb and History is the done pile; a muted "recently done" tray is just the derived 24h archived window. An authored `done` would duplicate History and rot.
- **Setting a disposition kills the pane, no keep-the-pane option.** A live pane exists only for sessions actively working. Restore (already solved, including relocated worktrees) is the way back. This is what shrinks the window bar; an opt-out would split the model in half.
- **Nothing leaves "Needs you" by being looked at.** Only reply/approve (observed as a derived status transition), snooze/blocked, or archive dispose an item — never focus, glance, or notification tap. A `ready` session with no reply nags indefinitely; no silent decay. The macOS notification may still quiet on focus (bell ≠ list).
- **A snooze wake is a full attention event** — it re-enters Needs you and rides the notification tiers (push routed to the device that set the snooze). A wake that only mutates a list recreates the original forgetting.
- **Lifecycle sections are the primary axis; repo demotes to a row label.** The pain is lifecycle-shaped, not repo-shaped. Sections: Needs you (oldest first) → Running → Parked (collapsed count) → Recently done (muted).

Rejected: a free-standing work-item/task object (first step toward a second, worse Linear — the escape hatch for idea-without-a-session is a Linear ticket that links to sessions); priority/relevance scoring (no natural signal at 10–20 self-spawned sessions; an opaque ranking that can't be trusted forces a full rescan and is net negative — pinned repos plus oldest-blocked-first is the whole ordering); authored read/unread (derived status self-updates, so the only non-derivable fact is the deferral decision, which snooze already is).

Rollout: model + Mac verbs + tmux sidebar prototype first (the Mac is ~90% of usage and the popup TUI failed for being modal — an inbox must not require deciding to look); portkey's rich Inbox UI second; the popup TUI likely obsoleted rather than upgraded. The sidebar is additive: alt+bracket window cycling is untouched (and improves by subtraction as parked panes die); sidebar keybindings and the per-window-pane seam are explicitly prototype-territory, not committed here. A separate-terminal-window dashboard was rejected because Claude0's dependency contract is tmux + Bun only.

## Follow-up (required to fully launch): session provenance

Two workflows create parent→child session relationships that today live only in the user's head (approximated by placing tmux windows adjacent): **forks** (parallel related work) and **handoffs** (fresh unbiased context for a delegated subtask, with the intent to return to the orchestrator once it lands). The inbox should group linked sessions and close the "go back to the orchestrator" loop. Deferred past the prototype week because its payoff is a wake rule *into* the disposition model, which must exist first.

- **Capture at creation, never infer post-hoc.** Forks are free: `forkSession` and the TUI `f` key mint the child id themselves and just record the link. Handoffs need one line of cooperation from the handoff skill (stamp the parent session id into the doc, or drop a pending-link record that discovery resolves when a session cites that doc). Post-hoc inference is the fragile version — first prompts compact away, docs get deleted, and a fork's JSONL is a pre-seeded copy of the parent's, so content similarity is useless.
- **Storage: one file per child** (`~/.config/claude0/links/<childId>.json` → `{parent, kind: fork|handoff, createdAt}`), matching the `verdicts/` per-file pattern to avoid shared-JSON write races. One level of depth is modeled; chains render as chains.
- **Grouping:** children nest under their parent with a `↳`, exactly as worktrees nest under their base repo. Replaces the tmux-adjacency habit with something that survives window reordering.
- **Wake rule (handoffs only):** handing off leaves the orchestrator *blocked on the child*; when the child is **archived** (the done verb — the natural end of divide-and-conquer), the parent wakes into Needs you with a "child finished" reason, same derived-wake shape as a snooze wake. Forks get grouping only — neither side waits on the other — which is why `kind` exists. Rejected: auto-switching to the parent or auto-feeding the child's result into it; waking into Needs you is enough, the human decides when to context-switch.
- **Phase 1 forward-compat hook (the only part to build now):** the `blocked` disposition's note field must be able to hold a session ref, not just free text.

## Addendum: settled by the sidebar prototype (2026-08-07/08)

Two days of living in the prototype against real sessions settled the open questions and revised one original rule. What follows is decided; the prototype (`prototype/inbox-sidebar/`, branch `inbox`, throwaway) is the evidence, not the implementation.

**North star — Claude0.** The product thesis crystallized: Claude0's aim is inbox zero for agent sessions. "Needs you" is not a dashboard section, it is *the inbox*, and the game is clearing it — every verb (reply, snooze, block, done) is a way of getting a row out of it, and an empty Needs you means you are genuinely free. This framing — where the name **Claude0** comes from — should drive prioritization: anything that makes clearing feel fast and trustworthy is core; anything else is chrome.

**The original rule stands: every disposition (and done) kills the pane** — we briefly revised this to let snooze keep its pane, then reverted: what makes killing safe for the most common verb is that **a snooze wake auto-reopens the pane** (detached `claude -r` in a `⚡`-named window, no focus steal — day snoozes fire at local midnight, so the morning window bar *is* the morning inbox). Snooze means "it literally comes back", which is stronger trust than a list entry, and the window-bar shrink applies to all parked states, not just the long-lived ones. The pane↔row relationship is **one-directional**: live pane ⇒ inbox row, but rows outlive panes (parked, recent, restored-from-done), and re-engaging a pane-less row resumes it on demand (`claude -r` in a new window, directory via `resolveRestoreTarget` — deleted worktrees land in the base repo with the transcript consolidated). Undo-done deliberately does *not* resurrect the pane; only re-engagement does.

**Done is a toggle.** `e` archives (RECENT, 24h derived window, then History); `e` on a RECENT row un-archives back into Needs you, pane still closed. On a live session the archive is a double-tap confirm because it also closes the pane — the first real mutation, guarded like the TUI's kill.

**Ages are time-in-state, stamped by observation.** A transition the poller witnesses stamps `now`; only first sight falls back to transcript timestamps (which can lie — see gaps). Needs you sorts oldest-ignored-first and ages from when the session handed you the turn; a >1d age renders loud. Running ages from the user's last prompt ("how long on my instruction"). Script-wait (`⧗`) is its own running *mode* aged from the turn→script handover, because "is this wait normal or wedged" is the question it answers. Snooze wakes show relative on the row, exact on the detail line; hours exact, days at local midnight.

**Needs you must be transition-gated (decided here, not yet built).** The prototype imports every prompt-sitting session into Needs you at first sight, which makes the inbox "all live sessions" instead of "unhandled events" — the first thing that felt wrong in use. Production gates entry on observed transitions, seeded from the monitor's existing attention flags so the inbox and the ⚡ system cannot disagree.

**Interaction grammar.** Unfocused, the sidebar is a pure glance surface (no chrome, pinned to top). Focus (M-s) is instant — the toggle command signals the sidebar process directly rather than waiting on its poll — and the selector lands on the session of the pane you came from. Two independent marks: the *pin* (`▎`, white — location, deliberately not a status color) on the session in this window's active pane, and the *selector* (row background) only while focused. Clicks are focus-gated: the first click on an unfocused sidebar only focuses and selects (absorbs macOS app-focus click-through); a focused click navigates. `J`/`K` jump sections. Verbs are section-scoped; RECENT takes only `e`.

**Per-window panes are an acceptable chassis for glance parity, not for production.** With change-gated renders (repaint only when inputs change, invisible windows included so switches land current) and self-terminating orphans (a sidebar that becomes its window's only pane exits, restoring native close semantics), N per-window panes are visually indistinguishable from one fixed sidebar. What disqualifies the chassis at production scale is cost, not correctness: ~39MB × N blessed processes. Production is one renderer writing ANSI to the pane ttys. Nested tmux and an out-of-tmux window remain rejected.

**Visual language.** Glyphs are the measured-1-cell set only (emoji are double-width in tmux, single-width to blessed — repaints corrupt); status lives in section color tiers (white attention / mint activity / dim parked+done); peach appears only as signal (reason glyphs `! ? ↺`, stale ages), never as paint. Rows: two-line (name + dim repo/PR) in Needs you and Running, one-line elsewhere. `☾` = snoozed, `✗` = blocked, `⧗` = script-wait.

**Known gaps production must close (in rollout order):** durable state under `~/.config/claude0` (the prototype's `/tmp` state file triples as store/IPC/cache and dies on reboot — disqualifying); the single-renderer chassis; transition-gated Needs you; then the transcript-blind activity cases — a session whose work happens outside its own transcript (background-job child sessions, desktop-app sessions with no pane) reads as stale/invisible today and belongs in the same family as `⧗` and provenance: "activity the pane's transcript can't see."

## Addendum 2: settled by the prototype week (2026-08-08 → 11)

A week of daily-driving revised two earlier calls and settled the rest of the interaction grammar. The wake loop is validated live (twice, including the failure mode below); these are decisions, with the prototype as evidence.

**Parked is always expanded** — revising this ADR's "collapsed count" default. The collapse toggle existed, was never once used, and was removed: Parked at real volume (~5 rows) is glanceable, and hiding it made snoozed work invisible in exactly the way the inbox exists to prevent. Within Parked, snoozed sorts before blocked; snoozed by soonest wake first, blocked by least-time-blocked first. The two stay visually distinct groups — mixing was rejected because a future wake time and a past block start share no coherent sort key.

**Snooze grammar is digits-then-unit, digits required** (`16h`, `3d`; the unit letter commits instantly, no Enter). A bare-unit-means-1 shortcut was tried and removed: with muscle memory from an earlier two-stage menu, `s h` committed a 1h snooze instantly — and a snooze kills the pane, so a mistyped key was a destructive act. Amount-first is the guard: no digits, no commit, just a nudge.

**Dispositions walk the view.** Every disposition (done/snooze/block) moves the selector to the row *under* the disposed one, and the shown window follows: the display switches to that next session's window, focused in its sidebar. Triage never exits the inbox — clearing five sessions is five verb-keys, each one a guided step to the next window. Disposing the session you're currently looking at navigates *before* its window dies, so the walk is flicker-free even when it kills the ground under you.

**Clicks are select-then-commit** (refining Addendum 1's focus-gating): a click on an unfocused sidebar focuses and highlights the row hit (no row → the window's active session); a focused click on a non-highlighted row moves the highlight; only a click on the already-highlighted row navigates. Mouse navigation costs 2–3 clicks and can never switch windows by accident.

**Visibility is a global toggle** (`M-S`): hide kills every sidebar pane and stands down all self-heal paths until shown again; the hidden state survives server restarts; showing lands focused in the current window's sidebar. Full-width when needed, one keystroke back.

**Fork places beside the parent** (`new-window -a` at the parent's window), matching the TUI's fork placement — related work stays adjacent until provenance grouping replaces the adjacency habit.

**Wake duty belongs to a launchd-kept-alive daemon, not the status-right monitor.** The monitor is a fresh process per `status-right` tick, and tmux evaluates the status line only while a client is attached — a midnight wake with no terminal open would silently not fire. The daemon (installed idempotently by `claude0 setup`) owns the wake pass: due snooze with no live pane → detached `claude -r` with an in-pane wake banner, mark auto-resumed, write the wake event. It is also the model's **single snapshot producer** (renderers and verbs never write discovery state) — the same long-lived process the single-renderer chassis needs anyway. The status-right monitor keeps prefixes and window naming; consolidating its discovery into the daemon is deliberate follow-up work, not part of the wake cutover.

**The wake attention stamp must wait for detected status `ready`.** Claude's boot spinner reads as `running`, and the monitor's carry-over clears attention for running sessions ("user already interacted") — the first live wake lost its ⚡ to exactly this. Stamp only once the prompt is live.

**Wake notifications: banner now, push deferred.** A wake raises the macOS banner and the ⚡/status-right/`claude0 next` tiers. Web Push does *not* fire — refining this ADR's "push routed to the device that set the snooze": until an inbox surface exists in portkey, every snooze is Mac-set and a push tier is dead code. The recorded design for when that surface lands: route to the setter device when the snooze was set from portkey; for Mac-set snoozes, broadcast to subscribed devices whose SSE liveness is stale (a scheduled wake is an alarm the user set, not ambient noise).

**Self-heal is part of the contract.** A per-pane chassis dies with the single renderer, but what the week proved must survive productionization as `claude0 setup`-installed pieces: autostart on client attach (marker-gated so an explicit hide wins), reclamation of resurrect-restored corpse panes, and per-window heal of missing/mispositioned/mis-sized sidebars. A sidebar that only works until the next reboot reads as broken, not as a prototype.

## Addendum 3: shipped semantics + direction (2026-08-12)

M1–M3 are in production (wake daemon, single-renderer sidebar, transition
gating). Decisions made while shipping, and the roadmap decisions that
followed:

**Needs You admission rules (M3, as built).** Admission = an OBSERVED
transition (discovery watches a session go running→ready/waiting and stamps
the row + writes a `transition` event), a snooze wake, a LIVE approval
prompt (present-tense evidence, unlike sitting at a ready prompt), or a
derived finish (a `finishAt` passing IS the transition). A reply — the
session observed running again — resets admission. A one-time seed from the
monitor's ⚡ flags aligned inbox and attention system on day one. Everything
else files under **OPEN**: a neutral, dim, one-line section — visible, not
nagging, all verbs still apply. Measured motivation: before gating, 9 of 9
Needs You rows existed but only 1 was backed by a real event.

**Status-right is activity only.** It renders `⚡N 🔄N`: sessions needing the
user and sessions currently running. A later `✓N` cleared-today scoreboard
was tried and removed; completed work should disappear instead of leaving a
persistent counter that looks like another live-session state.

**The sidebar is the popup TUI's replacement, not a companion.** Confirmed
(this ADR's rollout section guessed "likely obsoleted"): triage logic lives
in ONE surface. Rejected on those grounds: verbs in the TUI space-menu
(dead surface) and standalone CLI verbs (`claude0 snooze <fuzzy>` — clutter;
if provenance work needs a programmatic verb entry point, it ships as that
feature's plumbing, not as a user command).

**Portkey migrates to an inbox system eventually, not now.** When it does,
wake Web Push un-defers with the routing rule from addendum 2 (setter
device when portkey-set, stale-liveness broadcast when Mac-set).

**Remaining, in order:** live with the honest inbox (does Needs You earn
trust; does clearing pull); ⚡/Needs-You event-source convergence; then
provenance (fork/handoff links table already exists, `↳` grouping,
handoff wake rule: child archived → parent wakes).

## Addendum 4: OPEN retired — every prompt-sitter is Needs You (2026-08-12)

The transition-gated admission (addendum 3) lasted zero days of real use.
Lived-with verdict: a live session sitting at a prompt IS unfinished
business, and filing it under a dim OPEN section just hid rows that still
wanted a decision. `sectionOf` now sends every non-running, non-parked,
non-archived live session to Needs You; the aim is to clear the section by
actioning each row (reply, snooze, block, done). The `needsYou` flag, the
one-time ⚡ seed, and the OPEN section are gone; observed running→ready/
waiting transitions are still written as `transition` events for history,
and the derived-finish and wake rules are unchanged.

Same day, the resume paths earned their first real fixes (all found by
walking the reported bugs): dead-pane probes moved off `display-message`
(exits 0 against a fallback pane on tmux 3.7b) onto `list-panes`; snapshot
rows preserved without a live pane get their stale `real` stripped so Enter
resumes instead of selecting a reused window index; window spawns from the
tty-less daemon must be `-d` (non-detached never returns) and single-string
(multi-arg is direct-exec'd shell-less — no PATH, no claude); `switchTo`
switches any client attached to a different tmux session (a pane in an
unattached session is otherwise invisible — the resurrect incident left
exactly that); and the renderer respawns all stub relays at stand-up (a
stub outliving a renderer restart eats one keystroke per pane to notice
its socket died).

## Addendum 5: the VM cutover story (2026-08-12, grilled)

Settled against ADR 15/16's single-host cutover, built ahead of it:

- **One host owns the inbox.** The daemon becomes `claude0-daemon.service` on the
  VM (provision-installed, BindsTo=tmux.service); the Mac launchd agent is
  booted out at cutover as a runbook teardown step. Two daemons against two
  tmux servers would mean two divergent inboxes — a multi-host inbox was
  refused as speculative design.
- **`inbox.db` rides the state copy** (WAL checkpointed first, daemon
  stopped): a snooze pending at cutover is a promise and must wake on the VM.
  Repo paths inside stayed valid via /Users parity (retired since — see
  ADR 15); the snapshot table self-rebuilds on the first discovery tick.
- **Off-darwin wake alert = broadcast Web Push.** The banner tier cannot
  exist on a headless host; the wake pass broadcasts to every subscribed
  device there (a snooze set days ago has no meaningful driving device —
  same reasoning as `claude0 notify` ops alerts). This replaces an impossible
  tier rather than un-deferring the general wake push of addendum 2, which
  still waits for the portkey inbox.
- **Unit ownership stays split by platform**: provision.sh owns systemd
  units (like bridge/monitor), `claude0 setup` owns launchd and no-ops off-darwin.

## Addendum 6: the portkey inbox (2026-08-18, grilled)

Portkey's Home migrated to the inbox, as addendum 2 anticipated. Settled:

- **Home IS the inbox** — the sectioned list replaces the repo-grouped list
  rather than sitting beside it. A transitional `localStorage` toggle keeps
  the classic view during rollout; it dies once the inbox has been lived
  with. The navbar ⚡/🔄 chips are gone in inbox view: section header counts
  answer the same question in place.
- **The bridge serves sections pre-derived from the store** — one section
  brain (`composeSessions` → `deriveSections`) for the sidebar and the
  phone, so the two surfaces cannot disagree. The bridge's own discovery
  contributes row detail only (pending, unread, scripts, names), joined by
  id; discovery-only newborns map directly from status until the daemon's
  next tick snapshots them. Re-deriving sections bridge-side from its own
  discovery was rejected: two derivations drift.
- **Verbs live in the long-press sheet**, one tap deep — snooze presets
  `1h / 4h / Tomorrow 8AM / 3d / 7d`, block with a free-text note (empty
  allowed), unpark, un-archive. Disposing from an open thread returns to
  the list: the inbox-zero loop is action-and-move-on.
- **Day-snooze semantics fork by surface** (user-decided): phone day
  presets anchor at **8AM local** on the target calendar day — a
  days-long park should greet the morning, not midnight. The Mac's
  digits-then-unit day snoozes became **exact relative** (1d = 24h from
  now) at the same moment — a deliberate revision of the shipped
  local-midnight rule, re-confirmed when flagged; `fmtWakeAbs` grew a time
  part for >24h wakes accordingly.
- **The wake push targets the setter device.** The snooze disposition
  records which portkey device set it (`device_id`, null = Mac-set); when
  it comes due, the wake pass pushes to that device on either daemon
  platform (darwin keeps its native banner beside the push — banner-only
  would wake the Mac for an alarm the phone asked for). Mac-set snoozes
  keep the platform behavior of addendum 5: banner on darwin, broadcast
  off-darwin. This narrows addendum 2's deferred "general wake push" to
  the one case that now has a meaningful target.
- **Phone archives now write the store's Done fact.** The bridge's
  `/archive` only killed the pane before, so phone archives never reached
  RECENT. The store write is gated on the kill succeeding or the row being
  pane-less per the bridge's own discovery — never blanket no-pane, which
  would mark a live session done on a pane-resolution race.
- **No History surface in v1** — Recently done keeps its 24h window; the
  existing History screen remains the windowless archive.
## Addendum 7: question band, Enter grammar, peek (2026-08-18)

Three grammar revisions from living with the sidebar, all shipped together:

**Needs You is two bands.** An open question/approval floats above plain
prompt-sitters (answering one unblocks compute; a ready session just waits
for more instructions), oldest first within each band. The band lives in
`deriveSections` so every inbox surface inherits it; discovery stamps
`reason: "question"` from the hook log's pending AskUserQuestion — the same
source as the bridge's `pendingKind`, so the phone and the sidebar agree on
what sits on top. Portkey's client-side re-sort becomes a no-op and gets
deleted on its own branch. Rejected alongside: surfacing session *content*
(question text, last-message gists) in rows or on highlight — the inbox
stays labels-only.

**Enter is select-then-commit, like clicks.** Enter on a row in another
window shows that window and lands focused in *its* sidebar with the row
selected; Enter on the current window's row commits into the session pane.
Navigating N sessions is N Enters without ever re-focusing the sidebar. A
pane-less row resumes into a new window and lands in that window's sidebar;
a second Enter before discovery stamps the new pane commits into the spawned
window (`resumedWindows`) instead of double-spawning.

**Enter on Parked/Recent is a peek, not a re-entry.** The disposition/
archive stays put — the row keeps filing where it was — and a `peeks` store
record marks the window provisional. Engagement is *a prompt newer than the
peek* (`peekEngaged`): discovery's reply-observed clear is gated on it,
which also fixes a real bug — a `claude -r` boot spinner reads as running,
and a preserved row's `real` is undefined, so first sight always counted as
a transition and silently unparked the row within one tick. The renderer
reaps a peek window unviewed for 60s (`PEEK_GRACE_MS`), after a final
transcript check so a prompt whose whole turn fit inside one discovery tick
still graduates the row instead of dying with the window. A due snooze
files under Needs You, so the reaper drops the record and *keeps* the
window — never kill what demands attention. Explicit re-entry stays `b`
(unpark); explicit restore stays `e` on Recent. "Reply observed" has one
implementation, `store.replyObserved` (peek + disposition + archive in one
transaction), shared by discovery's gate and the reaper. Deferred, recorded
in ideas.txt: `x` dismiss (archive with no RECENT trace).

## Addendum 8: freshness around the 3s snapshot, and process shape (2026-08-24)

Cross-process rules settled while shipping addenda 5–7, recorded because no
single file can state them:

**Two freshness aids bridge the daemon's 3s snapshot lag.** The section tag is
authored store-side and trails reality by up to a tick, while a row's effective
status is overlay-then-live-capture fresh — so the phone *renders* a row under
the section its status implies when the two disagree (`displaySection` in
`shared/sync.js`), never rerouting parked/done (those sections are authored by
verbs, not derivable from status) and keeping `⧗` script-waiters in Running.
And the bridge polls the store's `data_version` every 1s while stream clients
are connected, re-projecting and pushing when the daemon's snapshot commits —
without it a section flip sat unpushed until the next hook event, which for a
text-only turn is the whole turn away.

**`inboxStale` is a banner, not a blocker.** A snapshot older than 10s (or
absent) flags the `/sessions` payload; verbs still work, because authored
facts live in the store and only the activity snapshot is daemon-owned. Rows
the snapshot misses degrade instead of vanishing: a pane-less parked/done id
outside discovery's window gets a minimal projected row plus its
`restoreState`, and a discovery-only newborn (born since the last tick) maps
directly from status — running → Running, live prompt-sitters → Needs You —
with a *stable* age anchor (the session's last turn, never a per-recompute
`now`, which would make every payload differ and self-sustain the
change-push cycle indefinitely while the daemon is down).

**Snapshot ownership is single-writer with one seeded exception.** Discovery
owns the snapshot table. The bridge's `seedSnapshotRow` — needed when a verb
lands on an id discovery has never snapshotted, whose fact would otherwise
have no row to overlay onto — is insert-if-absent only, and stamps
`updated_at: 0` so a bridge-side seed can't mask a dead daemon in the
staleness probe. `saveSnapshot`'s replace keeps fact-holding rows the new set
doesn't cover, so a verb landing mid-tick survives the wipe. On the wake side,
`markAutoResumed` is an atomic claim (the UPDATE's WHERE clause is the lock):
overlapping wake passes, or a stray second daemon, can't double-spawn a pane.

**Process shape follows two measured costs.** Discovery runs as a fresh child
process per 3s tick (`claude0 daemon --discover-once`): an in-process loop
leaks ~1.5 MB/s that JSC never returns, so the long-lived daemon only spawns
and reaps. The sidebar stubs are shell lines (`sh`+`nc`+`cat`, ~1 MB), not
bun processes (~30 MB each — more than the blessed chassis the renderer
replaced). The renderer self-installs its tmux wiring on stand-up and every
~30s rather than via tmux.conf: a tmux server restart is rewired within a
tick, with no dotfile dependency.

## Addendum 9: snooze mini-form, the `t` unit, and one wake renderer (2026-08-24)

**The digits-then-unit grammar (addendum 2) is superseded by a two-line
mini-form.** `s` opens it in the sidebar chrome: a unit-block row (`t 8am`,
`d day`, `h hr` — ordered most-to-least used; Tab cycles, the unit letter
selects directly) above an amount field with a live resolved-wake preview.
The amount starts as a dim overwritable placeholder `1` — typing replaces
it — so a bare Enter is a 1-unit snooze. Enter commits, Esc (hinted `⎋`)
cancels, stray keys are inert, unfocus cancels. Addendum 2's mistype guard
(no digits, no commit) is replaced, not dropped: the unit letter no longer
commits instantly — nothing does until Enter, with the preview showing
exactly what will be committed.

**`t` is the morning anchor**: 8AM local on the +N calendar day, built from
local calendar components so a DST shift still yields wall-clock 8AM. The
phone's day presets (Tomorrow 8AM / 3d / 7d) now share its math
(`presetWakeAt` delegates to `wakeAt(…, "t")` in `core/inbox-model.ts`), so
addendum 6's semantics fork narrows to a unit choice on one surface: `h`/`d`
stay exact relative (1d = 24h), `t` and the phone presets are
morning-anchored. Earlier addenda's "days at local midnight" no longer
applies anywhere.

**One absolute-wake renderer.** The form preview, the parked detail line,
the commit flash, and the phone's new snooze toast (`/snooze` returns
`wakeAt`) all render through `shared/wake-abs.js`: same local day → time
only ("9AM"), under 7 days → weekday + time ("Tue 9AM"), 7+ days → dd/MM +
time ("26/09 9AM"). The format is hard-coded English dd/MM 12-hour by
decision — Intl was tried and rejected because Bun ignores `LANG` for its
default locale and ICU builds disagree on locale data (en-GB's hour cycle),
so locale-sensitive Intl formatting is never relied on in this repo.

**Phone snooze on a running session takes a confirm** — one tap killed an
in-flight turn; the toast makes the resolved wake visible after any
one-tap disposal. Parity with the sidebar, which hides snooze on Running
rows entirely.

Also recorded: a double-click on a sidebar row commits with the session
*pane* focused ("take me there"), unlike keyboard Enter, which keeps the
sidebar focused so the next Enter continues the queue (`switchTo` in
`sidebar/renderer.ts`). And a scope decision from living with the inbox:
it is an additional way to navigate, not a replacement — the tmux ⚡-prefix
/ `claude0 next` flow is deliberately kept, not discontinued.
