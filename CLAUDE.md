# Claude0

Terminal TUI (blessed) + phone web app ("portkey") for managing Claude Code sessions: live status detection, attention notifications, AI naming, an inbox lifecycle, and a mobile bridge. Runs on macOS (Ghostty + tmux) or a Linux VM host — per-machine roles: [ADR 22](docs/adr/0022-per-machine-roles.md).

This file is the map. Vocabulary lives in [CONTEXT.md](CONTEXT.md); decisions **and feature mechanism** live in [docs/adr/](docs/adr/) — when you change how a feature works, update its ADR (add a dated addendum), not this file. New features get a new ADR, not a new section here.

## Commands

```sh
bun run start             # Run TUI
bun run dev               # Watch mode (--watch)
bun run status            # Tmux status-right monitor
bun test                  # Run tests (bun:test)
bun run typecheck         # tsc --noEmit (bun runs no type checks itself)
bun run bin/claude0.ts <cmd>   # Test any subcommand without installing (e.g. `list`)
```

Entry: `bin/claude0.ts` (CLI router) → `src/index.ts` (TUI) or `src/cli.ts` (subcommands). `claude0 --help` lists all subcommands; `claude0` and `c0` are the same installed entry.

## Ops duties (do them directly)

These are routine, durably-authorized actions — **do them yourself, don't just tell the user**:

- **Bridge restart** after changes to `src/bridge/server.ts` or the `core/` functions it imports (loaded into the running process): `systemctl --user restart claude0-bridge`; logs: `journalctl --user -u claude0-bridge`. NOT needed for `src/bridge/public/*` — served fresh with `cache-control: no-cache`; the user refreshes the page ([ADR 21](docs/adr/0021-offline-app-shell.md)). The token lives in a 0600 `EnvironmentFile`, so a plain restart preserves it. Verify: `POST /auth` → 200 and the changed route behaves.
- **Daemon restart** after changes to `src/sidebar/`, `core/inbox-*.ts`, or config the daemon loads at startup (e.g. `tmux.keys` sidebar keys): `systemctl --user restart claude0-daemon` (launchd on a Mac host).
- **Re-run `claude0 setup`** after changes to tmux/zsh fragments, systemd/launchd units, or CLI entry routing — that's how they propagate to the installed machine.

## Orientation

- `src/core/` — pure/IO logic shared by all processes (discovery, tmux, status, git, inbox, transcripts). `src/ui/` — blessed TUI. `src/bridge/` — phone HTTP server + `public/` client. `src/sidebar/` — inbox sidebar renderer. `src/monitor.ts` — status-right poller. Types in `src/types.ts`.
- Four long-lived processes share state through `~/.config/claude0/` (config.json, state.json, panes/, verdicts/, …): TUI (fresh per popup), monitor (fresh per tick), daemon, bridge.
- Session discovery correlates Claude process TTYs with tmux pane TTYs, plus per-pane files under `panes/` written by the SessionStart hook (`claude0 setup` installs it). Session data: `~/.claude/projects/*/{sessions-index.json,<id>.jsonl}`.
- Driving portkey in a real browser (fixtures bridge + inspect-ui): [docs/portkey-design-loop.md](docs/portkey-design-loop.md). Backlog: `ideas.txt`.

## Conventions

