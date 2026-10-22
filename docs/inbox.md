# Inbox

How the inbox works: the store, the daemon, the tmux sidebar, and portkey's Home. The
decisions it implements are in [ADR 13](adr/0013-inbox-lifecycle-model.md). Code:
`core/inbox-*.ts`, `src/sidebar/`.

## Store and sections

- **Store.** `inbox.db` (SQLite) under `~/.config/claude0/` holds the authored facts
  (`dispositions`, `archived`, `peeks`, provenance `links`), an `events` log, and the
  daemon's activity `snapshot`. Verbs write facts; only discovery writes the snapshot.
- **Sections** (`sectionOf` → `deriveSections`, `core/inbox-model.ts`). Every
  non-running, non-parked, non-archived live session is Needs You. Observed
  running→ready/waiting transitions are still written as `transition` events, for history
  only. A derived finish (a `finishAt` passing) and a due snooze also land in Needs You.
- **Sort.** Needs You: oldest-ignored first, one band, shared by every surface. Parked:
  snoozed before blocked; snoozed by soonest wake, blocked by least time blocked. The two
  stay separate groups because a future wake time and a past block start share no sort key.
- **Ages are time-in-state, stamped by observation.** A transition the poller witnesses
  stamps `now`; only first sight falls back to transcript timestamps, which can lie. Needs
  You ages from when the session handed you the turn (>1d renders loud). Running ages from
  the user's last prompt. Script-wait (`⏳`) is a running mode aged from the turn→script
  handover, because "is this wait normal or wedged" is the question it answers.
- **Reply observed** has one implementation, `store.replyObserved` (peek + disposition +
  archive cleared in one transaction), shared by discovery's gate and the peek reaper.
- **`/clear`** hands a pane to a new session id. The daemon tick archives the old one
  (`replacedInPane`, `core/inbox-discovery.ts`): a previous-snapshot row whose pane now
  hosts a different id, and that is alive at no pane, is archived and kept as a Recent row
  for 24h. Detection compares against the persisted snapshot (each tick is a fresh
  process). It also catches a `claude` relaunched by hand in an exited session's pane; a
  pane that is simply killed is not a replacement.

## Daemon and wakes

- **The daemon** (`claude0 daemon`; `claude0-daemon.service` with `BindsTo=tmux.service`
  on a Linux host, launchd `com.claude0.daemon` on darwin; installed by `claude0 setup`)
  owns the wake pass and the snapshot. The status-right monitor keeps prefixes and window
  naming.
- **Process shape.** Discovery runs as a fresh child per 3s tick
  (`claude0 daemon --discover-once`): an in-process loop leaked ~1.5 MB/s that JSC never
  returned, so the long-lived daemon only spawns and reaps.
- **Wake pass.** A due snooze with no live pane → detached `claude -r` in a `⚡`-named
  window with an in-pane wake banner, marked auto-resumed, wake event written.
  `markAutoResumed` is an atomic claim (the UPDATE's WHERE is the lock), so overlapping
  passes or a stray second daemon can't double-spawn.
- **The wake attention stamp waits for detected status `ready`.** Claude's boot spinner
  reads as `running`, and the monitor's carry-over clears attention for running sessions.
- **Wake notifications.** The snooze records the portkey device that set it (`device_id`,
  null = Mac-set). Portkey-set: push to that device on either platform (darwin also shows
  its banner). Mac-set: banner on darwin; broadcast Web Push to every subscribed device
  off-darwin, where no banner tier exists.
- **Snapshot ownership.** Discovery owns the table. The bridge's `seedSnapshotRow` (for a
  verb landing on an id never snapshotted) is insert-if-absent and stamps `updated_at: 0`,
  so a bridge seed can't mask a dead daemon in the staleness probe. `saveSnapshot`'s
  replace keeps fact-holding rows the new set doesn't cover, so a verb landing mid-tick
  survives.
- **Moving hosts.** `inbox.db` rides the state copy (WAL checkpointed, daemon stopped): a
  pending snooze is a promise and must wake on the new host. The snapshot table rebuilds on
  the first discovery tick.
- **Resume paths.** Dead-pane probes use `list-panes`; snapshot rows kept without a live
  pane get their stale `real` stripped so Enter resumes instead of selecting a reused
  window index; daemon window spawns are `-d` and single-string; `switchTo` switches any
  client attached to a different tmux session (CLAUDE.md gotchas). Pane-less rows resume
  via `resolveRestoreTarget` (deleted worktrees land in the base repo).

