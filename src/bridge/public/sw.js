// Service worker: Web Push receiver, notification click routing, and a
// network-first app-shell fallback. Data endpoints stay uncached; the shell
// cache exists because the phone's Tailscale tunnel can black-hole traffic for
// many seconds right after wake, and with no fallback an app open white-screens
// for the whole navigation timeout (ADR 0021). A reachable bridge always wins —
// the cache only answers when the network is dead or slower than the race timer.
// skipWaiting/claim so an updated worker takes over on next launch instead of
// iOS's lazy default (otherwise stale push handlers linger for days).

const NAV_CACHE = "claude0-nav";
const SHELL_CACHE = "claude0-shell-v2";

// Everything the shell needs to paint offline: the module graph under app.js
// plus manifest/icons. Mirrors the server's STATIC allow-map (sw.js is a
// classic import-free worker, so the list can't be shared — sw.test.ts guards
// the two against drifting). "/" is handled via request.mode === "navigate".
const SHELL_PATHS = [
  "/app.js",
  "/time-ago.js",
  "/diff-lines.js",
  "/tap-target.js",
  "/wake-format.js",
  "/wake-abs.js",
  "/sync.js",
  "/reconnect.js",
  "/net-trace.js",
  "/mac-draft.js",
  "/message-text.js",
  "/manifest.json",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/vendor/preact.mjs",
  "/vendor/hooks.mjs",
  "/vendor/signals-core.mjs",
  "/vendor/signals.mjs",
  "/vendor/htm.mjs",
  "/vendor/marked.mjs",
];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      // Prune superseded shell caches only — NAV_CACHE is the tap-stash and
      // must survive worker updates.
      try {
        for (const key of await caches.keys()) {
          if (key.startsWith("claude0-shell-") && key !== SHELL_CACHE) await caches.delete(key);
        }
      } catch {
        /* pruning is best-effort — a stale cache wastes bytes, nothing else */
      }
    })(),
  ),
);

// How long the network gets before the cached shell answers instead. Short on
// purpose: past this the tunnel is either dead or slow enough that a cached
// paint + the app's own reconnect banner beat a blank screen. Overridable so
// tests don't sleep through the real timer.
const NET_TIMEOUT_MS = self.__shellTimeoutMs || 3500;

// One page load = one shell version: the CSS is inline in index.html and the markup
// lives in app.js, so a cached page paired with a fresh app.js renders unstyled
// (ADR 0021). The navigation's outcome pins its page's assets: a page answered from
// the cache gets cached assets, and only requests answered live write the cache.
// Keyed by client id; the last navigation stands in where a browser omits the ids.
const pageFromCache = new Map();
let lastNavFromCache = false;

async function cachedShell(key) {
  try {
    return await (await caches.open(SHELL_CACHE)).match(key);
  } catch {
    return undefined; // cache unavailable — the caller falls back to the network
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const isNav = req.mode === "navigate";
  if (!isNav && !SHELL_PATHS.includes(url.pathname)) return; // API, /stream: untouched
  const cacheKey = isNav ? "/" : url.pathname;

  if (!isNav && (pageFromCache.get(event.clientId) ?? lastNavFromCache)) {
    event.respondWith((async () => (await cachedShell(cacheKey)) || fetch(req))());
    return;
  }

  // Network-first: fetch always starts; the race below decides who answers, and the
  // network's 200 is cached only if it is what this request was answered with
  // (waitUntil keeps the worker alive for that write).
  const network = fetch(req).then((res) => ({ res, copy: res.status === 200 ? res.clone() : null }));
  let answeredLive;
  const decided = new Promise((resolve) => (answeredLive = resolve));
  event.waitUntil(
    Promise.all([network, decided])
      .then(async ([{ copy }, live]) => {
        if (live && copy) await (await caches.open(SHELL_CACHE)).put(cacheKey, copy);
      })
      .catch(() => {}),
  );

  event.respondWith(
    (async () => {
      const winner = await Promise.race([
        network.catch(() => null), // network error → try cache
        new Promise((resolve) => setTimeout(() => resolve("timeout"), NET_TIMEOUT_MS)),
      ]);
      const cached = winner && winner !== "timeout" ? undefined : await cachedShell(cacheKey);
      if (isNav) {
        lastNavFromCache = !!cached;
        if (event.resultingClientId) pageFromCache.set(event.resultingClientId, !!cached);
      }
      answeredLive(!cached);
      if (cached) return cached;
      // no fallback: surface whatever the network does, as before
      return network.then(({ res }) => res);
    })(),
  );
});

