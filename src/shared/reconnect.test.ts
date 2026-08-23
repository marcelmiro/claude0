import { test, expect } from "bun:test";
import { burstAction, withTimeout, BURST_WINDOW_MS } from "./reconnect.js";

const base = { burstStartedAt: 1_000, lastOpenAt: 0, hidden: false, now: 1_000 };

test("retries while the stream hasn't opened and the window is live", () => {
  expect(burstAction(base)).toBe("retry");
  expect(burstAction({ ...base, now: 1_000 + BURST_WINDOW_MS })).toBe("retry");
});

test("stops once the stream opened at or after the burst began", () => {
  expect(burstAction({ ...base, lastOpenAt: 1_000 })).toBe("stop");
  expect(burstAction({ ...base, lastOpenAt: 5_000 })).toBe("stop");
  // A pre-burst open is exactly the zombie case — keep retrying.
  expect(burstAction({ ...base, lastOpenAt: 999 })).toBe("retry");
});

test("stops when hidden — sendGoodbye owns the backgrounded stream", () => {
  expect(burstAction({ ...base, hidden: true })).toBe("stop");
});

test("stops after the window expires", () => {
  expect(burstAction({ ...base, now: 1_001 + BURST_WINDOW_MS })).toBe("stop");
});

test("withTimeout injects an abort signal", () => {
  const opts = withTimeout({ method: "POST" }, 50);
  expect(opts.method).toBe("POST");
  expect(opts.signal).toBeInstanceOf(AbortSignal);
});

test("withTimeout defaults opts and never overrides a caller signal", () => {
  expect(withTimeout(undefined, 50).signal).toBeInstanceOf(AbortSignal);
  const mine = new AbortController().signal;
  expect(withTimeout({ signal: mine }, 50).signal).toBe(mine);
});

test("the injected signal actually aborts", async () => {
  const { signal } = withTimeout({}, 5) as { signal: AbortSignal };
  await new Promise((r) => setTimeout(r, 20));
  expect(signal.aborted).toBe(true);
});