## Sidebar

### Chassis

- One renderer process writes ANSI to every sidebar pane's tty. The panes run stubs that
  are shell lines (`sh`+`nc`+`cat`, ~1 MB), not bun processes (~30 MB each). The renderer
  respawns all stub relays at stand-up (a stub outliving a renderer restart otherwise eats
  one keystroke per pane to notice its socket died).
- Renders are change-gated (repaint only when inputs change, hidden windows included, so a
  switch lands current). A sidebar that becomes its window's only pane exits.
- **Self-heal**, installed by `claude0 setup`: autostart on client attach (marker-gated so
  an explicit hide wins), reclamation of resurrect-restored corpse panes, and per-window
  heal of missing, mispositioned or mis-sized sidebars. The renderer self-installs its tmux
  wiring at stand-up and every ~30s rather than via tmux.conf, so a tmux server restart is
  rewired within a tick with no dotfile dependency.
- **Alternate screen.** The renderer enters `?1049h` at the head of its mode preamble.
  tmux turns a double-click's second press into `DoubleClick1Pane`, and the common host
  binding forwards it (`send-keys -M`) only when `#{alternate_on}`; otherwise the pane
  drops into copy-mode and the double-click never reaches the renderer.
- **Hidden windows are pre-sized.** tmux resizes a window only while a client shows it
  (3.4, every `window-size` mode), so switching to a window last shown at another size
  painted a frame with a 1-col sidebar. Every tick, any stub window no client views whose
  size differs from the window its session shows gets `resize-window` to exactly that size
  (not `-A`: with two clients it picks the larger while `latest` shows the latest), then
  `set -wu window-size` and a stub `resize-pane`. A `window-resized` hook restores the stub
  width in-server as a backstop; alone it ran after the first frame. Both skip zoomed
  windows (`resize-pane` unzooms).

### Interaction grammar

- **Unfocused**, the sidebar is a glance surface (no chrome, pinned to top). **Focus**
  (`sidebarFocus`, default `M-s`) is instant: the toggle signals the renderer directly, and
  the selector lands on the session of the pane you came from. **Visibility**
  (`sidebarToggle`, default `M-S`) is global: hide kills every sidebar pane and stands
  down self-heal until shown; the state survives server restarts.
- **Two marks.** The *pin* (`▎`, white — location, deliberately not a status color) on the
  session in this window's active pane; the *selector* (row background) only while focused.