self.addEventListener("push", (event) => {
  // iOS drops the subscription if a push shows nothing — always show, even on a
  // malformed payload.
  let p = {};
  try {
    p = event.data ? event.data.json() : {};
  } catch {
    /* fall through to the generic notification */
  }
  const sessionId = p.sessionId || "";
  event.waitUntil(
    (async () => {
      // Show FIRST, and with a UNIQUE tag. Reusing the session's tag makes iOS
      // REPLACE the shade entry silently — WebKit ignores `renotify`, so only a
      // session's first push ever bannered — and presentation must never wait on
      // another SW API first (an in-worker getNotifications that stalls would
      // swallow the push entirely). The tag keeps the session id as a prefix for
      // tap attribution; the page splits on "|".
      const ts = Date.now();
      const tag = `${sessionId || "claude0"}|${ts}`;
      await self.registration.showNotification(p.title || "portkey", {
        body: p.body || "",
        tag,
        data: { sessionId },
      });
      // Cleanup AFTER: close the session's older notifications so the shade still
      // converges to one per session, then badge = sessions currently notified.
      try {
        const prefix = tag.slice(0, tag.indexOf("|") + 1);
        for (const n of await self.registration.getNotifications()) {
          // Strictly-older only: two same-session pushes whose cleanups interleave
          // would otherwise close each other and empty the shade — which the tap
          // attributor reads as a tap.
          if ((n.tag || "").startsWith(prefix) && Number((n.tag || "").slice(prefix.length)) < ts) n.close();
        }
        const left = await self.registration.getNotifications();
        await navigator.setAppBadge(new Set(left.map((n) => (n.tag || "").split("|")[0])).size);
      } catch {
        /* cleanup/badge best-effort — the notification is already up */
      }
    })(),
  );
});

// Hand the tapped session off through the Cache API — shared between this worker
// and the page. iOS cold-launches an installed PWA at its start_url and routinely
// drops the `?s=` on openWindow(), so the URL alone loses the deep link on the most
// common (evicted) path; the app reads this on boot and on foreground instead.
async function stashTarget(sessionId) {
  if (!sessionId) return;
  try {
    const cache = await caches.open(NAV_CACHE);
    await cache.put("pending", new Response(JSON.stringify({ sessionId, at: Date.now() })));
  } catch {
    /* cache unavailable — the ?s= URL and postMessage paths still try */
  }
}

// Only reached on a COLD launch — iOS never dispatches this to an already-running PWA.
// Stash first: on that cold path `matchAll()` already returns the launching window ~800ms
// before its JS boots, so the postMessage below lands in a page with no listener yet and
// `openWindow` is never reached. The stash is what actually carries the deep link; the
// other two are belt-and-braces for platforms that behave.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = (event.notification.data || {}).sessionId || "";
  event.waitUntil(
    (async () => {
      await stashTarget(sessionId);
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (wins.length > 0) {
        // focus() alone doesn't navigate — the app listens for this message and
        // re-runs its deep-link logic, switching to the notified session.
        try {
          await wins[0].focus();
        } catch {
          /* focus can fail without user activation — the message still lands */
        }
        wins[0].postMessage({ type: "open-session", sessionId });
        return;
      }
      await self.clients.openWindow(sessionId ? `/?s=${encodeURIComponent(sessionId)}` : "/");
    })(),
  );
});
