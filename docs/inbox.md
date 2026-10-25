# Inbox

How the inbox behaves and where each part lives: the store, the daemon, the tmux sidebar,
and portkey's Home. The behavior below is the spec the code implements; the named
docblocks carry the implementation detail. Decisions:
[ADR 13](adr/0013-inbox-lifecycle-model.md). Code: `core/inbox-*.ts`, `src/sidebar/`.

## Store and sections

- **Store.** `inbox.db` (SQLite) under `~/.config/claude0/` holds the authored facts
  (`dispositions`, `archived`, `peeks`, provenance `links`), an `events` log, and the
  daemon's activity `snapshot`. Verbs write facts; discovery owns the snapshot (the bridge
  may only seed an absent row, `seedSnapshotRow`).
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
- **A wait holds Running; a service doesn't.** A `ready` session with a live background
  script stays in Running while that script is something Claude waits on (CI, a deploy, a
  review). When every live script is a service it merely started (a dev server, a tunnel,
  judged by label and command: `isServiceScript`), the session files under Needs You with
  `⏳`: an endless server must not hide a session that is asking you something. A wait
  holds Running for at most 2h (`SCRIPT_WAIT_CAP_MS`, `core/inbox-discovery.ts`), which
  catches a service the check misses; the released row ages from when the wait began.
- **`/clear`** hands a pane to a new session id; the daemon tick archives the old one into
  Recent (`replacedInPane`, `core/inbox-discovery.ts`). A pane that is simply killed is
  not a replacement.
- **An archived session that never got a prompt skips Recent** (`empty`, `sectionOf`):
  Claude writes no transcript before the first prompt, so there's nothing to reread or
  resume.

## Daemon and wakes

The daemon (`claude0 daemon`; `claude0-daemon.service` with `BindsTo=tmux.service` on a
Linux host, launchd `com.claude0.daemon` on darwin; installed by `claude0 setup`) owns the
wake pass and the snapshot; the status-right monitor keeps prefixes and window naming. Its
tmux calls follow CLAUDE.md's "tmux, from a tty-less process" gotchas.

| Concern | Where |
|---|---|
| Discovery is a fresh child per 3s tick (an in-process loop leaked memory JSC never returned) | `core/inbox-discovery.ts` header, `claude0 daemon --discover-once` |
| Due snooze → detached `claude -r` in a `⚡` window, claimed atomically so no double-spawn | `wakePass` (`core/inbox-wake.ts`), `markAutoResumed` (`core/inbox-store.ts`) |
| The wake's ⚡ waits for status `ready` (the boot spinner reads as running) | `stampWakeAttention` (`core/inbox-wake.ts`) |
| Wake alert: push to the device that set the snooze; Mac-set → banner on darwin, broadcast push elsewhere | `core/inbox-wake.ts` |
| A verb landing mid-tick survives the snapshot replace; a bridge seed can't mask a dead daemon | `saveSnapshot`, `seedSnapshotRow` (`core/inbox-store.ts`) |
| Reply observed: peek + disposition + archive cleared in one transaction | `replyObserved` (`core/inbox-store.ts`) |
| Pane-less rows resume via the restore target (deleted worktrees land in the base repo) | `resolveRestoreTarget` (`core/resurrect.ts`) |

Moving hosts: `inbox.db` rides the state copy (WAL checkpointed, daemon stopped) so a
pending snooze wakes on the new host; the snapshot rebuilds on the first tick
(`docs/history/vm-cutover-runbook.md`).

## Sidebar

### Chassis

One renderer process inside the daemon writes ANSI to every sidebar pane's tty; the panes
run shell-line stubs (`STUB_CMD`, ~1 MB each, versus ~30 MB for a bun process). The
renderer's 1s tick stands sidebars up while `claude0 setup`'s autostart marker exists and
no hide marker does.

| Concern | Where (`src/sidebar/renderer.ts`) |
|---|---|
| Stub relays respawn at stand-up | `respawnRelays` |
| tmux wiring self-installs at stand-up and every ~30 ticks (no tmux.conf dependency) | `installTmuxWiring` |
| Per-window heal: missing, mispositioned or mis-sized sidebars; a window left with only its sidebar is killed after 3s | `ensure` |
| Resurrect-restored corpse panes are reclaimed | `reclaimCorpses` |
| Alternate screen first, because tmux forwards a double-click only when `#{alternate_on}` | mode preamble |
| Hidden windows are pre-sized to the client, because tmux resizes a window only while shown | `prewarmHidden`, `window-resized` hook |

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
  commits with the session *pane* focused (`switchTo`).
- **Verbs** are section-scoped; `J`/`K` jump sections; Recent takes only `e`. `e` archives
  and, on a Recent row, un-archives back into Needs You (pane stays closed). Archiving a
  *running* session is a double-tap confirm (killing a mid-turn Claude throws away
  in-flight work). Snooze is hidden on Running rows.
