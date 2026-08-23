# 6. Web Push replaces ntfy — pushes route to the device that drove the turn

Date: 2026-07-22
Status: accepted

## Context

Tier-4 phone pushes went to a single ntfy.sh topic, subscribed only on the iPhone. Two failure
modes followed from that shape, both observed in daily use:

1. **Pushes while working at the Mac.** Attribution was per-turn: once portkey drove a session,
   the source marker matched for the rest of the turn, so taking the session over in the
   terminal (approving a tool, interrupting — anything that fires no new `UserPromptSubmit`)
   still read as "portkey" and buzzed the phone.
2. **iPad activity buzzing the iPhone.** The bridge had no device identity — iPhone and iPad
   shared one marker, one `bridge-consumer` liveness file, and one delivery channel, so an
   iPad-driven turn pushed to the only ntfy subscriber: the iPhone. An open iPad also
   suppressed pushes the iPhone should have received.

ntfy taps also opened Safari rather than the installed PWA — the notification landed you in a
second, cookie-less copy of portkey.

## Decision

Replace ntfy with Web Push, scoped to the two installed iOS PWAs (the Mac keeps native
notifications):

- **Device identity.** Each client mints a persistent `deviceId` (localStorage), sent as
  `x-claude0-device` on every request and `?device=` on the SSE stream. Source markers record it;
  pushes go only to that device via its own subscription (`push-subscriptions.json`).
- **Per-device liveness.** `consumers/<deviceId>` markers (SSE connect + 15s heartbeat)
  suppress the push while the originating device is watching live. A `sendBeacon` goodbye on
  backgrounding unlinks the marker immediately — the client closes its EventSource *first* so a
  heartbeat on the lingering socket can't re-create it (iOS keeps backgrounded sockets alive
  ~30s; without the close-first ordering the beacon loses the race and the push is suppressed
  in exactly the lock-the-phone-and-walk-away window). The 40s staleness threshold remains as
  the crash/network fallback. The aggregate `bridge-consumer` file is untouched — the
  question-intercept hook reads it.
- **Mac takeover.** When the monitor sees the terminal focused on a session's pane, it deletes
  the session's source marker — later transitions are silent on all phones.
- **PWA-opening taps.** The service worker's `notificationclick` focuses an existing client and
  posts an `open-session` message (focus alone doesn't navigate), or `openWindow`s the deep
  link. `tag = sessionId` + `renotify` keeps one notification per session, latest state wins;
  the app badge tracks currently-notified sessions and clears on focus.
- **Self-healing subscriptions.** The bell is first-run-only (iOS requires a gesture for the
  permission prompt). Once granted, launch reconciles against server truth
  (`GET /push/subscribed` — a server-side prune is invisible to `pushManager.getSubscription()`)
  and resubscribes silently. Delivery errors 401/403 (VAPID mismatch) and 404/410 (gone) prune.
- **No dependency.** VAPID (ES256 JWT) and RFC 8291 aes128gcm payload encryption are
  hand-rolled on Bun's WebCrypto in `core/web-push.ts`, pinned byte-for-byte by the RFC's own
  §5 test vector. Payloads stay non-sensitive (label + tool category) despite the end-to-end
  encryption — same policy as the ntfy era.

`ntfyTopic` and `bridgeUrl` are gone from the config schema and are auto-stripped from
`config.json` on load (raw-JSON rewrite, unknown keys preserved).

## Rejected

- **Second ntfy topic per device** — smallest change, but keeps the click-opens-Safari problem
  and adds an app + topic to manage per device.
- **Suppress-only (no iPad channel)** — record deviceId purely to stop wrong-device buzzes;
  rejected because the iPad would have no notifications at all.
- **`web-push` npm package** — battle-tested, but the repo's first real server dependency for
  ~200 lines of verifiable crypto; the RFC test vector makes the hand-rolled version provable.
