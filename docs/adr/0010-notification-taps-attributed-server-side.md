# 10. Notification taps are attributed server-side, not by the service worker

Date: 2026-07-27
Status: accepted

The tap path, the ledger and the iOS measurements behind it are in
[docs/notifications.md](../notifications.md) ("Taps").

## Context

Tapping a push notification was supposed to deep-link into the session it came from
([ADR 24](0024-web-push-replaces-ntfy.md)). It didn't: the session list would open, or
whatever session was on screen stayed there. The worker's `notificationclick` stashed the
target through the Cache API, posted it to any open window, and fell back to
`openWindow('/?s=…')`, and it had been verified working when it shipped.

Two on-device measurements (breadcrumbs POSTed from `sw.js` and `app.js` to the bridge)
explain both the failure and why it passed review:

1. **iOS fires `notificationclick` only on a cold launch.** A tap on a running PWA
   (foreground, or backgrounded but alive) just activates the app; the worker is never
   woken, so every delivery path inside the handler dies together. Testing after a
   force-quit exercises the one path that survives.
2. **A warm-resumed page reads a stale CacheStorage snapshot**, so having the `push`
   handler (which does run) record the target fails too. `registration.getNotifications()`,
   by contrast, is accurate on a resumed page.

## Decision

Attribute the tap from two signals the page can actually obtain on a warm resume:

- **What was pushed** comes from the **bridge**, not the worker: a per-device ledger of
  accepted pushes, read by the page with a delete-on-read GET. The sender already knows what
  it sent, and a network read has no cross-context storage semantics to get wrong.
- **What was tapped** comes from the shade: a recorded push whose notification has since
  vanished is the one that was tapped.

Attribution is conservative, because a false positive drags the user into a session they didn't
ask for: exactly one vanished → open it; none → opened some other way, stay put; several →
unattributable, stay put. A 2-minute TTL bounds the one hole this can't close — clear the shade
by hand, open the app later, and that single vanished push still reads as a tap until it ages
out.

`notificationclick` stays for the cold path — it is an exact signal when it fires, and it is
checked before the heuristic.

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

- Warm taps land on the right session — the case that is ~always what happens in practice,
  since the PWA is usually still alive.
- Attribution can decline. Several notifications dismissed at once leaves the tap
  unattributable and the app stays put — a deliberate trade against navigating somewhere the
  user didn't choose.
- Anything that dismisses notifications must run after attribution reads the shade.
