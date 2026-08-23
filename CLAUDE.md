# CLAUDE.md

# Claude0

Full-screen terminal TUI (blessed) for managing Claude Code sessions. Launched via `tmux display-popup`. Shows sessions grouped by repo with live status detection, ANSI preview pane, vim navigation, attention notifications, and AI naming.

## Environment

macOS (ARM) with Ghostty terminal, Oh My Zsh, and tmux.

## Commands

```sh
bun run start             # Run TUI
bun run dev               # Watch mode (--watch)
bun run status            # Lightweight tmux status-right monitor
bun test                  # Run tests (bun:test)
bun run typecheck         # tsc --noEmit (bun runs no type checks itself)
```

Entry: `bin/claude0.ts` (CLI router) → `src/index.ts` (TUI) or `src/cli.ts` (subcommands)

## Bridge restarts (do it directly)

The mobile bridge (`claude0 bridge`) runs as a systemd user unit on the Linux VM host (`127.0.0.1:8473`, proxied to the phone via `tailscale serve`). **When a change needs a restart, restart it yourself — don't just tell the user.** This is a routine, durably-authorized action; treat it as approved.

- **When a restart IS needed:** any change to `src/bridge/server.ts` or the `core/` functions it imports — the server code is loaded into the running Bun process.
- **When it is NOT needed:** changes to `src/bridge/public/*` (`app.js`, `index.html`/CSS). Those are served fresh (`cache-control: no-cache`); the user just refreshes/reopens the page on the phone.
- **How to restart:** `systemctl --user restart claude0-bridge`; logs via `journalctl --user -u claude0-bridge` ([ADR 16](docs/adr/0016-systemd-units-replace-launchd.md), `deploy/`). The token lives in a 0600 `EnvironmentFile` (`~/.config/claude0/bridge.env`), so a plain restart preserves it. Then verify: `POST /auth` → 200 and the changed route behaves.

## CLI subcommands

`bin/claude0.ts` routes based on `process.argv[2]`. All subcommands except `status` and `bridge` live in `src/cli.ts`. `claude0` is the canonical command; `c0` is an installed alias (both symlinks to the same entry) — docs, units, and fragments use `claude0`, `c0` is for typing.

