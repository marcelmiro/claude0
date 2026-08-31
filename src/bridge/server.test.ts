/**
 * Bridge routes — the Web Push surface (`/push/*`) and the `/sw.js` no-cache
 * guarantee, exercised over a real `startBridge` server on an ephemeral port.
 * Auth is the real cookie exchange; core state lands under the temp HOME.
 *
 * `home` helper first — freezes PATHS/EVENTS_DIR under a temp HOME before
 * server.ts (via core/config) freezes them at import time.
 */

import "../../test/helpers/home";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { EVENTS_DIR } from "../core/hook-events";
import { CONSUMERS_DIR, fromB64url } from "../core/web-push";
import { startBridge, applyTail, gzipJson } from "./server";

const TOKEN = "route-test-token";
let server: ReturnType<typeof startBridge>;
let base = "";
let cookie = "";

beforeAll(async () => {
  mkdirSync(EVENTS_DIR, { recursive: true });
  process.env.CLAUDE0_BRIDGE_TOKEN = TOKEN;
  process.env.CLAUDE0_BRIDGE_PORT = "0"; // ephemeral — never collides with a live bridge
  server = startBridge();
  base = `http://127.0.0.1:${server.port}`;
  const res = await fetch(`${base}/auth`, {
    method: "POST",
    body: JSON.stringify({ token: TOKEN }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(() => {
  server?.stop(true);
});

const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie } });
const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { cookie }, body: JSON.stringify(body) });

test("/push/vapid-key requires auth and returns a 65-byte P-256 key", async () => {
  expect((await fetch(`${base}/push/vapid-key`)).status).toBe(401);
  const res = await get("/push/vapid-key");
  expect(res.status).toBe(200);
  const { key } = (await res.json()) as { key: string };
  expect(fromB64url(key).length).toBe(65);
});

test("/push/subscribe validates deviceId, https endpoint, and keys", async () => {
  const sub = {
    endpoint: "https://web.push.apple.com/route-test",
    keys: { p256dh: "BPKEY", auth: "AUTH" },
  };
  expect((await post("/push/subscribe", { deviceId: "../traversal", subscription: sub })).status).toBe(400);
  expect(
    (
      await post("/push/subscribe", {
        deviceId: "route-test-device",
        subscription: { ...sub, endpoint: "http://insecure" },
      })
    ).status,
  ).toBe(400);
  expect((await post("/push/subscribe", { deviceId: "route-test-device" })).status).toBe(400);
  const ok = await post("/push/subscribe", { deviceId: "route-test-device", subscription: sub });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true });
});

test("/push/subscribed reflects server truth per device", async () => {
  const yes = (await (await get("/push/subscribed?device=route-test-device")).json()) as {
    subscribed: boolean;
  };
  expect(yes.subscribed).toBe(true);
  const no = (await (await get("/push/subscribed?device=never-subscribed-dev")).json()) as {
    subscribed: boolean;
  };
  expect(no.subscribed).toBe(false);
});

test("/push/goodbye unlinks the device's consumer marker (text/plain body)", async () => {
  mkdirSync(CONSUMERS_DIR, { recursive: true });
  const marker = `${CONSUMERS_DIR}/goodbye-dev-1`;
  writeFileSync(marker, "");
  const res = await fetch(`${base}/push/goodbye`, {
    method: "POST",
    headers: { cookie },
    body: "goodbye-dev-1",
  });
  expect(res.status).toBe(200);
  expect(existsSync(marker)).toBe(false);
});

test("/sw.js is served no-cache (a stale service worker would render old payloads)", async () => {
  const res = await fetch(`${base}/sw.js`); // static — public by design
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-cache");
  expect(res.headers.get("content-type")).toContain("javascript");
});

// --- versioned state push (stream.ts protocol over a live server) -------------

// Read SSE frames from /stream until `pred` matches one parsed `data:` event (or
// the deadline passes). Returns the matched event, or null.
async function readStreamUntil(
  path: string,
  pred: (ev: Record<string, unknown>) => boolean,
  ms = 5000,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const line of buf.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (pred(ev)) return ev;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return null;
}

test("/stream pushes a seq-stamped sessions snapshot on connect", async () => {
  const ev = await readStreamUntil("/stream?device=stream-test-dev", (e) => e.type === "sessions");
  expect(ev).not.toBeNull();
  expect(typeof ev!.seq).toBe("number");
  expect(typeof ev!.computedAt).toBe("number");
  const payload = ev!.payload as { sessions: unknown[] };
  expect(Array.isArray(payload.sessions)).toBe(true);
});

