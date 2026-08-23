/**
 * Tunnel-wake recovery decisions, shared between the mobile bridge UI (served
 * to the browser as `/reconnect.js`) and its test suite. Pure so the burst
 * state machine is testable without a browser: the caller owns the timers and
 * asks on each tick what to do.
 *
 * The burst exists because a foregrounded iPhone's Tailscale tunnel can spend
 * many seconds black-holing traffic; the steady-state zombie watchdog retries
 * at most once per 40s, which reads as a frozen app. For the first 30s after
 * foregrounding, a stream that hasn't demonstrably opened is retried every
 * few seconds instead.
 */

export const BURST_WINDOW_MS = 30_000;

/**
 * One burst tick: "retry" = rebuild the stream now, "stop" = burst is over
 * (opened, hidden, or expired). `lastOpenAt` is the last time the stream's
 * onopen fired — an open at or after the burst began is the success signal.
 */
export function burstAction({ burstStartedAt, lastOpenAt, hidden, now }) {
  if (hidden) return "stop";
  if (lastOpenAt >= burstStartedAt) return "stop";
  if (now - burstStartedAt > BURST_WINDOW_MS) return "stop";
  return "retry";
}

/**
 * Fetch options with an abort timeout injected. A caller-provided signal wins
 * — never stack a second one. Without this every fetch over a black-holed
 * tunnel hangs for the platform default (60s+ on iOS), pinning stale UI.
 */
export function withTimeout(opts = {}, ms) {
  if (opts.signal) return opts;
  return { ...opts, signal: AbortSignal.timeout(ms) };
}
