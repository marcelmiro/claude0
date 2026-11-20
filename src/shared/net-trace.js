/**
 * Portkey's network failure trace, shared between the client (served to the browser
 * as `/net-trace.js`) and its test suite. Failures queue on the device and reach the
 * bridge log only once a request gets through again (docs/portkey.md § Network trace).
 */

export const NET_TRACE_CAP = 50;
// A stream gap shorter than this while on screen is the ordinary reconnect after a resume.
const STREAM_GAP_MIN_VISIBLE_MS = 3_000;

/**
 * One failed request, or null when the app cancelled it itself (AbortError). `error` is the
 * rejection's name — TimeoutError: no response before the timeout; TypeError: the
 * connection failed outright. `status` instead: something answered with a 5xx (a 502 from
 * Tailscale serve means the tunnel reached the VM and the bridge didn't answer).
 * `signal` is the one the request ran with: WebKit rejects a timed-out fetch with
 * AbortError, so only the signal's reason tells a timeout from the app's own cancel.
 */
export function fetchFailure({ url, method, startedAt, now, error, signal, status, hidden, foregroundAt, online }) {
  const timedOut = signal?.reason?.name === "TimeoutError";
  if (error?.name === "AbortError" && !timedOut) return null;
  return {
    kind: "fetch",
    at: new Date(startedAt).toISOString(),
    method,
    path: new URL(url, "http://x").pathname,
    ms: now - startedAt,
    ...(status ? { status } : { error: timedOut ? "TimeoutError" : (error?.name ?? "Error") }),
    hidden,
    sinceForegroundMs: startedAt - foregroundAt,
    online,
  };
}

/**
 * The live stream was down from `downAt` until it reopened `now`; null unless it stayed
 * down for a while with the app on screen (`visibleMs` from foregrounding or the drop,
 * whichever is later).
 */
export function streamGap({ downAt, now, foregroundAt }) {
  const visibleMs = now - Math.max(downAt, foregroundAt);
  if (visibleMs < STREAM_GAP_MIN_VISIBLE_MS) return null;
  return { kind: "stream", at: new Date(downAt).toISOString(), ms: now - downAt, visibleMs };
}

export function appendCapped(queue, entry, cap = NET_TRACE_CAP) {
  const next = [...queue, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}