test("/stream/open subscribes the device and pushes a transcript snapshot", async () => {
  const sub = await fetch(`${base}/stream/open`, {
    method: "POST",
    headers: { cookie, "x-claude0-device": "stream-test-dev" },
    body: JSON.stringify({ sessionId: "no-such-session" }),
  });
  expect(await sub.json()).toEqual({ ok: true });
  // A reconnect after subscribing must deliver the transcript snapshot on connect.
  const ev = await readStreamUntil(
    "/stream?device=stream-test-dev",
    (e) => e.type === "transcript" && e.sessionId === "no-such-session",
  );
  expect(ev).not.toBeNull();
  expect(ev!.kind).toBe("snapshot");
  const payload = ev!.payload as { turns: unknown[] };
  expect(Array.isArray(payload.turns)).toBe(true);
});

test("/stream/open validates its body and requires a device", async () => {
  const noDevice = await post("/stream/open", { sessionId: "x" });
  expect(noDevice.status).toBe(400);
  const badBody = await fetch(`${base}/stream/open`, {
    method: "POST",
    headers: { cookie, "x-claude0-device": "stream-test-dev" },
    body: JSON.stringify({ sessionId: 42 }),
  });
  expect(badBody.status).toBe(400);
});

// --- gzipJson: the JSON response compression wrapper on every route ---

const jsonRes = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
const gzipReq = (encoding?: string) =>
  new Request("http://x/", encoding ? { headers: { "accept-encoding": encoding } } : {});

test("gzipJson compresses a large JSON body and the roundtrip preserves it", async () => {
  const data = { blob: "x".repeat(4096) };
  const out = await gzipJson(gzipReq("gzip, deflate, br"), jsonRes(data));
  expect(out.headers.get("content-encoding")).toBe("gzip");
  expect(out.headers.get("vary")).toBe("accept-encoding");
  const body = Bun.gunzipSync(new Uint8Array(await out.arrayBuffer()));
  expect(JSON.parse(new TextDecoder().decode(body))).toEqual(data);
});

test("gzipJson passes through small bodies, non-JSON, and clients without gzip", async () => {
  const small = await gzipJson(gzipReq("gzip"), jsonRes({ ok: true }));
  expect(small.headers.get("content-encoding")).toBeNull();
  expect(await small.json()).toEqual({ ok: true });

  const sse = new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } });
  expect(await gzipJson(gzipReq("gzip"), sse)).toBe(sse); // untouched, not rebuilt

  const noGzip = jsonRes({ blob: "x".repeat(4096) });
  expect(await gzipJson(gzipReq(), noGzip)).toBe(noGzip);
});

test("routes serve gzip end-to-end when the client asks for it", async () => {
  // /sessions under the temp HOME is small — asserts the passthrough path over HTTP…
  const r = await fetch(`${base}/sessions`, { headers: { cookie, "accept-encoding": "gzip" } });
  expect(r.status).toBe(200);
  expect(await r.json()).toBeDefined(); // fetch transparently decodes either way
});

// --- applyTail: the `?tail=` slice for tail-first initial paint ---

const tailPayload = (count: number) => ({
  turns: Array.from({ length: count }, (_, i) => ({ role: "user", i })),
  rev: "rev-abc",
  usage: { in: 1 },
});

test("applyTail slices to the last n turns, sets partial, drops rev", () => {
  const out = applyTail(tailPayload(100), "40");
  expect((out.turns as { i: number }[]).length).toBe(40);
  expect((out.turns as { i: number }[])[0]!.i).toBe(60); // suffix, not prefix
  expect(out.partial).toBe(true);
  expect("rev" in out).toBe(false);
  expect(out.usage).toEqual({ in: 1 }); // non-turn fields ride along
});

test("applyTail passes a payload at or under n through untouched", () => {
  const p = tailPayload(40);
  const out = applyTail(p, "40");
  expect(out).toBe(p); // same object — full, rev kept, no partial
  expect(out.partial).toBeUndefined();
  expect(out.rev).toBe("rev-abc");
});

test("applyTail ignores absent, zero, negative, huge, and garbage tail values", () => {
  const p = tailPayload(100);
  for (const bad of [null, "0", "-5", "501", "abc", "4.5", ""]) {
    expect(applyTail(p, bad)).toBe(p);
  }
});

test("GET /transcript?tail on an unknown session returns the (short) payload un-marked", async () => {
  const r = await fetch(`${base}/sessions/never-existed/transcript?tail=40`, { headers: { cookie } });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { turns: unknown[]; partial?: boolean };
  expect(Array.isArray(body.turns)).toBe(true);
  expect(body.partial).toBeUndefined();
});

test("/stream/open rejects a sessionId with glob/path metacharacters", async () => {
  for (const bad of ["*", "../../etc/passwd", "a/b", "a?b", "a[b]", "**", "x".repeat(101)]) {
    const res = await fetch(`${base}/stream/open`, {
      method: "POST",
      headers: { cookie, "x-claude0-device": "stream-test-dev" },
      body: JSON.stringify({ sessionId: bad }),
    });
    expect(res.status).toBe(400);
  }
});