- **Bun only** — `Bun.$` for shell, `Bun.file()` for IO, `Bun.Glob` for scanning. No external deps beyond `blessed`.
- **No migration/back-compat shims.** The installed base is ~one user: when a config/cache/file format changes, delete the old path and reset to defaults — never write legacy-key handling or migration code.
- **config.json holds user-taste knobs only** (abbreviations, keys, roots, notification prefs, snooze presets). Internal timings, TTLs, and heuristics stay hardcoded — being tunable isn't qualification ([ADR 20](docs/adr/0020-config-defaults-live-in-code-setup-materializes.md)).
- **Intertwine only with tmux and mosh.** Any terminal (Ghostty), notifier, or host tool is a configurable default, never a hard dependency ([ADR 19](docs/adr/0019-presence-is-client-activity-everywhere.md)/[23](docs/adr/0023-dotfiles-independence.md)).
- Multiple agents (and the user) often work uncommitted in this same checkout on `main` — before diagnosing a test failure or "fixing" an unfamiliar diff, check it isn't someone's live work; re-run first.
- **Worktree-first opt-out**: single-dev repo — work directly in this base checkout, no worktree. Exception: if `git status` shows uncommitted changes in files your task will touch, create a worktree per the global rule.
- All shell/IO in try/catch returning empty defaults — never crash the TUI.
- Stream transcript IO in long-lived processes (`jsonlLines()` or windowed byte reads) — one `.text()` of a multi-MB JSONL permanently ratchets RSS (freed malloc pages don't return to the OS; the bridge hit a ~1GB plateau on a 3MB heap).
- Vesper palette: `bg=#101010 fg=#FFFFFF muted=#A0A0A0 dim=#505050 surface=#1C1C1C peach=#FFC799 mint=#99FFE4 red=#FF8080`. Status colors: waiting/ready=peach, running=mint, idle=dim.
- Window names are `[⚡|🔄|⏳]{repo}[/{ai-name}]`; the monitor is the sole window-*writing* authority ([ADR 14](docs/adr/0014-presence-is-client-activity.md) addendum) — name *generation* is shared with the bridge ([ADR 28](docs/adr/0028-ai-only-session-naming.md)).

## Gotchas (paid for in blood)

tmux, from a tty-less process (daemon/bridge — always "outside tmux"):
- Never use `\t` (any control char) as a `-F` separator — tmux sanitizes control chars to `_` for outside clients. Printable separator, free-text fields last.
- A non-detached `new-window` NEVER returns. Always `-d`, then `select-window` — and follow with `switch-client`, because `select-window` in an unattached session is invisible.
- Pass window commands as ONE string so `$SHELL -c` runs them — multi-arg is direct-exec'd with no shell, and the daemon's PATH has no `claude` → instant silent exit.
- Probe pane liveness with `list-panes -t %id` — `display-message -p -t %dead` exits 0 against a fallback pane (tmux 3.7b).
- Bun's `setInterval` awaits an async callback before rescheduling — long loops must be self-scheduling with a watchdog. (All: [ADR 13](docs/adr/0013-inbox-lifecycle-model.md) addenda.)

Sending keys to a Claude pane:
- Never send `Up` to clear or recall a draft — it recalls prompt history. One `C-u` kills only the cursor's display row; draft clearing is the `killInput` walk, restored with a single `C-y` ([ADR 9](docs/adr/0009-interrupt-revert-mirroring.md)).
- The `❯`-keyed input probes are blind to a shell-mode prompt — a plain send into it executes as bash. Pre-flight `shellModeInput` ([ADR 12](docs/adr/0012-bang-commands.md)).
- Never fire a bare digit without pre-flighting a fresh capture — permission prompts are digit-actionable and a focused free-text row turns digits into text ([ADR 8](docs/adr/0008-question-hold-not-send-keys.md)).
- A fork's JSONL is written lazily and the SessionStart hook records the *parent* id for a `--fork-session` pane — trust neither for a fresh fork ([ADR 25](docs/adr/0025-fork-transcript-seeding.md)).

git, programmatically:
- Every pathspec goes through `literal()` (`core/repo-files.ts`) — real filenames contain glob metacharacters (`app/[slug]/page.tsx`); on macOS retry NFD/NFC (committed tree is NFC, working copy NFD) ([ADR 1](docs/adr/0001-changed-files-is-a-glance-surface.md)).
- Ref-to-ref diffs are three-dot revspecs passed as ONE string — `git diff A B` means `A..B` and grows phantom rows when the remote is ahead or the branch was rebased. The pushed-tier ref is `origin/<branch>` BY NAME, never `@{upstream}`/`@{push}` ([ADR 11](docs/adr/0011-pushed-vs-unpushed-is-a-tier-chain.md)).

Processes & caches:
- One `lsof` per probe round, never per item — it walks every fd table so it costs ~115ms flat; parse `-F n` output (exit code lies when one path is missing) and match on `realpath` ([ADR 26](docs/adr/0026-background-work-is-visibility-only.md)).
- Cross-process state with concurrent writers gets one file per key, atomic temp+rename (`panes/`, `verdicts/`, `consumers/`) — a shared JSON loses a writer's slice.
- Set attention/prefixes via `state.json` + `stripAllPrefixes()`/`desiredPrefix()` (`core/notifications.ts`) — never by string surgery on window names; the monitor repaints every tick.
- ⏳ (script-wait) is visibility-only — never feed it into notifications, attention, `claude0 next`, or sort order ([ADR 26](docs/adr/0026-background-work-is-visibility-only.md)).
- Presence is tmux client keyboard activity within 60s, tri-state — never "attached" or an OS frontmost probe ([ADR 14](docs/adr/0014-presence-is-client-activity.md)/[19](docs/adr/0019-presence-is-client-activity-everywhere.md)).- Never add `claude` to `@resurrect-processes` — resurrect would spawn a fresh claude while `restore-sessions` resumes the real one: two processes fighting over one transcript ([ADR 16](docs/adr/0016-systemd-units-replace-launchd.md)).

## Where the mechanism lives

| Area | ADRs | Entry points |
|---|---|---|
| Wrapping Claude Code (structured channels vs guarded keystrokes) | [6](docs/adr/0006-wrapping-claude-code.md) | `core/tmux.ts`, `core/session-api.ts` |
| Inbox lifecycle, sidebar, daemon, snooze/wake, portkey Home | [13](docs/adr/0013-inbox-lifecycle-model.md) + addenda (2 interaction grammar, 6 portkey inbox, 7 Enter/peek, 8 freshness/process shape) | `core/inbox-*.ts`, `src/sidebar/` |
| Presence, notification tiers, window prefixes | [14](docs/adr/0014-presence-is-client-activity.md), [19](docs/adr/0019-presence-is-client-activity-everywhere.md) | `core/presence.ts`, `core/notifications.ts` |
| AI session naming (generation, cache, label resolution) | [28](docs/adr/0028-ai-only-session-naming.md) | `core/names.ts`, `src/monitor.ts` |
| Web Push, per-device routing, tap attribution | [24](docs/adr/0024-web-push-replaces-ntfy.md), [10](docs/adr/0010-notification-taps-attributed-server-side.md) | `core/web-push.ts`, `shared/tap-target.js` |
| SSE sync — versioned state push, not doorbells; status overlays | [18](docs/adr/0018-versioned-state-push.md) | `bridge/stream.ts`, `shared/sync.js` |
| Changed-files viewer, baseline, pushed-vs-unpushed tiers, PR link | [1](docs/adr/0001-changed-files-is-a-glance-surface.md), [2](docs/adr/0002-changed-files-baseline.md), [11](docs/adr/0011-pushed-vs-unpushed-is-a-tier-chain.md), [5](docs/adr/0005-link-out-to-the-pull-request.md) | `core/repo-files.ts`, `shared/diff-lines.js`, `core/pull-request.ts` |
| Stop/interrupt revert mirroring, draft kill/restore | [9](docs/adr/0009-interrupt-revert-mirroring.md) | `core/session-api.ts`, `bridge/public/app.js` |
| Bash `!` commands, composer bash mode, shell-mode guard | [12](docs/adr/0012-bang-commands.md) | `core/transcript.ts`, `core/session-api.ts` |
| AskUserQuestion hold, "Chat about this" | [8](docs/adr/0008-question-hold-not-send-keys.md) | `core/tmux.ts` |
| Background scripts/agents surface (⏳, 🤖 pill), runner liveness | [26](docs/adr/0026-background-work-is-visibility-only.md) | `core/script-wait.ts`, `core/background-tasks.ts`, `core/runner-verdicts.ts` |
| Fork sessions, transcript seeding | [25](docs/adr/0025-fork-transcript-seeding.md) | `core/session-api.ts` |
| Image paste from a client Mac (Service hotkey → ssh → path paste) | [27](docs/adr/0027-image-paste-is-a-service-hotkey-plus-path-paste.md) | `core/image-paste.ts`, `src/paste-image.ts`, `config/service/` |
| Model/effort switcher | [4](docs/adr/0004-model-effort-switcher-scope.md) | `core/session-api.ts` |
| systemd units, tmux-resurrect pairing, restore-path resolution | [16](docs/adr/0016-systemd-units-replace-launchd.md), [23](docs/adr/0023-dotfiles-independence.md) | `deploy/`, `core/resurrect.ts` |
| Setup roles, config defaults, VM layout | [22](docs/adr/0022-per-machine-roles.md), [20](docs/adr/0020-config-defaults-live-in-code-setup-materializes.md), [17](docs/adr/0017-user-centric-development-layout.md), [15](docs/adr/0015-vm-home-is-users-throxy.md) | `src/cli.ts` (setup/doctor) |
| TUI requires a TTY | [3](docs/adr/0003-tui-requires-a-tty.md) | `src/index.ts` |
| Offline app shell | [21](docs/adr/0021-offline-app-shell.md) | `bridge/public/sw.js` |
| History depth | [7](docs/adr/0007-history-depth-is-claudes-retention.md) | `core/transcript.ts` |
| Transcript stitching across project dirs, compact-link recovery | [29](docs/adr/0029-transcripts-span-project-dirs.md) | `core/last-turn.ts`, `core/transcript.ts`, `core/session-api.ts` |
