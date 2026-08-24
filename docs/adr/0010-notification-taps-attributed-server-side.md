# 10. Notification taps are attributed server-side, not by the service worker

Date: 2026-07-27
Status: accepted

## Context

Tapping a push notification was supposed to deep-link into the session it came from
([ADR 24](0024-web-push-replaces-ntfy.md)). It didn't. The session list would open, or whatever
session happened to be on screen would stay there. The machinery looked right — the worker's
`notificationclick` stashed the target through the Cache API, posted it to any open window, and
fell back to `openWindow('/?s=…')` — and it had been verified working at the time it shipped.

Two on-device measurements explain both the failure and why it passed review. Breadcrumbs were
POSTed from `sw.js` and `app.js` to a temporary bridge route, so the timings below are the
phone's, not a simulation.

**1. iOS fires `notificationclick` only on a cold launch.** Force-quit the PWA and the handler
runs every time. Leave it running — foreground, or backgrounded but alive — and a tap simply
activates the app; the worker is never woken. Six pushes and several taps produced zero click
events while warm, against a build that fired reliably from cold. Every delivery path lives
inside that handler, so all three die together: no stash, no `postMessage`, no `?s=`. The page
sees nothing but `visibilitychange → visible`. This is also why the original shipped as
"working" — testing after a force-quit exercises the one path that survives.

**2. A warm-resumed page reads a stale CacheStorage snapshot.** The obvious repair — have the
`push` handler record the target, since that handler *does* run — failed for a second,
independent reason. The worker's write and the page's read, same run, same origin:

```
20:59:58.108 [sw]  recordPush wrote {"f7a84d86-…":1785185998054}
21:00:00.877 [app] pushed={} shade=[] tapped=null
```

2.8 seconds later the page opened the same cache and got nothing. Measured again at 9s, same
result; a record written at 17:29:54 only became visible to a *freshly booted* page at 20:58.
Cold launches read the cache correctly — which is precisely why the cold-launch stash works and
masked the problem.

`registration.getNotifications()`, by contrast, is accurate on a resumed page. Probed both ways:
after a tap the shade reads `0 shown tags=[]`; ignore the notification and open the app from the
home-screen icon and it reads `1 shown tags=[f7a84d86-…]`.

## Decision

Attribute the tap from two signals the page can actually obtain on a warm resume:

- **What was pushed** comes from the **bridge**, not the worker. `sendWebPush` appends to a
  per-device ledger (`~/.config/claude0/pushed/<deviceId>.json`) once the push service accepts the
  push; the page reads `GET /push/recent?device=…`, delete-on-read. The sender already knows
  what it sent, and a network read has no cross-context storage semantics to get wrong.
- **What was tapped** comes from the shade. A recorded push whose notification has since
  vanished is the one that was tapped (`tapTarget` in `shared/tap-target.js`).

Attribution is conservative, because a false positive drags the user into a session they didn't
ask for: exactly one vanished → open it; none → opened some other way, stay put; several →
unattributable, stay put. A 2-minute TTL bounds the one hole this can't close — clear the shade
by hand, open the app later, and that single vanished push still reads as a tap until it ages
out.

Order is load-bearing. `resync()` used to call `dismissNotifications()` first, destroying the
evidence before anything could read it; `followNotificationTap()` now reads the shade, attributes,
and only then clears.

`notificationclick` stays for the cold path — it is an exact signal when it fires, and it is
checked before the heuristic. One file per device (like `consumers/`) rather than a shared JSON:
the monitor writes and the bridge reads, and a shared file loses a writer's slice on concurrent
updates.

## Rejected

- **Fix it inside `notificationclick`.** Nothing to fix; the handler never runs on a warm tap.
- **Keep the record in the Cache API.** Measured unreadable on the only path that matters.
- **`postMessage` from the `push` handler.** Plausible, but delivery to a suspended page is
  unverified — and unverified platform behaviour is what produced this bug.
- **Piggyback the ledger on `/sessions`.** Free (the page already fetches it every foreground),
  but it gives a plain GET delete-on-read side effects, which will surprise the next reader.
- **Open the most recently pushed session with no guard.** Simplest, but opening portkey
  yourself while a push is pending would hijack you into that session.
- **A "jump to" chip instead of navigating.** Zero false positives and no reliance on shade
  behaviour, at the cost of an extra tap. Held in reserve; the shade signal proved reliable
  enough on-device not to need it.

## Consequences

Warm taps land on the right session — the case that is ~always what happens in practice, since
the PWA is usually still alive. `initPush` also calls `registration.update()` each launch:
`register()` alone can leave an old worker active on iOS, and a stale push handler is invisible
until someone digs into why notifications stopped behaving.

Attribution can decline. Several notifications dismissed at once leaves the tap unattributable
and the app stays put — a deliberate trade against navigating somewhere the user didn't choose.
