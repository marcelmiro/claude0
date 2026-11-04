# 32. Portkey is served on its own port, not the host's bare URL

Date: 2026-11-04
Status: accepted

## Context

Setup exposed the bridge with `tailscale serve --bg 8473`, which defaults to https
:443 — so portkey held the host's bare `https://<host>.<tailnet>.ts.net/`. Every
other page the host shares goes out as `:<port>`, and the bare URL is the one address
worth giving to something host-wide (the VM's dotfiles put a tunnels index there).
Portkey is one service among those, not the host's front page.

## Decision

**Setup serves portkey at https `:<bridge port>` (default `:8473`), matching its
loopback port, and leaves `:443` alone.** Doctor checks that exact shape.

## Consequences

- Moving portkey changed its origin. The installed PWA, its service worker, local
  storage and Web Push subscriptions are per-origin: the phone app is reinstalled
  from `:8473`, and push subscriptions registered from the old origin are dropped by
  hand (they would keep receiving pushes whose taps open whatever now owns `:443`).
- The old origin's service worker stays registered on the bare URL. It is
  network-first, so it passes through to whatever serves there.
- The sign-in cookie is host-scoped and cookies ignore ports, so a cookie set on the
  old origin still authenticates on `:8473`.
