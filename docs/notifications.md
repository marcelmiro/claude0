# Notifications

How a session's need for attention reaches the user and where each part lives: the tier
stack, who drove a turn, push suppression and retry, Web Push delivery, the service
worker, and tap attribution. The behavior below is the spec; the named docblocks carry
the implementation detail. Decisions:
[ADR 14](adr/0014-presence-is-client-activity.md) /
[ADR 19](adr/0019-presence-is-client-activity-everywhere.md) (presence),
[ADR 24](adr/0024-web-push-replaces-ntfy.md) (Web Push),
[ADR 10](adr/0010-notification-taps-attributed-server-side.md) (taps). Code:
`core/notifications.ts`, `core/input-source.ts`, `core/web-push.ts`, `core/presence.ts`,
`src/monitor.ts`, `bridge/public/sw.js`, `shared/tap-target.js`.

## Attention and tiers

Each monitor tick, transitions (`classifyTransition`: running→waiting and ready→waiting
are *blocked*, running→ready is *turnComplete*) seed the attention set. Presence decides
the active pane: when the terminal is focused (a client keystroke within the presence
window), a transition on the active pane adds no attention, attention on it is cleared,
and its portkey source marker is dropped (Mac takeover, `clearSource`). Window-name and
prefix rules are CLAUDE.md's gotchas; ⏳ never feeds a tier
([ADR 26](adr/0026-background-work-is-visibility-only.md)).

| Tier | Surface | Driven by |
|---|---|---|
| 1 | status-right `⚡ 3 🔄 2` | counts of the current state (`computeAggregate`, `core/state.ts`; `formatStatus`, `monitor.ts`) |
| 2 | window ⚡ prefix | re-derived every tick from the attention set (`desiredPrefix`) |
| 3 | native banner, darwin only | the transition edge (`dispatchNotifications`); sound only when that pane's client is present |
| 4 | per-device Web Push | the attention set every tick, gated by who drove the turn and whether that device is watching — not by presence (`dispatchAttentionPushes`) |

Hook-held approvals push on their own path (`dispatchHeldApprovalPushes`), deduped by a
`pending/<sessionId>.pushed` sidecar per hold.

## Who drove the turn

| Concern | Where |
|---|---|
| Source marker written on portkey actions, read at dispatch; the `text` vs `prompt_id` anchors | `markPortkeySource`, `sourceForSession` (`core/input-source.ts`) |
| Harness-injected turns (task notifications, agent/teammate hand-backs) must not shadow the marker | `INJECTED_PROMPT` (`core/input-source.ts`) |
| `deviceId`: minted in localStorage, sent as `x-claude0-device` and `?device=` on the stream | `app.js` (`DEVICE_ID`) |

## Suppression and retry

| Concern | Where |
|---|---|
| A device is watching while `consumers/<deviceId>` is ≤40s old (SSE connect + 15s heartbeat; unlinked by the goodbye) | `deviceConnected` (`core/notifications.ts`) |
| Goodbye: close the stream first, then beacon | `sendGoodbye` (`app.js`) |
| One push per attention episode (`phonePushed`), retried until sent | `dispatchAttentionPushes` docblock |
| The aggregate `bridge-consumer` marker, read by both PreToolUse holds (approval + question) | `CONSUMER_FRESH_S` (`cli.ts`) |

Measured about the goodbye beacon: `visibilitychange` and `pagehide` both fire on an
app-switch, and a reload fires both (two goodbyes; the route is idempotent).
`tailscale serve` speaks HTTP/2, so closing the stream first costs no handshake. The
beacon is still intermittently lost, cause unidentified — delivery never depends on it.

## Delivery and the service worker

| Concern | Where |
|---|---|
| Send, 3s abort, prune on 401/403/404/410 | `sendWebPush` (`core/web-push.ts`) |
| VAPID `sub`: `notifications.pushContact` else git email, `mailto:` added to a bare address; omitted with neither | `resolveVapidContact` (`core/web-push.ts`) |
| Crypto pinned by the RFC 8291 §5 test vector | `core/web-push.test.ts` |
| Subscription self-heal against `GET /push/subscribed`; `registration.update()` each launch | `initPush` (`app.js`) |
| Always show; unique `sessionId\|ts` tag (WebKit ignores `renotify`), then close older ones and badge | `push` handler (`sw.js`) |
| Cold-launch tap: stash, `postMessage open-session`, else `openWindow` | `notificationclick` handler (`sw.js`) |

## Taps

The iOS facts that shape this (cold-only `notificationclick`, stale CacheStorage on a warm
resume, the shade as the one surviving signal) are in `shared/tap-target.js` and above
`takePushedRecord` (`app.js`). Order in `followNotificationTap`, load-bearing:

1. Take the cold-launch stash (exact when present).
2. Take the bridge's ledger (`GET /push/recent`, delete-on-read; written by
   `recordSentPush` in `core/web-push.ts`).
3. Attribute against the shade with `tapTarget`.
4. Only then `dismissNotifications()` — clearing first destroys the evidence.