- **Clicks and Enter are select-then-commit.** A click on an unfocused sidebar focuses and
  highlights the row hit (no row → the window's active session); a focused click on another
  row moves the highlight; a click on the highlighted row navigates. Enter on a row in
  another window shows that window and lands focused in *its* sidebar with the row
  selected; Enter on the current window's row commits into the session pane. A pane-less
  row resumes into a new window; a second Enter before discovery stamps the pane commits
  into the spawned window (`resumedWindows`) instead of double-spawning. A double-click
  commits with the session *pane* focused (`switchTo`, `sidebar/renderer.ts`).
- **Verbs** are section-scoped; `J`/`K` jump sections; Recent takes only `e`. `e` archives
  and, on a Recent row, un-archives back into Needs You (pane stays closed). Archiving a
  live session is a double-tap confirm because it closes the pane. Snooze is hidden on
  Running rows.
- **Dispositions walk the view.** Every disposition moves the selector to the row under
  the disposed one and the display switches to that session's window, focused in its
  sidebar. Disposing the session you're looking at navigates before its window dies.
- **Peek.** Enter on Parked/Recent opens the session without re-entering it: the
  disposition stays, and a `peeks` record marks the window provisional. Engagement is a
  prompt newer than the peek (`peekEngaged`); discovery's reply-observed clear is gated on
  it (a `claude -r` boot spinner reads as running and would otherwise unpark the row within
  a tick). The renderer reaps a peek window unviewed for `PEEK_GRACE_MS` (60s) after a
  final transcript check, so a whole turn inside one tick still graduates the row. A due
  snooze files under Needs You, so the reaper drops the record and keeps the window.
  Explicit re-entry is `b` (unpark); restore is `e` on Recent.
- **Fork** places the new window beside the parent (`new-window -a`).

### Snooze form

- `s` opens a two-line mini-form: a unit row (`t 8am`, `d day`, `h hr`; Tab cycles, the
  unit letter selects) above an amount field with a live resolved-wake preview. The amount
  starts as a dim overwritable `1`, so a bare Enter is a 1-unit snooze. Enter commits, Esc
  cancels, stray keys are inert, unfocus cancels. Nothing commits until Enter — a snooze
  kills the pane, so a mistyped key must not be destructive.
- `h`/`d` are exact relative (1d = 24h). `t` is 8AM local on the +N calendar day, built
  from local calendar components so DST still yields wall-clock 8AM. The phone's day
  presets share the math (`presetWakeAt` → `wakeAt(…, "t")`, `core/inbox-model.ts`).
- **One absolute-wake renderer**, `shared/wake-abs.js`, for the form preview, the parked
  detail line, the commit flash and the phone's snooze toast: same day → time ("9AM"),
  under 7 days → weekday + time ("Tue 9AM"), else dd/MM + time ("26/09 9AM"). Hard-coded
  English dd/MM 12-hour: Bun ignores `LANG` for its default locale and ICU builds disagree
  on locale data, so locale-sensitive `Intl` formatting is never relied on in this repo.

### Visual language

- Status lives in section color tiers (white attention / mint activity / dim parked+done);
  peach appears only as signal (reason glyphs, stale ages), never as paint. Rows are
  two-line (name + dim repo/PR) in Needs You and Running, one-line elsewhere.
- Emoji are allowed in the sidebar: the renderer writes raw SGR and clears each line before
  repainting, and tmux 3.4 and `Bun.stringWidth` both measure them as two cells. The TUI
  (blessed) keeps a measured-1-cell glyph set — emoji are double-width in tmux but
  single-width to blessed, so repaints corrupt.
- **Right slot.** `⚡` = unread (the monitor's `needsAttention` flag for the row's pane —
  the same flag behind the window prefix and portkey's row glow, so all three clear
  together). Then the reply due: `❓` question, `✋` approval, `⏰` snooze wake; a plain
  ready session shows only its age. Running rows show `⏳` for script-wait, and `⚡⏳` while
  that turn still carries the attention flag. Parked keeps one-cell `☾` (snoozed) and `✗`
  (blocked) so parked rows stay light.
- **`unread` is overlaid from `state.json` on every 1s paint** (`overlayAttention`) for
  rows with a live pane; the snapshot's copy is one discovery pass late. Pane-less rows
  keep the snapshot value, which portkey and newborn placement use.
- **Status-right** renders `⚡N 🔄N` only (a `✓N` cleared-today counter was tried and
  removed).

## Portkey Home

- Home is the sectioned inbox; section header counts replace the navbar ⚡/🔄 chips. The
  bridge serves sections pre-derived from the store (`composeSessions` →
  `deriveSections`); its own discovery adds row detail only (pending, unread, scripts,
  names), joined by id.
- **Verbs** live in the long-press sheet: snooze presets `1h / 4h / Tomorrow 8AM / 3d /
  7d`, block with a free-text note (empty allowed), unpark, un-archive. Disposing from an
  open thread returns to the list. Snoozing a running session takes a confirm; `/snooze`
  returns `wakeAt` for the toast.
- **Phone archives write the store's Done fact**, gated on the kill succeeding or the row
  being pane-less per the bridge's own discovery — never blanket no-pane, which would mark
  a live session done on a pane-resolution race.
- Recently done keeps its 24h window; the History screen is the windowless archive.

### Freshness around the 3s snapshot

- The phone *renders* a row under the section its live status implies when that disagrees
  with the store's tag (`displaySection`, `shared/sync.js`), never rerouting parked/done
  (authored by verbs) and keeping `⏳` script-waiters in Running.
- While stream clients are connected, the bridge polls the store's `data_version` every 1s
  and re-projects and pushes when the daemon's snapshot commits.
- **`inboxStale` is a banner, not a blocker.** A snapshot older than 10s (or absent) flags
  the `/sessions` payload; verbs still work. A pane-less parked/done id outside discovery's
  window gets a minimal projected row plus `restoreState`; a discovery-only newborn maps
  from status (running → Running, prompt-sitters → Needs You) with a stable age anchor (its
  last turn — a per-recompute `now` would make every payload differ and self-sustain the
  push cycle while the daemon is down).