| Command | Description | Output |
|---------|-------------|--------|
| `claude0` | Open full TUI (`CLAUDE0_FOCUS_PANE` env var pre-selects a pane) | blessed screen |
| `claude0 next` | Switch to next attention session (oldest first) | tmux display-message |
| `claude0 reset` | Reset all window names to "claude", clear ⚡ and attention state | tmux display-message |
| `claude0 status` | Tmux status-right monitor (`⚡3 🔄2`) | stdout |
| `claude0 list` | Text-only session list with status/repo (+context% when Claude's statusline reports it) | stdout |
| `claude0 switch <name>` | Fuzzy-match session by name and switch to it | tmux display-message |
| `claude0 setup` | Role-dispatched install (`--role local\|host\|client`; host adds native provisioning, `--dry-run` prints the plan) | stdout |
| `claude0 doctor` | Role-aware read-only audit (essentials, fragments, config, auth; host adds units/sysctl/swap/tailscale) — exit 0 iff no failures | stdout |
| `claude0 terminal [local\|remote\|status]` | Run the rendered launcher (attach local tmux / mosh to the host) | attaches or stdout |
| `claude0 resurrect save\|restore` | Resolve the tmux-resurrect plugin (user copy wins) and exec its script | exit passthrough |
| `claude0 daemon` | Inbox engine: snooze wakes, discovery snapshots, sidebar renderer (run by launchd/systemd, not by hand) | long-running |
| `claude0 bridge` | Portkey HTTP bridge for the phone (systemd unit on the host) | long-running |
| `claude0 save-sessions` | Snapshot pane→session map for tmux-resurrect | stdout (silent in hook) |
| `claude0 restore-sessions` | Restore Claude sessions after tmux-resurrect restore | stdout |
| `claude0 --help` | Show available commands and usage | stdout |

**Testing subcommands**: Use `bun run bin/claude0.ts <cmd>` to test without installing globally. Example: `bun run bin/claude0.ts list` prints active sessions to stdout — useful for verifying session discovery, status detection, and name resolution without launching the TUI.

**`claude0 next` details**: Reads `state.json` attention flags, picks the session with the oldest `lastTransition` timestamp, clears its attention flag, strips ⚡ prefix, and calls `switchToPane()`. Falls back to scanning tmux windows for ⚡ prefixes when state.json has no valid candidates (handles state↔window desync).

**`claude0 reset` details**: Lists all tmux windows, renames any with non-standard names (not in `zsh|bash|dev|fish|sh`) back to repo name from pane cwd. Strips ⚡ and 🔄 prefixes. Also clears all attention flags in `state.json`.

**`claude0 switch` scoring**: exact=100, starts-with=80, contains=60, word-starts-with=40, subsequence=20. Matches against window names with ⚡/🔄 stripped.

**Focus pane pre-selection**: Set `CLAUDE0_FOCUS_PANE=%42` (tmux pane ID) to pre-select that session on launch. Requires `run-shell` to expand the format string: `bind a run-shell 'tmux set-environment CLAUDE0_FOCUS_PANE "#{pane_id}"' \; display-popup -E -w 90% -h 85% claude0`. Falls back to first session if pane not found.

**`claude0 setup` details**: Installs Claude0's Claude lifecycle hooks under `~/.config/claude0/hooks`, preserving existing hooks and settings. It also updates narrowly scoped Claude0 tmux/zsh fragments under `~/.config/claude0/`, installs the `~/.local/bin/claude0` and `~/.local/bin/c0` commands plus a private terminal launcher under `~/.config/claude0/`, and adds one import to the user's `.tmux.conf` and `.zshrc`. Safe to run multiple times (idempotent); personal dotfiles, prompts, and tmux presentation are never replaced, and a user-managed tmux-resurrect always takes precedence over the claude0-owned clone ([ADR 23](docs/adr/0023-dotfiles-independence.md)).

## Architecture

```
src/
├── index.ts              # App entry: screen, keybindings, 3s refresh loop, state management, prefix sync
├── cli.ts                # CLI subcommands: next, reset, list, switch, setup (no blessed dependency)
├── types.ts              # All shared types (Session, RepoGroup, DisplayRow discriminated union, etc.)
├── monitor.ts            # Lightweight poller for tmux status-right (⚡3 🔄2), prefix sync, debug logging
├── core/
│   ├── sessions.ts       # Session discovery: index scan + pane/process correlation + archive detection + worktree grouping
│   ├── tmux.ts           # tmux wrappers: list-panes, capture-pane, switch, kill, rename, bell
│   ├── process.ts        # Find claude processes via ps, PID→TTY mapping
│   ├── status.ts         # Status detection from pane capture (spinner/prompt patterns), context %, time formatting
│   ├── config.ts         # ~/.config/claude0/config.json — all user-owned Claude0 settings
│   ├── state.ts          # ~/.config/claude0/state.json — shared TUI↔monitor attention state
│   ├── names.ts          # AI naming (claude -p), heuristic fallback, name cache
│   ├── git.ts            # Git operations: repo discovery, branch listing, checkout, worktree creation, base repo/default-branch resolution
│   ├── launch-command.ts # Pure builder for the new-session shell command (worktree/checkout + claude), shellQuote, worktreeDirName
│   ├── resurrect.ts      # Which cwd save-sessions records and which directory restore-sessions resumes in
│   └── notifications.ts  # Transition detection, prefix management (⚡/🔄), dispatch
└── ui/
    ├── layout.ts          # blessed screen + 3-region layout (list 50%, preview 50%, status bar)
    ├── session-list.ts    # Build display rows, ticket ID extraction, render with blessed tags, navigation
    ├── preview-pane.ts    # ANSI→blessed conversion, chrome stripping, bottom-aligned preview
    ├── wizard.ts          # New Session wizard: inline step-through UI (repo → branch → worktree → launch)
    ├── space-menu.ts      # Space action menu: which-key style popup (approve, send, copy, rename, kill, fork)
    ├── status-bar.ts      # Key hint bar (contextual: "switch" vs "resume")
    └── colors.ts          # Vesper palette constants + color helpers
```

### Data flow

`discoverSessions()` → scan index files + `listPanes()` + `findClaudeProcesses()` in parallel → correlate by TTY → `capturePane()` for status detection → `getBaseRepoPath()` for worktree resolution → `groupSessions()` → `buildDisplayRows()` → `renderSessionList()`

Two-phase discovery: Phase A = active tmux panes (fast), Phase B = archived from index files (last 24h, no active pane). Session UUIDs resolved via Claude Code's `SessionStart` hook (writes paneId→sessionId as per-pane files under `~/.config/claude0/panes/`). Run `claude0 setup` to install the hook.

### Worktree-aware repo grouping

Sessions in git worktrees group under their base repo via `getBaseRepoPath()` (uses `git rev-parse --git-common-dir`, cached). `baseRepoPath` on `Session` type drives repo naming, group paths, and wizard preselection. Worktrees sort after non-worktrees within the same status tier. Orphaned worktree directories (deleted) are resolved structurally from the managed path (`<base>/.claude/worktrees/<name>` → `<base>`).

### Multi-pane window support

Windows with multiple Claude panes are named `{repo}` (same repo) or `{repo1}+{repo2}` (mixed). Attention prefix (⚡) only cleared from a window when no other panes in that window still need attention. State synced with external changes from `claude0 next` and the monitor on each refresh cycle.

### Session matching

Claude process TTYs (from `ps`) matched against tmux pane TTYs. `ps` reports `ttys001`, tmux reports `/dev/ttys001` — normalized by stripping `/dev/` prefix. `paneSessionCache` persists paneId→sessionId across refreshes.

### Switch mechanism

Active: writes `sessionName:windowIndex:paneId` to `/tmp/c0-switch`, exits. Wrapper script does `tmux select-window`/`select-pane`.
Archived: resumes via `claude -r {id}` (or `--fork` with `f` key) in new tmux window.

## Features

### Keybindings

| Key | Action |
|-----|--------|
| `j`/`k` | Move up/down (skips headers) |
| `J`/`K` (or `Shift`+arrows) | Jump to next/prev repo group |
| `Enter` | Switch (active) or resume (archived) |
| `Space` | Open action menu (approve, send, copy, rename, kill, fork) |
| `n` | New session wizard (repo → branch → worktree → launch) |
| `f` | Fork session (`--fork` in new window) |
| `x` | Kill pane (double-tap to confirm) |
| `u`/`d` | Scroll preview pane ±6 lines |
| `a` | Toggle archived sessions visibility |
| `q`/`Esc` | Quit |

### Space action menu (`Space` key)

Neovim which-key style popup at bottom-left. Press a key to select an action:

| Key | Action |
|-----|--------|
| `y` | Approve — context-aware sub-menu (tool approval or question answer) |
| `m` | Send message — type text to send to the session's pane |
| `c` | Copy preview pane text to clipboard (pbcopy) |
| `r` | Rename — generate AI name (claude -p, cached) |
| `x` | Kill pane (double-tap to confirm) |
| `f` | Fork session (`--fork` in new window) |

**Approve sub-menu** detects the session's state:
- **Tool approval** (Edit/Bash/etc.): `y` yes, `a` yes don't ask again, `n` no
- **AskUserQuestion**: Shows numbered options from JSONL, `t` to type custom answer

**Chat about this** (phone only): declines an open AskUserQuestion instead of picking an option, so the agent yields the turn and waits for a typed message. Held → the hook denies the tool via the decision file. Un-held (question fired at the desk, or the hold released/expired) → drives the native picker's own "Chat about this" row with one digit, pre-flighted from a fresh capture (`clarifyQuestion` in `core/tmux.ts` refuses when the picker isn't on screen, a permission prompt is up, or the free-text row has focus; unparseable chat row falls back to Escape). The question hold itself lasts up to 4h (`QUESTION_HOLD_MS`, its own matcher-scoped hook registration — approvals keep the 600s window) and releases early the moment the user is back at the Mac, so the native picker renders in front of them. Why hold-plus-release instead of pure send-keys: [ADR 8](docs/adr/0008-question-hold-not-send-keys.md).

**Send message**: Opens inline text input. Enter sends text + newline to the pane. Useful for approving tool calls or sending instructions without switching.

### Session statuses

| Status | Dot | Detection |
|--------|-----|-----------|
| waiting | ⏸ | Confirmation prompts, y/n, tool approval |
| running | ⦿ | Spinner chars (braille, unicode dots) |
| ready | ● | ❯ prompt visible |
| idle | ○ | No claude process on pane |
| archived | ○ | Modified in last 24h, no active pane |

