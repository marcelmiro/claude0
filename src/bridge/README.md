# Claude0 Bridge — mobile access

A thin `Bun.serve` HTTP/SSE server (`server.ts`) that exposes the headless
`core/` API + a no-build web page (`public/`) so you can drive Claude sessions
from an iPhone over Tailscale. Launched with `claude0 bridge`.

## Connect from your phone

On a Linux host, `claude0 setup` installs the `claude0-bridge` systemd user unit (bound
to loopback) and serves it tailnet-only with `tailscale serve --https=8473 8473`. Open
`https://<host>.<tailnet>.ts.net:8473/` on the phone and add it to the home screen.

There is no token or login. The bridge admits two kinds of caller: anything addressing its
bind address (loopback tools, `claude0 doctor`) and the node owner's tailnet identity
arriving through Tailscale Serve, browser requests same-origin only
(`request-guard.ts`, [ADR 33](../../docs/adr/0033-bridge-access-is-identity-not-a-token.md)).
It refuses to start bound to a non-loopback / non-tailnet address.

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

Run a second bridge without a phone, bound to loopback on its own port:

```sh
CLAUDE0_BRIDGE_HOST=127.0.0.1 CLAUDE0_BRIDGE_PORT=8479 bun run bin/claude0.ts bridge
```

**Hit the API.** Requests addressed to the bind address are admitted as-is:

```sh
curl -s http://127.0.0.1:8479/sessions                            # real core/ data
curl -s "http://127.0.0.1:8479/sessions/<id>/transcript?since=0"
```

**Fixtures mode** — set `CLAUDE0_BRIDGE_FIXTURES=1` to serve canned, deterministic data
(`fixtures.ts`: every status tier, a markdown turn, a tool chip, an open question)
instead of querying `core/`. Lets the UI render with no live sessions — ideal for
layout/CSS work. Access control + static serving stay real; only the data is faked
(routes fixtures don't cover still run for real):

```sh
CLAUDE0_BRIDGE_FIXTURES=1 CLAUDE0_BRIDGE_PORT=8479 bun run bin/claude0.ts bridge
```

**Screenshots** — `bun run shoot` boots the bridge in fixtures mode, drives headless
Chrome over the DevTools Protocol, and writes `list.png` / `detail.png` and the other
screens (iPhone viewport) so you can visually verify changes without a device:

```sh
bun run shoot --out /tmp/c0-shots      # needs Google Chrome (or set CHROME=/path/to/chrome)
```

It navigates and captures each screen; `--keep` leaves the bridge + Chrome up for poking around. Flags: `--port`,
`--cdp-port`, `--out`.

## Config

| Env var | Default | Notes |
|---------|---------|-------|
| `CLAUDE0_BRIDGE_HOST` | `127.0.0.1` | Loopback only (`127.0.0.0/8`, `::1`), fail-closed: the tailnet reaches it through `tailscale serve`, which strips forged identity headers ([ADR 33](../../docs/adr/0033-bridge-access-is-identity-not-a-token.md)). |
| `CLAUDE0_BRIDGE_PORT` | `8473` | |
| `CLAUDE0_BRIDGE_OWNER` | derived | The tailnet login allowed in. Unset: the node's user, or on a tagged node the one person whose devices are its peers. Set it (in `bridge.env`) when a tagged node has several. |
| `CLAUDE0_BRIDGE_FIXTURES` | — | Dev/test only: serve canned data (`fixtures.ts`) instead of `core/`. See [Local development & testing](#local-development--testing). |

## Notes

- Portkey keeps an explicit port; the bare `:443` URL is left free for other host
  services ([ADR 32](../../docs/adr/0032-portkey-serves-on-its-own-port.md)).
