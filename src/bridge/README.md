# Claude0 Bridge — mobile access

A thin `Bun.serve` HTTP/SSE server (`server.ts`) that exposes the headless
`core/` API + a no-build web page (`public/`) so you can drive Claude sessions
from an iPhone over Tailscale. Launched with `claude0 bridge`.

## Connect from your phone

### 1. Run the bridge on the Mac

Bind to **loopback** (the default) and keep the Mac awake:

```sh
caffeinate -s env CLAUDE0_BRIDGE_TOKEN=<your-token> claude0 bridge
# prints: claude0 bridge listening on http://127.0.0.1:8473
```

Generate a token once with `openssl rand -hex 32`. The bridge **refuses to start**
without `CLAUDE0_BRIDGE_TOKEN`, or if bound to a non-loopback / non-tailnet address.

The line above is for a quick foreground run. For an **always-on** bridge, run it as a
launchd service instead (auto-start on login, auto-restart on crash) — see [Run as a
service](#run-as-a-launchd-service-always-on) below.

### 2. Expose it over Tailscale with `tailscale serve`

macOS Tailscale runs in userspace mode and will **not** deliver inbound TCP to a
service bound on the tailnet IP — so don't set `CLAUDE0_BRIDGE_HOST=100.x`. Instead
proxy through tailscaled, which holds the tunnel:

```sh
tailscale serve --bg --http=8473 http://127.0.0.1:8473
tailscale serve status          # shows the tailnet URL
tailscale serve --http=8473 off # tear down
```

(GUI-app CLI lives at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.)

### 3. Open it in mobile Safari

Both devices on the same tailnet, then load the **MagicDNS hostname** (not the
`100.x` IP), typing `http://` explicitly so Safari doesn't hang trying HTTPS:

```
http://<your-mac>.<tailnet>.ts.net:8473/
```

Paste the token into the field → **Connect**. You'll see the live session list.

### Run as a launchd service (always-on)

So the bridge survives terminal close, logout, and crashes — instead of being held by
a foreground process. Write `~/Library/LaunchAgents/com.claude0.bridge.plist` (chmod `600` —
it holds the token), then load it. `KeepAlive` restarts it on crash; `RunAtLoad` starts
it at login. It binds loopback; `tailscale serve` (step 2) still fronts it.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claude0.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-s</string>
    <string>/opt/homebrew/bin/bun</string><string>--env-file=/dev/null</string>
    <string>/opt/homebrew/bin/c0</string><string>bridge</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE0_BRIDGE_TOKEN</key><string>&lt;your-token&gt;</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key><string>/Users/&lt;you&gt;/dev/claude0</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/&lt;you&gt;/.config/claude0/bridge.log</string>
  <key>StandardErrorPath</key><string>/Users/&lt;you&gt;/.config/claude0/bridge.log</string>
</dict>
</plist>
```

```sh
chmod 600 ~/Library/LaunchAgents/com.claude0.bridge.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude0.bridge.plist  # load + start
launchctl kickstart -k gui/$(id -u)/com.claude0.bridge                            # restart (after a code edit)
launchctl bootout gui/$(id -u)/com.claude0.bridge                                 # stop + unload
tail -f ~/.config/claude0/bridge.log                                              # logs
```

Editing bridge source still requires a restart — the server loads its modules at launch —
but it's now one `kickstart -k` instead of kill + relaunch.

## Using it

- **List** — sessions grouped by repo, status dots, live via SSE (no refresh).
  Archived sessions are hidden behind a "Show N archived" toggle. A session blocked
  on a question/tool shows a peach `⏸` and sorts to the top — even if discovery
  mislabels it archived — so you can always reach it to answer.
- **Tap a session** — transcript as a chat thread (auto-scrolled to the newest turn).
  Assistant messages are **markdown-rendered** (code blocks, lists, links — raw HTML
  escaped first); user messages stay literal. A status/usage sub-row under the title
  shows the live status dot and **context-window usage** (`current/size · pct%`),
  colored at the same 50/75% thresholds as the Mac statusline.
- **Navigate sessions** — `↑`/`↓` in the header step to the previous/next session in
  list order; a horizontal **swipe** does the same (left → next, right → prev). `‹`
  returns to the list.
- **Approve / answer / send** — a docked bottom bar swaps by state: a tool prompt
  shows Allow/Deny, an open `AskUserQuestion` shows answer chips, otherwise a
  free-text composer. The result (`✓` / `✗ reason`) is shown inline. All three need a
  **live tmux pane on the Mac**; free-text send works in any state (TUI parity — keys
  go to the pane, and Claude queues input while running), shown immediately as an
  optimistic bubble until the transcript catches up.
- **Names** — each session shows its tmux-style AI name (shared `names.json` cache).
  Unnamed coding sessions are named in the background (`claude -p`, lock-coordinated
  with the monitor); non-coding/trivial sessions fall back to a summary snippet.

## Local development & testing

Run the bridge on the Mac without a phone — bind loopback with a throwaway token:

```sh
CLAUDE0_BRIDGE_TOKEN=test CLAUDE0_BRIDGE_HOST=127.0.0.1 CLAUDE0_BRIDGE_PORT=8479 \
  bun run bin/claude0.ts bridge
```

**Hit the API.** The static shell (`/`, `/app.js`, vendor) is public; everything else
needs the cookie. Exchange the token once into a cookie jar, then reuse it:

```sh
curl -s http://127.0.0.1:8479/                                   # static shell + CSS (no auth)
curl -s -c /tmp/jar -X POST http://127.0.0.1:8479/auth \
  -H 'content-type: application/json' -d '{"token":"test"}'
curl -s -b /tmp/jar http://127.0.0.1:8479/sessions               # real core/ data, authed
curl -s -b /tmp/jar "http://127.0.0.1:8479/sessions/<id>/transcript?since=0"
```

**Fixtures mode** — set `CLAUDE0_BRIDGE_FIXTURES=1` to serve canned, deterministic data
(`fixtures.ts`: every status tier, a markdown turn, a tool chip, an open question)
instead of querying `core/`. Lets the UI render with no live sessions — ideal for
layout/CSS work. Auth + static serving stay real; only the data is faked:

```sh
CLAUDE0_BRIDGE_TOKEN=test CLAUDE0_BRIDGE_FIXTURES=1 bun run bin/claude0.ts bridge
```

**Screenshots** — `bun run shoot` boots the bridge in fixtures mode, drives headless
Chrome over the DevTools Protocol, and writes `login.png` / `list.png` / `detail.png`
(iPhone viewport) so you can visually verify changes without a device:

```sh
bun run shoot --out /tmp/c0-shots      # needs Google Chrome (or set CHROME=/path/to/chrome)
```

It sets the auth cookie via CDP (which bypasses `HttpOnly`), navigates, and captures each
screen; `--keep` leaves the bridge + Chrome up for poking around. Flags: `--port`,
`--cdp-port`, `--out`.

## Config

| Env var | Default | Notes |
|---------|---------|-------|
| `CLAUDE0_BRIDGE_TOKEN` | — | **Required.** Exchanged once via `POST /auth` for an `HttpOnly` cookie; never rides in a URL. |
| `CLAUDE0_BRIDGE_HOST` | `127.0.0.1` | Fail-closed to loopback / tailnet (`100.64.0.0/10`). Keep `127.0.0.1` when using `tailscale serve`. |
| `CLAUDE0_BRIDGE_PORT` | `8473` | |
| `CLAUDE0_BRIDGE_FIXTURES` | — | Dev/test only: serve canned data (`fixtures.ts`) instead of `core/`. See [Local development & testing](#local-development--testing). |

## Notes

- **HTTPS (optional, nicer):** enable *HTTPS Certificates* in the Tailscale admin
  DNS page, then `tailscale serve --bg --https=8473 8473` for a padlocked
  `https://<host>.<tailnet>.ts.net:8473/` — what `claude0 setup` installs on a Linux
  host. The bare `:443` URL is left free for other host services
  ([ADR 32](../../docs/adr/0032-portkey-serves-on-its-own-port.md)).
- **Plain HTTP over the tailnet is fine** for the MVP — the tailnet is the
  encrypted transport and the wall; the token is defense-in-depth.
- The bridge is a foreground/background process — it does **not** survive reboot
  yet. Wrap it in a launchd agent or a persistent tmux window to make it durable.