Sort order matches portkey's attention queue (`compareSessions` in `bridge/public/app.js`): attention (⚡) first, then waiting → running → ready → idle → archived, then last-turn recency desc (`lastTurnAt`; never a live session's `modified` fallback — that's stamped per refresh and would shuffle the list). User-configured priority repos are pinned at the top; the default is alphabetical.

### Session labels

Session rows display "TICKET · name" labels extracted from branch names (Linear/Jira pattern like `ENG-2687`). Falls back to: ticket+branch-suffix → name alone → branch. Context % column removed from main row; summary detail rows no longer show `[name]` tag.

### Attention & notifications

4-tier system on status transitions (running→waiting = "blocked", running→ready = "turnComplete"):
1. Status monitor update (tmux status-right)
2. Window prefix: ⚡ added to tmux window name
3. macOS native notification (terminal-notifier/osascript; sound-only while the user is present; click target from `notifications.terminalBundleId`, Ghostty default; darwin-only by decision — [ADR 14](docs/adr/0014-presence-is-client-activity.md))
4. Web Push to the portkey device that drove the turn (see below)

**Presence** ("is the user at the terminal?") feeds tiers 2–4's suppression, the monitor's takeover (`clearSource`), the question hold's release, and the hook gates. On every platform it's tmux `#{client_activity}` within a 60s window (`core/presence.ts`, tri-state — each site maps probe failure per its own polarity). Attached-but-idle counts as away, because a remote tmux attach is permanent and looking-without-typing is indistinguishable from it. Model: [ADR 14](docs/adr/0014-presence-is-client-activity.md); unification on all platforms (no frontmost probes, no hardcoded terminal): [ADR 19](docs/adr/0019-presence-is-client-activity-everywhere.md).

Window prefix priority: ⚡ (needs attention) > 🔄 (running) > ⏳ (waiting on background script) > none. Monitor syncs prefixes on each cycle. `stripAllPrefixes()` and `desiredPrefix()` in `notifications.ts` centralize prefix logic.

Auto-clears when user focuses the attention pane. Config in `~/.config/claude0/config.json`.

**Tier 4 — per-device Web Push** (`core/web-push.ts`, no dependency — VAPID + RFC 8291 aes128gcm on Bun WebCrypto, pinned by the RFC's own test vector). Each portkey client mints a `deviceId` (localStorage), sends it as `x-claude0-device` on every request (`?device=` on SSE), and registers a push subscription via `sw.js` — installed-PWA only; the navbar bell appears once (permission grant needs a gesture on iOS), after which a lost/pruned subscription silently resubscribes on launch. The source marker (`source/<id>.json`) records which device drove the turn; the monitor pushes only to that device, and only when its SSE liveness marker (`consumers/<deviceId>`, touched on connect/heartbeat, unlinked by the `sendBeacon` goodbye on backgrounding — the client closes its EventSource first so the heartbeat can't re-touch) is stale. Focusing the session's pane at the Mac clears the marker entirely (takeover). Pushes carry only the non-sensitive label + tool category; `tag = sessionId` keeps one notification per session (latest state wins). Prune on 401/403/404/410. The VAPID `sub` contact identifying the install's operator to push services is config `notifications.pushContact`, deriving from `git config user.email` when empty (omitted entirely if neither exists). Decision record: [ADR 6](docs/adr/0006-web-push-replaces-ntfy.md).

