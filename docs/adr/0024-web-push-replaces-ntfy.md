# 24. Web Push replaces ntfy — pushes route to the device that drove the turn

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
  `x-claude0-device` on every request and `?device=` on the SSE stream. Source markers
  (`source/<sessionId>.json`) record it; pushes go only to that device via its own subscription
  (`push-subscriptions.json`).
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
- **Operator contact.** The VAPID `sub` claim identifies the install's operator to the push
  services: `notifications.pushContact` when set, else the user's git email (`mailto:` prepended
  to a bare address). RFC 8292 makes `sub` a SHOULD, so when neither exists it is omitted
  entirely rather than filled with a placeholder.

`ntfyTopic` and `bridgeUrl` are gone from the config schema and are auto-stripped from
`config.json` on load (raw-JSON rewrite, unknown keys preserved).

## Rejected

- **Second ntfy topic per device** — smallest change, but keeps the click-opens-Safari problem
  and adds an app + topic to manage per device.
- **Suppress-only (no iPad channel)** — record deviceId purely to stop wrong-device buzzes;
  rejected because the iPad would have no notifications at all.
- **`web-push` npm package** — battle-tested, but the repo's first real server dependency for
  ~200 lines of verifiable crypto; the RFC test vector makes the hand-rolled version provable.

## Addendum (2026-10-01): harness-injected turns must not shadow the source marker

A phone stopped getting notifications. Everything downstream was healthy — the
subscription was live (a hand-rolled probe to all five endpoints returned 201), the gate
opened, and a real turn-complete push was accepted by APNs mid-investigation. The
attribution was what broke: `sourceForSession` read `"tui"` for a session the phone
demonstrably drove, with the marker file intact.

**Claude Code logs a `UserPromptSubmit` for turns the human never typed** — a completed
background task (`<task-notification>`) and a subagent's hand-back (`<agent-message>`),
each with a `prompt_id` of its own. Matching the marker against the single most recent
`UserPromptSubmit` therefore let a background task finishing mid-turn shadow the marker,
and the turn-complete push was lost outright: `dispatchNotifications` fires only on a
`detectTransitions` edge, so nothing ever re-pushes for that turn. (Held approvals escaped
this — `dispatchHeldApprovalPushes` re-runs over the live `pending/*` markers each tick.)

The `turnPromptId` anchor could not cover it, because on the fresh-prompt path it is
**systematically stale**: `markPortkeySource` runs on the bridge's send route, before Claude
has logged the new turn's `UserPromptSubmit`, so it records the PREVIOUS turn's id. Observed
directly — a marker written for prompt `356230af` carried `turnPromptId: c581dbce`. The anchor
still works for its documented queued-mid-turn case, where the in-flight turn's id is already
on disk; it is the idle-session send that has no working fallback.

The two anchors now read deliberately different references:

- **`text`** compares against the latest **non-injected** prompt — the human's own.
- **`prompt_id`** compares against the latest prompt of **any** kind, because it identifies the
  currently-active turn, and that is exactly an injected one when a message is queued into a
  task-notification's turn. Skipping injected turns for both anchors would have traded this bug
  for that regression; both directions are pinned by tests.

A consequence worth naming: a session the phone drove now stays attributed across an injected
turn, so a background task completing after the turn ended can push again. That is intended —
the phone drove the session and it needs attention again.

Separately observed: on two backgroundings the `/push/goodbye` beacon did not arrive — the
consumer marker expired via the staleness fallback instead of being cleared — leaving a window
in which pushes were still suppressed. Later client-side instrumentation showed the beacon is
only INTERMITTENTLY lost, not structurally broken (see the second addendum below). The addendum
immediately below is what makes that window cost latency instead of the notification, and is
the reason the intermittency no longer matters for delivery.

## Addendum (2026-10-01): tier 4 retries off the attention set, not the transition edge

The suppression gate is a guess about whether a human is looking, and the goodbye beacon — the
only thing that makes it *promptly* correct — is unreliable on backgrounding (above). The
real defect was that a wrong guess was unrecoverable: `dispatchNotifications` sent the tier-4
push inline with the `detectTransitions` edge, and that edge never fires again, so a push
suppressed because the device still *looked* connected was lost permanently. The suppressed
window is precisely when the user walks away — the case a phone notification exists for.

Tier 4 now runs as `dispatchAttentionPushes` over the **attention set** every monitor tick, so
a suppressed push is retried until one actually goes out. Delivery no longer depends on beacon
reliability; a lost beacon costs latency instead of the notification — measured end to end at
45s from suppressed transition to delivered push, in a reproduction that held the consumer
marker fresh across the transition and then released it. Real-world is the same order: the
socket dies ~10s after an app-switch, +40s staleness, +one 3s tick. This is the shape
`dispatchHeldApprovalPushes` already used for hook-held approvals, which is why those kept
arriving while turn-complete pushes went missing.

- **One push per attention episode**, tracked by `phonePushed` in `state.json`, scoped exactly
  like `lastTransition`: carried while attention persists, dropped the moment it clears. The
  things that clear attention — the session runs again, the pane is focused at the desk, the
  phone opens the session — each re-arm the next episode. The other `state.json` writers
  load-mutate-save, so the field survives them.
- **Suppression no longer spends the push.** A device that was watching at the transition is
  re-offered the push on later ticks; only an actual send sets the flag.
- Tiers 2 and 3 (window prefix, native notification) stay on the transition edge — they are
  desk surfaces and repeating them would be spam.

Known gap, left deliberately: the monitor's `freshState` bail (another process wrote
`state.json` mid-poll) drops that tick's pushed-key set, so a push can repeat. The service
worker collapses per-session notifications by tag, so a duplicate is near-invisible — not worth
a second sidecar to prevent.

## Addendum (2026-10-01): the goodbye beacon is intermittent, not broken — don't design on it

Instrumented the client (record synchronously into localStorage at hide time, upload on the
next foreground — a suspended app cannot report) and logged server-side receipt, to find out
why the beacon went missing. It mostly doesn't:

- **`visibilitychange` DOES fire** on an app-switch, and `pagehide` fires too. Across four hide
  records on two devices, `navigator.sendBeacon` returned `true` every time and the bridge
  received a matching `/push/goodbye` every time (6 receipts). The device that had twice shown
  no goodbye at all sent two clean ones afterwards.
- **`es.close()` is not a factor.** `tailscale serve` negotiates HTTP/2, so the SSE stream and
  the beacon multiplex over one TLS connection — closing the stream costs no handshake
  (measured). Nothing in `sendGoodbye` can throw before `sendBeacon` either.
- A reload fires `pagehide` (while still `visible`, stream open) and then
  `visibilitychange`→hidden, so one departure sends **two** goodbyes. Harmless — the route is
  idempotent — but it explains receipt counts exceeding hide counts.

What actually differed between the failing and succeeding observations is unidentified; the
bridge had been up 23h with a 1.1 GB memory peak when the losses were seen and was restarted
before the successes, which fits this repo's documented bridge memory-leak history but is not
established. Left there deliberately: the beacon is a latency optimisation whose success the
client cannot verify, so the correct design is the retry above, which does not depend on it.
Chasing the intermittency further buys ~45s of latency and nothing for correctness.
