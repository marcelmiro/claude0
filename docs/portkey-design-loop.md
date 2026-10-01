# Portkey design loop

How to view and drive portkey in a real browser to iterate on UI/UX, without
touching real sessions. Verified 2026-08-18 on the Linux VM host (Chrome at
`/usr/bin/google-chrome`).

## The loop

1. **Playground bridge** (fixtures, never real sessions):
   ```sh
   CLAUDE0_BRIDGE_FIXTURES=1 CLAUDE0_BRIDGE_TOKEN=design-token \
   CLAUDE0_BRIDGE_HOST=127.0.0.2 CLAUDE0_BRIDGE_PORT=8481 bun run bin/claude0.ts bridge
   ```
   Fixtures cover every status/section including woken/blocked/done rows;
   mutating POSTs are stubbed.
2. **Browser at phone viewport** via the `inspect-ui` skill:
   `session open "http://127.0.0.2:8481/" --width 390 --height 844`, then
   `act`/`shot`/`measure`/`a11y`.
3. **Login once per profile**: `act` → `type:input[type=password]:design-token`,
   `click:text:Connect`. The HttpOnly cookie persists in the debug profile —
   no re-login on later runs.
4. **Iterate**: edit `src/bridge/public/*` → reload/re-shot (served
   `no-cache`, no bridge restart). Server-side changes need the playground
   bridge process restarted.

## Gotchas

- **The auth cookie is per-HOST, not per-port** — two bridges on 127.0.0.1
  clobber each other's login. Bind the playground to `127.0.0.2` (loopback /8
  passes the bridge's fail-closed host check) so the real bridge
  (127.0.0.1:8473) and the playground keep independent cookies.
- **Never reuse the real bridge token for the playground.**
- `act` has no long-press primitive, so the session action sheet can't be
  opened by driving the UI — iterate on it via a temporary dev hook or
  on-device.
- First `session open` after Chrome auto-launch can report SESSION_STALE —
  re-open.

## Real-data variant

Same tool against `http://127.0.0.1:8473` with the token from
`~/.config/claude0/bridge.env` — read-only discipline: screenshots and opens are
fine; never tap approve/archive/send there.

`bun run shoot` captures the fixture screens headlessly
(login/list/detail/agents PNGs); `inspect-ui` is the interactive tool.

## Real Claude TUI lab

For behaviour that needs real Claude Code TUI states (dialogs, mid-turn
switches) without touching live sessions, the inbox, or the phone:

- **Lab Claude on its own tmux server:** `tmux -L c0lab new-session -d -s lab -c <scratch>`,
  then `claude --settings '{"disableAllHooks":true}'` (no hooks, so no events or
  panes file; this also disables the statusline). Restart it as
  `claude --resume <id> …` so `resolveSessionPane` resolves through the
  command-line fallback.
- **claude0 code against it:** run with `TMUX=/tmp/tmux-$UID/c0lab,0,0`, and every
  tmux call goes to the lab server.
- **Whole stack in a browser:** a second bridge with `CLAUDE0_HOME=<scratch>/c0home`
  (copy `names.json` and `config.json` in first, or it AI-names every archived
  session), the lab `TMUX`, `CLAUDE0_BRIDGE_HOST=127.0.0.3`, its own port and
  token. Its "inbox snapshot is stale" banner is expected (no daemon).
- **`/model` and `/effort` write the global `~/.claude/settings.json`.** Snapshot
  it before the lab and restore it afterwards.
- **Cleanup:** `tmux -L c0lab kill-server`, then delete the lab's
  `~/.claude/projects/*` dir, or it shows up in portkey history.