**Notification taps → the session.** iOS dispatches `notificationclick` **only on a cold launch** — with the PWA already running a tap just activates it and the worker never wakes, so the stash/`postMessage`/`?s=` paths all die together. Warm taps are therefore attributed by the page from two signals it can actually get: *what was pushed* (`GET /push/recent?device=`, delete-on-read, fed by the per-device ledger `sendWebPush` writes to `pushed/<deviceId>.json` — the worker can't hand this over, since a warm-resumed page reads a stale CacheStorage snapshot) and *what was tapped* (the shade — iOS removes a tapped notification and leaves an ignored one). A recorded push whose notification has vanished is the tap (`tapTarget` in `shared/tap-target.js`); exactly one vanished → open it, none or several → stay put. `followNotificationTap()` reads the shade **before** clearing it — the old order dismissed first and destroyed the evidence. `initPush` calls `registration.update()` each launch so a stale worker can't linger. Why server-side, and what was rejected: [ADR 10](docs/adr/0010-notification-taps-attributed-server-side.md).

### Monitor (`bun run status`)

Lightweight poller for `tmux status-right` and sole authority for window naming. Quick-discovers active panes only (~50ms). Output: `⚡3 🔄2`. Shares state via `~/.config/claude0/state.json`. Syncs ⚡/🔄 prefixes and AI names on window names. Opt-in debug logging to `~/.config/claude0/debug.log` (auto-truncating, enabled by file existence).

### Preview pane

- Active: live ANSI capture with SGR→blessed tag conversion, chrome stripping (prompt/status line removed), bottom-aligned
- Archived: last assistant message from JSONL tail-read
- Collapsed archive: summary table of hidden sessions

### New Session wizard (`n` key)

Inline step-through UI that replaces the session list (no modal). Steps: repo → branch → worktree? → launch.

- **Repo step**: always-visible filter bar — type to search, arrows navigate (plain `j`/`k` type into the filter; `^J`/`^K` also move but aren't advertised). Repos discovered from active sessions + `repositories.roots` config dirs. Worktrees are **collapsed by default** (base rows show a `▸/▾ N` chevron+count). Two ways to see a repo's worktrees: (1) **browse** — `→`/`Tab` on a base expands its worktrees nested inline (`←`/`Tab` collapses; `←` on a worktree collapses its parent); (2) **filter** — typing a query reveals matching worktrees flat, where a worktree matches by its branch **or** its base repo name (so typing the repo name surfaces its worktrees). Empty filter → base repos only. Enter on a base advances to the branch step; Enter on a worktree launches Claude there directly (`mode:"current"`). Preview pane shows a base-repo info panel (recent commits, worktree count, active-session indicator, path). Single repo auto-skips. Preselects the base repo of the home-screen selection. Expand keys (`→`/`←`) only apply in the browse view; while filtering they move the text cursor. Ctrl nav quirk: `^J` arrives as blessed keyName `linefeed` (not `C-j`); `^K` is `C-k`
- **Branch step**: arrows navigate (`^J`/`^K` also work), type activates type-to-filter (Esc clears). Preview pane shows `git log` for highlighted branch
- **Worktree-choice step**: Only shown when selected branch != current. Three options (fixed order): "New worktree + new branch" (fork off the selected branch), "New worktree on this branch" (reuse the branch as-is — no fork, so an agent's feature branch stays one branch/one PR), "Checkout in place" (last). Default cursor is context-aware: trunk (`origin/HEAD`, or main/master) → new-branch; feature branch → reuse. Reuse pre-checks `branchCheckedOutPath` and flashes a conflict (staying in the wizard) if the branch is already checked out elsewhere.
- **Worktree name step**: For new-branch, the field edits the new branch name; for reuse, it edits the worktree **directory** name (pre-filled with the branch name minus any `prefix/`, e.g. `cursor/ev-4-x` → `ev-4-x`). The directory is always repo-local at `<repo>/.claude/worktrees/<name>`.
- **Launch**: The git setup + `claude` run as one shell command inside the spawned tmux window (built by `buildLaunchCommand` in `core/launch-command.ts`), then exits the TUI. `^O` instead of Enter launches without Claude (git setup + plain shell — for using the wizard as a worktree creator); it works at every point where Enter would launch (worktree name step, existing-worktree row, current branch, checkout in place) and is hinted in the status bar only there

Refresh loop paused during wizard. Esc pops back one step (or cancels from the repo step). Git errors flash as status messages and keep wizard open for retry. Progress messages shown during checkout/worktree operations.

Config `repositories.roots` (default `["~/dev"]`): directories scanned 1-level deep for git repos to include alongside session repos. Repositories remain flat under each root; linked worktrees live inside their base at `<repo>/.claude/worktrees/`.

### AI naming (`names.ts`)

Priority: cache → summary → plan title → first prompt + branch context. AI via `claude -p` subprocess with compact prompt (1-3 words, abbreviations encouraged). Names appear on tmux windows as `{repo}·{ai-name}`. Cache at `~/.config/claude0/names.json` (v3).

### Window naming format

Tmux windows use the format `[⚡|🔄|⏳]{repo}[/{ai-name}][+]`:
- `{repo}` = base repo name from pane cwd (worktrees resolved via `getBaseRepoPath`), shortened per config `ui.repoAbbreviations` (e.g. `{"claude0": "c0"}`) on window names and the sidebar only — lists, grouping, and push labels keep the real name
- `/{ai-name}` = AI-generated compact name (1-3 words, kebab-case)
- `+` = fork indicator (transitional, until fork gets its own AI name)
- `⚡`/`🔄`/`⏳` = status prefixes (attention > running > script-wait > none)

`⏳` = the turn is over (status `ready`) but the session still waits on a live `run_in_background` script (same detection as portkey's list badge: transcript pending-scripts + `lsof` runner-liveness probe). Visibility only — it never feeds notifications, attention, `claude0 next`, sort order, or the status-right counts. Both the monitor (per tick) and the TUI (per refresh) compute it via the same entry point, `detectScriptWaits` in `core/script-wait.ts`. Neither process outlives the work — the monitor is fresh per tick, and the TUI is fresh per `display-popup` open — so nothing is cached in memory: the transcript parse persists to `~/.config/claude0/script-wait.json` (keyed by size+mtime) and the liveness verdicts to `~/.config/claude0/verdicts/` (see below).

Examples: `claude0`, `claude0/fix-auth`, `⚡claude0/fix-auth`, `🔄api`, `claude0/fix-auth+`
Multi-pane same repo: `{repo}`. Multi-pane mixed: `{repo1}+{repo2}`.
Helpers in `notifications.ts`: `buildBaseName()`, `extractAIName()`, `extractRepoFromWindowName()`.

### Portkey sync (versioned state push)

The bridge's SSE stream carries **data, not doorbells** (`src/bridge/stream.ts`; apply
logic in `src/shared/sync.js`, served unbuilt as `/sync.js`). Every push is stamped
`{seq, computedAt}` (seq = per-connection counter, resets on reconnect). `sessions`
events carry the full list payload — pushed on connect (the wake-up fix: one
round-trip replaces the old three racing foreground refetches; `resync()` is just a
stream rebuild) and on every changed recompute (`kickSessionsPush` → dedupe in
`pushSessions`). `transcript` events serve a per-device subscription
(`POST /stream/open`, one session per device, torn down on goodbye/60s-disconnect,
re-declared on every stream open): `kind:"snapshot"` replaces wholesale (subscribe,
rewind, branch flip, compaction), `kind:"append"` extends from `fromIndex` (last
pushed turn may have grown — streamed text, via a per-subscription `fs.watch` on the
JSONL, 500ms debounce); non-turn fields ride every event, omitted = cleared. The
client is apply-only — no heuristic merges — and layers status overlays on top
(send/approve → `running`, interrupt → `ready`) that retire on confirmation or
expiry, **never contradiction**, so a pre-action snapshot can't clobber them
backwards. Server snapshots stay truthful (no server-side provisional status).
`state.json` is fs-watched (3s poll only as fallback). GET endpoints, the 40s iOS
zombie watchdog, heartbeat/consumer markers, and the conditional safety polls all
remain as fallbacks; pushes supersede in-flight GETs via the request-seq guards.
Decision record + rejected WebSocket design: [ADR 18](docs/adr/0018-versioned-state-push.md).

### Portkey model/effort switcher

`/model` or `/effort` in the phone composer opens a selection sheet; tapping an option `POST`s to `/sessions/:id/config`, which sends the arg-form slash command via the existing send path and toasts Claude's confirmation. Validated against `MODEL_ARGS`/`EFFORT_ARGS` (`session-api.ts`). Scoping, the statusline prerequisite and the smoke test: [ADR 4](docs/adr/0004-model-effort-switcher-scope.md).

### Portkey background work (scripts + subagents, one surface)

A session waiting on a `run_in_background` script (e.g. pr-triage's Codex wait loop) genuinely ends its turn — status correctly reads `ready` — so the phone showed no sign it was mid-work. Scripts and async agents are the same harness machinery (tasks + `<task-notification>`), so they share one surface. `core/background-tasks.ts` recovers pending scripts by pairing background launches against notification records; label = the tool call's `description`, falling back to the raw command. Detection rules (each validated against real transcript history): the tool_result must *confirm* task creation (a denied/failed launch never notifies; a sync Agent result is its report; a foreground command that merely prints launch-shaped text can't match), and notifications arrive via three carriers (`user` message, `queue-operation`, queued_command `attachment` — the latter two when the session is mid-turn). Prototype that validated the rules: branch `proto/bg-task-detection`. Visibility only, by decision: dead/infinite scripts make "pending" unreliable as a status or notification input.

- **Sessions list**: `⏳` inline before the row name (inside `.name`, so the sub line keeps the column's left edge), and script-waiting sessions count into the header's `🔄` chip — churning-without-needing-you is the same answer that chip gives (`pendingScripts` count on the list payload via `pendingScriptsAt`, computed for live-process sessions only — without a Claude process the notification can never arrive, so a dead session would badge forever). Transcript-pending is additionally verified against reality by a runner-liveness probe (`liveScripts`): the runner holds an open fd on its `tasks/<id>.output` file for its whole life, so `lsof` on that path definitively separates a live wait from an orphan — a session resumed under a new Claude process orphans its tasks (runner dead, notification never comes, transcript says "pending" forever). Dead verdicts are terminal and cached; alive re-probes on a 15s TTL, applied per read (never from the mtime-keyed cache — a runner can die while the file sits still). Flip side: an intentionally-infinite background daemon shows for as long as it truly runs.

Liveness lives in `core/runner-verdicts.ts`, the single answer to "is this runner alive?" for all three processes. Two properties shape it. **One `lsof` per probe round, never one per task** — `lsof` walks every process's fd table, so it costs ~115ms no matter how many paths it is asked about; probing serially made startup scale with accumulated orphans (7 orphans = 807ms of a 985ms TUI launch, growing over time). Verdicts come from parsing its `-F n` output, not its exit code, since one missing path makes it exit non-zero while still reporting the rest, and matching is on `realpath` because `lsof` reports resolved paths (`/tmp` → `/private/tmp`) — raw string matching would silently call a live runner dead. **One file per task id** under `verdicts/` (atomic temp+rename), like `savePaneSessions` does per pane: the TUI, monitor and bridge probe overlapping-but-different task sets concurrently, and a single shared JSON file loses a writer's slice whenever two callers re-read before either writes.
- **Navbar pill**: mint per-kind counts while anything is live (`🤖 2`, `⏳ 1`, `🤖 2 ⏳ 1`), dim `🤖 total` when everything's finished — a status while live, an archive entry point after (the drill-in is the only place a phone user can read a finished agent's report, since tool_results are stripped from the thread). The 15s safety poll runs while any background work is live.
- **Sheet** (tap the pill): pending scripts first (mint dot, `script · age` sub, inert — no conversation behind a shell loop), then running agents, then agents finished **since your last typed prompt** (fresh reports), then older collapsed behind one "N earlier agents" toggle. Boundary: `lastPromptAt` on the transcript payload (`readLastPromptAt` in `core/last-turn.ts` — backward windowed scan for the newest *real* prompt per `isPromptRecord`) vs each agent's `finishedAt` (its immutable jsonl's mtime); unknown boundary errs toward fresh. Header is a state summary ("1 waiting on script · 2 running · 5 done"). Completed/killed scripts are deliberately absent (no artifact, no action).

Detail transcript payload carries `pendingScripts` (computed in the same cached full-read as the branch parse) + `lastPromptAt`; fixtures exercise the full grouping and `bun run shoot` captures the open sheet as `agents.png`.

### Portkey changed-files viewer

A changed-files strip at the end of the thread → full file list → per-file diff. Backed by `core/repo-files.ts` (`branchChanges`, `fileDiff`, `safeRepoPath`) via `GET /sessions/:id/changes` and `/sessions/:id/diff?path=`, both containment-guarded to the session's repo root.

- The strip carries totals, PR state and the baseline — **no file preview**. The list is ordered latest-modified, so the first N of a 144-file branch are an arbitrary sample that reads as a summary. It's styled as thread furniture (full-bleed, unfilled, hairline-ruled), because a filled rounded box on `--surface` is exactly an assistant bubble.
- Diffs are re-indented to 2 spaces per level for phone width (`narrowIndent` in `shared/diff-lines.js`): leading whitespace only, levels preserved, so a tab-indented repo stops spending 8 columns per level. Display transform — the patch and the file are untouched.

- **Baseline** is the merge-base with the default branch — committed *and* uncommitted work, plus untracked files as all-additions. Every surface labels it `branch vs base`. Why, and why not transcript attribution: [ADR 2](docs/adr/0002-changed-files-baseline.md).
- **Scope** is a glance, not code review — no file browsing, line numbers, or approval-time diffs, by decision: [ADR 1](docs/adr/0001-changed-files-is-a-glance-surface.md).
- Patch rendering lives in `shared/diff-lines.js` (served unbuilt as `/diff-lines.js`, tested in `bun test`). It is hunk-aware on purpose — matching git's header patterns against every line eats real content, e.g. a deleted `-- ` line.
- Every git pathspec goes through `literal()` — a filename can contain glob metacharacters (`app/[slug]/page.tsx`).
- `/changes` has a 1s TTL cache; `/diff` reuses it to resolve a rename's old path, so a file-list row shows the true rename without carrying the old path itself.
- Edit/Write chips in the thread are informational only — filename bright, directory dimmed/shrinking (the changed-files list's span pair). They deliberately don't open a per-edit diff: a chip's path often can't resolve inside the session's repo (removed worktree, scratchpad or `~/.claude` edits), and the branch-vs-base answer is time-skewed for old chips. The changed-files page is the one diff surface.
- The file list's top row links out to the branch's GitHub PR (`core/pull-request.ts` → `GET /sessions/:id/pr`, 60s TTL since it shells out to `gh`). Depth lives in the PR, not here; a merged PR is a "this session is done" signal. Why this instead of an in-app reviewer, and the variants rejected: [ADR 5](docs/adr/0005-link-out-to-the-pull-request.md).

**What's pushed vs what isn't.** The file list is grouped by how far the work has travelled — the chain `base → origin/<branch> → HEAD → worktree`, giving `On GitHub` / `Committed, not pushed` / `Uncommitted` (`syncTiers` in `core/repo-files.ts`, on the `/changes` payload so the card and the list can't disagree). Each group is a real diff range with its own files, its own per-file and total LOC, and its own patch: a row carries `from`/`to` into `/diff`, which routes to `rangeDiff` for the two ref-to-ref groups and to `fileDiff` with a start-ref override for the worktree one (that group still needs the untracked fallback and the NFD/NFC pathspec retry). A file pushed and then edited again appears in two groups with that segment's churn in each, so the list header states the baseline and no total — summing groups would double-count it. Groups are always expanded; empty ones are dropped; the card trades the PR's LOC for `● N not pushed` (the *distinct* union of the two un-landed groups) or `● never pushed`.

Two invariants: both ref-to-ref ranges are **three-dot** revspecs passed as one string (`git diff A B` means `A..B`, which turns a remote-only file into a phantom `D` row when the remote is ahead, and one per commit the base moved past after a rebase), and the remote is `origin/<branch>` **by name** — `@{upstream}` points at `origin/main` for a feature branch in two live repos, `@{push}` errors on both. `/diff` honours only a `from`/`to` pair its own chain published; anything else degrades to the branch-vs-base diff, since the endpoints reach git as a revspec. Chain model, and why this doesn't contradict ADR 2: [ADR 11](docs/adr/0011-pushed-vs-unpushed-is-a-tier-chain.md).

### Portkey stop + restore-on-revert

Double-tap Stop sends Escape. Claude Code then either **reverts** the prompt (pre-stream + empty input: text moves back into the Mac's input box; JSONL shows a childless bare-leaf prompt, no marker) or **keeps** it (an interrupt marker is written; occupied input or stream already started). Portkey mirrors the TUI: on a confirmed revert the client prefills the composer with the sent text (`interruptRestore` in `app.js`, keyboard raised gesture-time on the Stop tap), hides the dangling leaf from the thread (transient, self-heals at next send), and clears the pane's input copy via `POST /sessions/:id/clear-input` — otherwise the parked text flips every future stop into a keep. Kept interrupts stay in the thread with the interrupt line, no restore. The send path's draft guard kills the whole draft row-by-row into the kill-ring (`killInput` — one `C-u` only kills the cursor's display row; never send `Up`, it recalls history) and restores it with a single `C-y`. Lab-verified rules + rejected designs: [ADR 9](docs/adr/0009-interrupt-revert-mirroring.md).

### Portkey bash commands (`!`)

`!cmd` writes two adjacent user JSONL records (`<bash-input>`, then `<bash-stdout>/<bash-stderr>`); the parser folds them into one `bash` turn (`foldBashTurns` in `core/transcript.ts`), rendered terminal-style — right-aligned peach mono command bubble, output as a mint/red rail with an 8-line clamp. Optimistic/queued `!` sends render the same bubble and retire against `"!" + command`. Bash turns ARE rewind checkpoints (Claude's picker lists them — the deliberate opposite of slash-command turns). The composer flips into **bash mode** on a `!` opening an empty draft — typed, or pasted as the whole draft (glyph in-field, textarea remounted with autocorrect off — iOS honors the attributes only at focus time); a `!` mid-draft never flips it (a copied snippet containing `!` keeps its meaning, matching the pane). `sendMessage` pre-flights `shellModeInput` (`core/session-api.ts`): a queued bang leaves the pane's prompt IN shell mode, where the `❯`-keyed draft guard is blind and a plain send would execute as bash — an empty shell prompt is cleared with `BSpace` + re-verify, one holding text aborts with reason `shell-draft` (no kill-ring gamble). Decision record: [ADR 12](docs/adr/0012-bang-commands.md).

### Portkey fork session

The long-press session sheet (alongside Archive) offers **Fork session** — same mechanics as the TUI `f`: `POST /sessions/:id/fork` → `forkSession` (`core/session-api.ts`) mints a fork id, launches `claude --session-id <forkId> --resume=<parent> --fork-session` in a new unfocused window (`launchForkWindow`, `-a -d`), blocks until the prompt is live, then returns the fork id. The sheet uses a two-tap confirm (non-destructive → mint fill, not red); the client shows the new-session `launching …` hint and opens straight into the fork.

- **Fork transcript seeding** (`seedForkTranscript`): Claude writes a fork's JSONL *lazily* — nothing lands on disk until the fork's first turn. On the phone that meant (a) an empty conversation and (b) the fork missing from Home (discovery blanks a live pane's id when no JSONL backs it — `buildActiveSession`). So after boot (before any turn — Claude hasn't created the file yet), `forkSession` copies the parent's transcript to the fork's path (`projects/<encode(effectivePath)>/<forkId>.jsonl`). Claude then treats it as the session history and *appends* the first turn (verified: no duplication) — so the fork is readable and discoverable immediately, and diverges cleanly on first message. Best-effort; a failed seed degrades to empty-until-first-turn.

### Portkey inbox (Home)

Home is the inbox (ADR 0013 addendum 6): the same lifecycle sections as the Mac sidebar — Needs You → Running → Parked → Recently done — served pre-sectioned by the bridge. `/sessions` returns `{sessions, inboxStale}`: rows the store knows arrive first in section order with per-row `inbox: {section, since, wakeAt?, note?, woken?}` meta; rows without a store row (idle panes, History-bound archived) follow untagged — never rendered in the home list, but they back the client's by-id lookups. **Section brain = the store side exclusively** (`composeSessions` → `deriveSections`, ordered by `orderInboxRows` in `bridge/inbox-payload.ts`); **row detail = the bridge side exclusively**, joined by id. Snapshot-only ids (pane-less parked/done outside discovery's window) get a minimal projected row + `restoreState`; discovery-only newborns (born since the daemon's last 3s tick) map directly from status (running → Running, live prompt-sitters → Needs You, `since = now`) and append within their section. `inboxStale: true` (snapshot older than 10s / absent) shows a banner — verbs still work, the store doesn't need the daemon.

- The inbox is the only home view (the transitional classic repo-grouped list and its toggle are removed). No navbar ⚡/🔄 chips — section header counts carry that answer (the 🤖 pill stays).
- **Verbs** live in the long-press sheet: Snooze (presets `1h/4h/Tomorrow 8AM/3d/7d` → `POST /sessions/:id/snooze {preset}`), Block (free-text note, empty allowed), Unsnooze/Unblock (parked → `/unpark`, reason `manual` so discovery preserves the pane-less row), Un-archive (done rows). Snooze/block kill the pane best-effort like the sidebar's verbs; disposing the open session drops back to the list. `/archive` also writes the store's Done fact — gated on the pane-kill succeeding or the row already being pane-less per the bridge's own discovery, never blanket no-pane (the pane-resolution race in `core/session-api.ts` would otherwise orphan live panes invisibly).
- **Day-snooze semantics fork** (user-decided): phone day presets wake at **8AM local** on the target calendar day (`presetWakeAt`); Mac digits-then-unit day snoozes are **exact relative** (`wakeAt`, 1d = 24h — revised from local-midnight when this shipped). The snooze disposition records the setter device (`device_id`), and the wake pass pushes to that device on either daemon platform (darwin keeps its banner beside the push; a phone-less snooze broadcasts only off-darwin, where no banner tier exists).

## Inbox sidebar + daemon (ADR 0013)

Sessions carry a lifecycle (Needs you → Running → Parked → Recently done); a per-window tmux sidebar is the surface, `claude0 daemon` is the engine. Decision record: [ADR 13](docs/adr/0013-inbox-lifecycle-model.md) + its addenda (the second is the settled interaction grammar; the sixth is the portkey inbox).

- **`claude0 daemon`** — launchd-kept-alive (`com.claude0.daemon`, installed idempotently by `claude0 setup`; plist pins the PATH bun symlink, bootstrap verifies+retries around launchd's bootout race). On a Linux VM host it's the `claude0-daemon.service` user unit instead, installed by `claude0 setup` host provisioning (launchd is skipped off-darwin); the wake alert there is a Web Push — targeted at the setter device when the snooze was set from portkey (the disposition records its `device_id`), broadcast to every device otherwise, since a headless host has no banner tier; a darwin-hosted daemon adds the same targeted push beside its banner. At cutover, `inbox.db` rides the state copy and the Mac agent is booted out — one host owns the inbox (historical cutover record: `docs/history/vm-cutover-runbook.md`). Owns three duties: the **snooze wake pass** (`core/inbox-wake.ts`, every 15s: due snooze + no live pane → detached `claude -r` with an in-pane wake banner, attention stamped into state.json only after detected status `ready` — boot spinner reads as running and the monitor's carry-over would eat an early stamp — then the macOS banner tier; `markAutoResumed` is an atomic claim so overlapping wakers can't double-spawn); **discovery snapshot production** (`core/inbox-discovery.ts`, every 3s in a fresh child process — in-process discovery leaks — the snapshot table's owner; the bridge's `seedSnapshotRow` is the only other writer, insert-if-absent only); and the **sidebar renderer**.
- **Single renderer** (`src/sidebar/renderer.ts`): ONE process paints every window's sidebar pane by writing ANSI to the pane tty (a pty-slave write IS pane output). Panes are dumb shell stubs (`: sidebar-pane; stty raw -echo; … | nc -U sidebar.sock`) that relay stdin bytes back; DECSET 1004/1006 written to the tty route focus + SGR mouse through the same relay. Per-line diff painting; a vanished tty (pane respawn allocates a new pty) re-resolves and repaints. The renderer self-installs tmux wiring (sidebar focus/toggle keys from config `tmux.keys` — defaults M-s/M-S; last-installed keys remembered in `sidebar-keys.json` so a change unbinds the old ones — plus after-select-window bounce hook and after-copy-mode eject hook: copy mode on a stub is always accidental and gets cancelled instantly) on stand-up and every 30s — a tmux server restart is rewired within a tick, no tmux.conf hook. The popup/next bindings come from the same `tmux.keys` config, rendered into the tmux fragment by `claude0 setup` (tmux notation: `"prefix a"` = prefix table, bare `"M-s"` = root table, modifier required). Propagation: popup/next changes apply on the next `claude0 setup` run; sidebar key changes need a daemon restart (the daemon loads config once at startup).
- **Model** (`core/inbox-model.ts`, pure): wake math (Mac digits-then-unit snoozes are exact relative offsets on both units, 1d = 24h; phone presets via `presetWakeAt` — hours exact, day presets at 8AM local on the target calendar day), section derivation (`sectionOf`/`effectiveSince`/`deriveSections`), snapshot+overlay composition. **Every live prompt-sitter files under Needs You** — the aim is to clear it by actioning (reply, snooze, block, done). A transition-gated admission with a neutral OPEN bucket shipped first and was retired after living with it (it hid rows that still wanted a decision); observed running→ready/waiting transitions are still written as `transition` events for the scoreboard. status-right carries the Claude0 scoreboard: `⚡N 🔄N ✓N` where ✓ = distinct sessions archived since local midnight. View building is pure too (`src/sidebar/rows.ts`) and input decoding (`src/sidebar/input.ts`) — both tested without tmux. A snapshot row preserved without a live pane (parked/done/restored) gets its stale `real`/`running`/`script` stripped by discovery, so Enter resumes instead of chasing the killed pane.
- **Store** (`core/inbox-store.ts`, bun:sqlite WAL at `~/.config/claude0/inbox.db`): authored facts (dispositions/archived/events/links) in their own tables; the activity snapshot is opaque JSON replaced by discovery each tick — `saveSnapshot` keeps fact-holding rows the new set doesn't cover, so a bridge verb that seeds a row mid-tick (`seedSnapshotRow`, the one non-discovery snapshot writer) can't be wiped before the preserve rule sees it; `PRAGMA data_version` is the cross-process change poll.
- **tmux gotchas paid for in blood**: tmux sanitizes control chars to `_` in `-F` output for clients running OUTSIDE tmux (the daemon, always) — never use `\t` separators, use a printable one with free-text fields last; Bun's `setInterval` waits for an async callback's promise, so the render loop is a self-scheduling loop with a 10s watchdog. From the tty-less daemon: a non-detached `new-window` NEVER returns (always `-d`, then `select-window`); a multi-argument window command is direct-exec'd with NO shell (daemon PATH has no `claude` → instant silent exit) — pass ONE string so `$SHELL -c` runs it and zshenv restores PATH; `display-message -p -t %dead` exits 0 against a fallback pane (tmux 3.7b) — probe pane liveness with `list-panes -t %id` (`paneLocation` in the renderer). Selecting a window in an UNATTACHED tmux session is invisible — `switchTo` follows up with `switch-client` for any client looking elsewhere. A stub that outlives a renderer restart holds a dead relay (`cat` blocks on tty read, notices the vanished socket only by eating a keystroke) — the renderer respawns all stubs at stand-up.
- **Markers** (`~/.config/claude0/`): `inbox-sidebar-autostart-default` = sidebar on; `inbox-sidebar-hidden-default` = M-S hid it (all self-heal stands down).
- Interaction grammar (keys, snooze digits-then-unit, disposition walk, select-then-commit clicks, section-scoped verbs) is documented in ADR 0013 addendum 2 and `prototype/inbox-sidebar/README.md`; addendum 7 revises it: Needs You floats open questions/approvals in a top band, Enter is select-then-commit across windows (show + sidebar-focused first, commit into the pane on the row you're already showing), and Enter on Parked/Recent is a peek — disposition stays, engagement (a prompt newer than the peek) graduates it, and an unviewed peek window is reaped after 60s.

## Conventions

- **Runtime**: Bun only — `Bun.$` for shell, `Bun.file()` for IO, `Bun.Glob` for scanning
- **UI**: blessed with `tags: true` for inline color (`{#FFC799-fg}text{/#FFC799-fg}`)
- **Types**: all in `src/types.ts`. `DisplayRow` = `"repo-header" | "separator" | "session" | "session-detail" | "archive-collapsed"`
- **Error handling**: all shell/IO in try/catch returning empty defaults. Never crash the TUI
- **No external deps** beyond `blessed`
- **Transcript IO in long-lived processes** (bridge, daemon): stream via `jsonlLines()` or windowed byte reads — never `.text()` a multi-MB JSONL. Freed malloc pages don't return to the OS, so one full read permanently ratchets RSS (bridge hit a ~1GB plateau with a 3MB JS heap; `Bun.gc(true)` doesn't lower it)

## Vesper Color Palette

```
bg=#101010  fg=#FFFFFF  muted=#A0A0A0  dim=#505050
surface=#1C1C1C  peach=#FFC799  mint=#99FFE4  red=#FF8080
```

Status: waiting/ready=peach, running=mint, idle=dim.

## Safety

TUI refuses to run without a TTY (`process.stdout.isTTY` check). Rationale: [ADR 3](docs/adr/0003-tui-requires-a-tty.md).

## Session persistence (optional tmux-resurrect integration)

Claude0 can save and restore Claude Code sessions across tmux server crashes when paired with tmux-resurrect (and optionally tmux-continuum for auto-save).

### How it works

1. **On save** (`claude0 save-sessions`): Snapshots a mapping of stable tmux coordinates (`session:window.pane_index`) to Claude session UUIDs **and each session's cwd**, written to `~/.config/claude0/resurrect-sessions.json`. This uses data already tracked by Claude0's SessionStart hook in the per-pane files under `panes/`. A pane reporting `$HOME` never overwrites a real repo path already recorded for that session (`pickSavedCwd` in `core/resurrect.ts`) — a restored pane that hasn't got its directory back yet would otherwise poison the entry permanently.

2. **On restore** (`claude0 restore-sessions`): After tmux-resurrect restores panes (as empty shells), reads the saved mapping, matches coordinates to the newly created panes, and sends `cd <dir>; claude --resume=<sessionId>` in each via `tmux send-keys`. Skips panes that already have a foreground process, and skips a coordinate whose session id was already resumed this pass (one id can sit at two coordinates; resuming it twice leaves two processes fighting over one transcript).

   `<dir>` comes from `resolveRestoreTarget` (`core/resurrect.ts`), which tests `$HOME` **first** — `$HOME` is always a live directory, so a generic exists-check would shadow the case this exists to repair. Order: saved cwd is `$HOME` → Claude's last-recorded cwd from the transcript; saved cwd still on disk → itself; saved cwd gone (deleted worktree) → its base repo, via `recoverWorktreeTranscript` so the resumed session isn't tailing a frozen transcript copy; otherwise no `cd` at all. The separator is `;`, not `&&`, so a failed `cd` still leaves the session resumed.

### Setup

Add these hooks to your `tmux.conf` alongside the tmux-resurrect plugin config:

```
set -g @resurrect-hook-post-save-all 'claude0 save-sessions'
set -g @resurrect-hook-post-restore-all 'claude0 restore-sessions'
```

If using tmux-continuum for auto-save, the save hook runs automatically on each periodic save. The restore hook runs when `@continuum-restore 'on'` triggers a restore on server start.

`@resurrect-processes` must never include `claude`: resurrect's process restore spawns a *fresh* claude while `claude0 restore-sessions` resumes the real one — two processes fighting over one transcript ([ADR 16](docs/adr/0016-systemd-units-replace-launchd.md)). On a VM host, tmux itself runs as a systemd user unit whose `ExecStop` triggers `claude0 save-sessions` (`config/units/tmux.service`).

### Commands

| Command | Description | When called |
|---------|-------------|-------------|
| `claude0 save-sessions` | Snapshot pane→session map using stable tmux coordinates | tmux-resurrect post-save hook or manually |
| `claude0 restore-sessions` | Launch `claude --resume` in restored panes | tmux-resurrect post-restore hook or manually |

### Data flow

Save: `panes/` per-pane files (paneId→sessionId) + `tmux list-panes` (paneId→coordinate+cwd) + the previous map (for `pickSavedCwd`) → `resurrect-sessions.json` (coordinate→{sessionId, cwd})

Restore: `resurrect-sessions.json` (coordinate→{sessionId, cwd}) + `tmux list-panes` (coordinate→new paneId) → `resolveRestoreTarget` (cwd→directory to resume in) → `tmux send-keys` (`cd <dir>; claude --resume` in each pane)

### Limitations

- Requires Claude0's SessionStart hook to be installed (`claude0 setup`) so pane→session mappings are tracked.
- The mapping is only as fresh as the last save. Sessions started after the last save won't be in the map.
- Pane coordinates rely on tmux-resurrect restoring the same session/window/pane layout. Manual tmux reconfiguration after restore may shift coordinates.

## Key references

- `docs/adr/` — decision records: why something is the way it is, and what was rejected
- `docs/portkey-design-loop.md` — how to view/drive portkey in a real browser (fixtures bridge + inspect-ui)
- `ideas.txt` — feature backlog (worktrees, search, Cursor integration, etc.)
- Session data: `~/.claude/projects/*/sessions-index.json`
- Session logs: `~/.claude/projects/*/{sessionId}.jsonl`
- Config/state: `~/.config/claude0/{config,state,names}.json`
- Pane→session map: `~/.config/claude0/panes/` (one file per pane, written by the SessionStart hook)
- Hook script: `~/.config/claude0/hooks/session-start.sh` (installed by `claude0 setup`)
- Resurrect map: `~/.config/claude0/resurrect-sessions.json` (coordinate→sessionId, written by save-sessions)
- Web Push state: `~/.config/claude0/push-vapid.json` (VAPID keypair), `push-subscriptions.json` (deviceId→subscription), `consumers/<deviceId>` (per-device SSE liveness), `source/<sessionId>.json` (which device drove the turn), `pushed/<deviceId>.json` (recent-push ledger for notification-tap attribution, delete-on-read)
- Script-wait cache: `~/.config/claude0/script-wait.json` (per-session transcript parse for the ⏳ prefix, keyed by size+mtime), `verdicts/<taskId>` (per-task runner-liveness verdicts, shared by TUI + monitor + bridge)
- Debug log: `~/.config/claude0/debug.log` (monitor debug, create file to enable)
