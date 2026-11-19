import { test, expect } from "bun:test";
import { fetchFailure, streamGap, appendCapped, NET_TRACE_CAP } from "./net-trace.js";

const T0 = Date.parse("2026-11-19T23:14:00Z");
const base = { url: "https://vm.example:8473/sessions?q=secret", method: "GET", startedAt: T0, now: T0 + 12_000, hidden: false, foregroundAt: T0 - 5_000, online: true };

test("a rejected fetch records its error kind, duration and foreground context", () => {
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  expect(fetchFailure({ ...base, error: timeout })).toEqual({
    kind: "fetch",
    at: "2026-11-19T23:14:00.000Z",
    method: "GET",
    path: "/sessions", // query dropped: it can carry search text
    ms: 12_000,
    error: "TimeoutError",
    hidden: false,
    sinceForegroundMs: 5_000,
    online: true,
  });
  const failed = fetchFailure({ ...base, now: T0 + 40, error: new TypeError("Load failed") });
  expect(failed).toMatchObject({ error: "TypeError", ms: 40 });
});

test("an error status from the bridge or Tailscale's proxy records the status, not an error", () => {
  const entry = fetchFailure({ ...base, status: 502 });
  expect(entry).toMatchObject({ kind: "fetch", status: 502 });
  expect(entry).not.toHaveProperty("error");
});

test("a fetch the app aborted on purpose is not a failure", () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  expect(fetchFailure({ ...base, error: abort })).toBeNull();
});

test("a stream gap counts only the time the app was on screen", () => {
  // Down while backgrounded, back 1s after foregrounding: the normal resume, not an outage.
  expect(streamGap({ downAt: T0, now: T0 + 60_000, foregroundAt: T0 + 59_000 })).toBeNull();
  // Down for 2m40s, 2m30s of it in front of the user.
  expect(streamGap({ downAt: T0, now: T0 + 160_000, foregroundAt: T0 + 10_000 })).toEqual({
    kind: "stream",
    at: "2026-11-19T23:14:00.000Z",
    ms: 160_000,
    visibleMs: 150_000,
  });
});

test("the queue keeps only the newest entries", () => {
  let q: object[] = [];
  for (let i = 0; i < NET_TRACE_CAP + 5; i++) q = appendCapped(q, { i });
  expect(q).toHaveLength(NET_TRACE_CAP);
  expect(q[0]).toEqual({ i: 5 });
});
