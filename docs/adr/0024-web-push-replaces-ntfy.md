# 24. Web Push replaces ntfy — pushes route to the device that drove the turn

Date: 2026-07-22
Status: accepted; amended 2026-10-01 (tier 4 retries off the attention set)

How attribution, suppression, delivery and the service worker work is in
[docs/notifications.md](../notifications.md).

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

Replace ntfy with Web Push, scoped to the installed iOS PWAs (the Mac keeps native
notifications):

- **Device identity.** Each client mints a persistent `deviceId`; source markers record which
  device drove the session, and pushes go only to that device's own subscription.
- **Per-device liveness** suppresses the push while the originating device is watching live.
  The aggregate `bridge-consumer` file stays — the question-intercept hook reads it.
- **Mac takeover.** When the monitor sees the terminal focused on a session's pane, it drops
  the session's source marker — later transitions are silent on all phones.
- **Taps open the PWA**, and a session keeps one notification in the shade, latest state wins.
- **Tier 4 retries off the attention set, not the transition edge.** Suppression is a guess
  about whether a human is looking, and an edge never fires twice, so a push suppressed by a
  wrong guess was lost for good — exactly when the user had walked away. The monitor offers
  the push every tick while the session needs attention, once per attention episode;
  suppression never spends it. Tiers 2 and 3 stay on the edge: they are desk surfaces, and
  repeating them would be spam.
- **No dependency.** VAPID (ES256 JWT) and RFC 8291 aes128gcm payload encryption are
  hand-rolled on Bun's WebCrypto, pinned byte-for-byte by the RFC's own test vector. Payloads
  stay non-sensitive (label + tool category) despite the end-to-end encryption.

## Rejected

- **Second ntfy topic per device** — smallest change, but keeps the click-opens-Safari problem
  and adds an app + topic to manage per device.
- **Suppress-only (no iPad channel)** — record deviceId purely to stop wrong-device buzzes;
  rejected because the iPad would have no notifications at all.
- **`web-push` npm package** — battle-tested, but the repo's first real server dependency for
  ~200 lines of verifiable crypto; the RFC test vector makes the hand-rolled version provable.
- **Designing delivery on the goodbye beacon.** It is intermittently lost on backgrounding and
  the client can't verify it arrived, so it only shortens latency; correctness comes from the
  retry.

## Consequences

- A lost goodbye costs latency, not the notification: ~45s measured from suppressed
  transition to delivered push (socket dies ~10s after an app-switch, +40s staleness, +one
  tick).
- A session the phone drove stays attributed across harness-injected turns (a background task
  or subagent hand-back), so a task completing after the turn ended can push again. Intended:
  the session needs attention again.
- A push can occasionally repeat (a monitor tick that bails on a concurrent `state.json`
  write drops that tick's pushed set); the shade still converges to one notification per
  session, so it is not worth a second sidecar to prevent.
