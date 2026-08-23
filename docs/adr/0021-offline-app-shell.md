# 21. Portkey caches its app shell, network-first

Date: 2026-08-23
Status: accepted (partially reverses the sw.js "no caching" stance)

## Context

Every portkey launch fetched the full shell (`index.html`, `app.js`, shared
modules, vendor) live: the service worker deliberately cached nothing, and the
bridge serves the shell `no-cache` so the dev loop is refresh-serves-fresh. That
was fine while the network was assumed reliable. Investigation (2026-08-21)
showed it isn't: the phone's Tailscale tunnel goes down whenever the app is
backgrounded (iOS suspends the network extension) and black-holes traffic for
seconds-to-minutes after wake — tailscaled logs showed 443 handshakes dying at
exactly the phone's reconnect moments while SSH in the same second worked. With
no cached fallback, an app open during that window is a white screen for the
whole navigation timeout, and a standalone PWA never retries a failed
navigation: the only user remedy was force-quit-and-reopen until one attempt
happened to coincide with a live tunnel. Once loaded, the app was already
resilient (localStorage session snapshot, 20s boot timeout, reconnect banner) —
the gap was purely getting the shell to paint.

## Decision

`sw.js` gains a fetch handler for GET navigations and a fixed shell allowlist
(the module graph under `app.js`, manifest, icons), **network-first**: the
network gets 3.5s; a 200 wins, is served, and refreshes the versioned shell
cache (`claude0-shell-v1`) — including a late 200 after the cache already
answered, via `waitUntil`. Only on timeout or network error does the cached
copy serve. Data endpoints, `/stream`, and every non-GET fall through
untouched. Alongside it, all API fetches carry abort timeouts (12s default,
30s for endpoints that shell out to git/gh or block on pane readiness), and
`resync()` runs a 30s × 4s burst that rebuilds the SSE stream until it
demonstrably opens, holding the 40s zombie watchdog off meanwhile
(`shared/reconnect.js` owns the decisions).

Network-first preserves the dev workflow: a reachable bridge always wins, so a
refresh still serves fresh code; the cache only ever answers when the request
would previously have hung or failed.

## Consequences

- An offline open right after a deploy serves the previous shell once; the next
  reachable open self-heals. Accepted — strictly better than a white screen.
- `claude0-shell-vN` is bumped by hand and nothing enforces it; a forgotten
  bump can't strand a reachable client (network-first) but could serve a
  mismatched shell set offline.
- The sw.js allowlist mirrors the server's `STATIC` map and can't share a
  constant (classic import-free worker); `sw.test.ts` asserts the two stay in
  sync, so a new static asset fails tests until added to the allowlist.
- The `claude0-nav` tap-stash cache is untouched by shell-cache pruning.

## Rejected

- **Cache-first (stale-while-revalidate)**: instant paints always, but every
  deploy is one launch stale — breaks the refresh-serves-fresh dev loop the
  repo leans on.
- **Retrying navigation from a splash page instead of caching**: still needs a
  first successful fetch per launch; solves nothing during the black-hole
  window.
- **Intercepting `/stream` or API GETs in the SW**: streaming through respondWith
  is a known iOS hazard, and serving stale data as if current would lie —
  the app's own banner + versioned push already handle data-plane gaps.
