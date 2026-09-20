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

## 2026-09-19: iOS status-bar appearance

Portkey adopts Court Watcher's status-bar workaround for the reported iOS 27
top-edge blur: `apple-mobile-web-app-status-bar-style=default` and a real,
fixed, non-interactive 1px element at the top, coloured with `--bg`. The element
lives outside Preact's root so it survives mounting. Portkey keeps its existing
dark colour scheme and matching `#101010` page, theme and manifest colours.

Remove the standalone page-height extension used for `black-translucent`.
The shell now stays at `100dvh`, with the top safe-area inset applied once to
the shell. Standalone list content still clears the bottom home indicator.
No extra header spacing is added. Apple's [meta-tag reference](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html)
distinguishes the default content area from the translucent status-bar overlay.

This ports the workaround, not a verified fix for native iOS rendering. Browser
layout checks cannot reproduce the installed iOS 27 effect. Existing installs
may need removal and re-adding from Safari for the status-bar metadata to change;
then check the top edge, bottom controls and notification permission on-device.
The network-first shell cache continues to update on a reachable reload.

## 2026-09-20: keep controls below the native blur

The user still sees blur after reinstalling Portkey and now prefers clearance
over further attempts to disable it. Installed iPhone apps use
`--app-top-clearance = env(safe-area-inset-top, 0px) + 24px`. The 24px allowance
is a starting value for on-device verification, not a measurement of the blur.
The [safe-area inset](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/env)
describes viewport obstructions; it does not expose a blur radius or boundary.

Set the iPhone standalone class before first paint. Apply the same clearance to
the app shell, file and subagent overlays, and action-sheet bounds. The fixed
background strip covers that area so content cannot enter it during transitions.
Keep the shell at `100dvh` with border-box sizing: clearance reduces the content
area rather than pushing the composer below the viewport. Long action sheets
scroll within the remaining height; the dock also shrinks and scrolls when a
tall question would otherwise push its controls below the viewport. Safari
tabs and other devices retain their
previous spacing. This is an HTML/CSS change, so a reachable reload is enough;
there is no new installation metadata to pick up.

### Follow-up: clearance scrolls away

The user found 24px excessive and the opaque top strip created a hard cutoff
while scrolling. Reduce the allowance to 12px and return the strip to 1px.
On the iPhone PWA, the app shell has no top padding. Home and transcript scroll
regions reach the viewport top; their initial padding contains the safe-area
inset plus the 12px allowance and scrolls away with the content. Content may
enter the native blur as it approaches the top edge, as requested.

Screens with a fixed top toolbar retain the smaller clearance on the toolbar
or overlay so navigation controls remain accessible. Bottom controls and the
short-viewport dock behaviour stay unchanged.

On-device feedback still showed a few blurred pixels at rest, especially on
New Session. Increase the allowance from 12px to 16px, and the direct toolbar's
base top padding from 2px to 6px. Home gains 4px; New Session and History gain
8px. The clearance still scrolls away on Home and in conversations.
