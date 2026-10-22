/**
 * Which session (if any) a foreground was caused by tapping its push notification.
 *
 * iOS dispatches `notificationclick` to the service worker ONLY when the PWA is
 * force-quit. If the app is already running — foreground, or backgrounded but alive —
 * a tap just activates it and the worker hears nothing at all, so the cache stash,
 * the `postMessage` and the `?s=` URL all go missing together. Verified on-device:
 * five pushes and several taps produced zero click events while warm, and the same
 * build fired the handler every time from cold.
 *
 * The one signal that survives is the notification shade. iOS removes a notification
 * when it is tapped and leaves it sitting there when the app is opened any other way
 * (home-screen icon, app switcher) — also verified on-device. So the sender records
 * every push it sends (`recordSentPush`, core/web-push.ts), and on foreground the page
 * diffs that ledger against the
 * notifications still in the shade: a push whose notification has since vanished is
 * the one that was tapped.
 *
 * Attribution is deliberately conservative, because a false positive drags the user
 * into a session they didn't ask for:
 *   exactly one vanished → that's the tap
 *   none vanished        → opened some other way, stay put
 *   several vanished     → unattributable (the shade was cleared by hand, or several
 *                          notifications were dismissed at once), so stay put
 *
 * The TTL bounds the one hole this can't close: clear the shade by hand, then open the
 * app later, and that single vanished push still reads as a tap until it ages out.
 *
 * @param {Record<string, number>} pushed  sessionId → epoch ms the push was shown
 * @param {Iterable<string>} shownTags     session ids of notifications still in the shade
 *                                         (the page strips the tag's `|ts` uniquifier)
 * @param {number} now                     epoch ms
 * @param {number} [ttlMs]                 how long a recorded push stays attributable
 * @returns {string | null}                sessionId to open, or null
 */
export function tapTarget(pushed, shownTags, now, ttlMs = 120_000) {
  const stillShown = new Set(shownTags);
  const vanished = Object.entries(pushed || {})
    .filter(([id, at]) => !stillShown.has(id) && now - at <= ttlMs)
    .map(([id]) => id);
  return vanished.length === 1 ? vanished[0] : null;
}