- **Dispositions walk the view.** Every disposition moves the selector to the row under
  (else above) the disposed one. When the disposed session lived in the window you're
  viewing, the display also switches to the next session's window, focused in its
  sidebar, before the old window dies. Un-archive never walks.
- **Peek.** Enter on Parked/Recent opens the session without re-entering it: the
  disposition stays, and a `peeks` record marks the window provisional. Engagement is a
  prompt newer than the peek (`peekEngaged`); discovery's reply-observed clear is gated on
  it (a `claude -r` boot spinner reads as running and would otherwise unpark the row within
  a tick). An unviewed peek window is reaped after `PEEK_GRACE_MS` (60s), after a final
  transcript check. A due snooze files under Needs You, so the reaper drops the record and
  keeps the window. Explicit re-entry is `b` (unpark); restore is `e` on Recent.
- **Fork** (`f`) places the new window beside the parent (`new-window -a`).

### Snooze form

- `s` opens a two-line mini-form: a unit row (`t 8am`, `d day`, `h hr`; Tab cycles, the
  unit letter selects) above an amount field with a live resolved-wake preview. The amount
  starts as a dim overwritable `1`, so a bare Enter is a 1-unit snooze. Enter commits, Esc
  cancels, stray keys are inert, unfocus cancels. Nothing commits until Enter — a snooze
  kills the pane, so a mistyped key must not be destructive.
- Units resolve in `wakeAt` (`core/inbox-model.ts`): `h`/`d` exact relative, `t` 8AM local
  on the +N calendar day. The phone's day presets share it (`presetWakeAt`).
- Every absolute wake time — form preview, parked detail line, commit flash, the phone's
  snooze toast — renders through `shared/wake-abs.js`.

### Visual language

- Section headers carry the tier color: Needs You peach when non-empty, Running mint,
  Parked/Recent dim. Names are white in Needs You and Running, muted below. Within rows,
  peach marks only signal (reason glyphs, ⚡, stale ages). Rows are two-line (name + dim
  repo/PR) in Needs You and Running, one-line elsewhere.
- Emoji are allowed in the sidebar: the renderer writes raw SGR and clears each line before
  repainting, and tmux 3.4 and `Bun.stringWidth` both measure them as two cells. The TUI
  (blessed) avoids them — emoji are double-width in tmux but single-width to blessed, so
  repaints corrupt.
- **Right slot.** `⚡` = unread (the monitor's `needsAttention` flag for the row's pane —
  the same flag behind the window prefix and portkey's row glow, so all three clear
  together; overlaid per paint by `overlayAttention`). Then the reply due: `❓` question,
  `✋` approval, `⏰` snooze wake; a plain ready session shows only its age, and `⏳` follows
  the marks while a service still runs. Running rows show `⏳` for script-wait, and `⚡⏳`
  while that turn still carries the attention flag. `e` on any `⏳` row needs a second
  press, because the script dies with the pane.
  Parked keeps one-cell `☾` (snoozed) and `✗` (blocked) so parked rows stay light.
- **Status-right** renders `⚡ N 🔄 N` only (a `✓N` cleared-today counter was tried and
  removed).

## Portkey Home

- Home is the sectioned inbox; section header counts replace the navbar ⚡/🔄 chips. The
  bridge serves sections pre-derived from the store (`composeSessions` →
  `deriveSections`); its own discovery adds row detail only (pending, unread, scripts,
  names), joined by id.
- **Verbs** live in the long-press sheet: snooze presets `1h / 4h / tmrw (8AM) / 3d / 7d`,
  block with a free-text note (empty allowed), unpark, un-archive. Disposing from an open
  thread returns to the list. Snoozing a running session takes a confirm; `/snooze`
  returns `wakeAt` for the toast.
- **Phone archives write the store's Done fact**, gated on the kill succeeding or the row
  being pane-less per the bridge's own discovery (`/archive`, `bridge/server.ts`).
- Recently done keeps its 24h window; the History screen is the windowless archive.

### Freshness around the 3s snapshot

| Concern | Where |
|---|---|
| A row renders under the section its live status implies (never rerouting parked/done) | `displaySection` (`shared/sync.js`) |
| While stream clients are connected, the bridge polls `data_version` every 1s and pushes when the daemon commits | `bridge/server.ts`, `core/inbox-store.ts` |
| `inboxStale` (snapshot >10s old) is a banner, not a blocker: verbs still work | `/sessions` payload, `bridge/inbox-payload.ts` |
| A discovery-only newborn gets a stable age anchor, or the change-push cycle never settles while the daemon is down | `DiscoverySeen.since` (`bridge/inbox-payload.ts`) |
