/**
 * Tier-4 push path (portkey Web Push). Covers the non-sensitive label, the
 * tool→category map, per-device SSE liveness, and the exact push payload the
 * service worker renders. Delivery itself (encryption + POST) is pinned in
 * web-push.test.ts. No phone needed.
 *
 * `home` helper first — freezes EVENTS_DIR under a temp HOME (pushAction reads it).
 */

import "../../test/helpers/home";
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { pushLabel, pushAction, deviceConnected, pushPayloadFor, dispatchHeldApprovalPushes } from "./notifications";
import { CONSUMERS_DIR } from "./web-push";
import { PENDING_DIR } from "./approval";
import { markPortkeySource, SOURCE_DIR } from "./input-source";
import { EVENTS_DIR, eventLogPath } from "./hook-events";
import type { HookEvent, Session, TransitionEvent } from "../types";

beforeEach(() => {
  for (const dir of [EVENTS_DIR, CONSUMERS_DIR, PENDING_DIR, SOURCE_DIR]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
});

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    repo: "claude0",
    repoPath: "/x",
    baseRepoPath: "/x",
    branch: "",
    status: "waiting",
    messageCount: 0,
    summary: "",
    modified: new Date(0),
    firstPrompt: "",
    lastPrompt: "",
    name: "claude0/fix-auth",
    ...over,
  };
}

function writePreToolUse(id: string, tool: string): void {
  const e: Partial<HookEvent> = {
    session_id: id,
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_use_id: "t1",
  };
  writeFileSync(eventLogPath(id), JSON.stringify(e) + "\n");
}

// --- pushLabel ---------------------------------------------------------------

test('pushLabel humanizes the ai-name → "claude0 · Fix Auth"', () => {
  expect(pushLabel(mkSession({ name: "claude0/fix-auth" }))).toBe("claude0 · Fix Auth");
});

test("pushLabel prefers the cache's title form over the lossy window slug", () => {
  const cache = { version: 6 as const, names: { s1: "Notifications Config" }, sources: {} };
  const s = mkSession({ id: "s1", name: "claude0/notif-cfg" });
  expect(pushLabel(s, cache)).toBe("claude0 · Notifications Config");
  // Unresolved session falls back to un-slugging the window name.
  expect(pushLabel(mkSession({ id: "s2", name: "claude0/notif-cfg" }), cache)).toBe("claude0 · Notif Cfg");
});

test("pushLabel falls back to repo alone when the window name has no ai-name", () => {
  expect(pushLabel(mkSession({ name: "claude0", repo: "claude0" }))).toBe("claude0");
});

// --- pushAction (tool → category) -------------------------------------------

test("pushAction maps the pending tool NAME to a non-sensitive category", () => {
  writePreToolUse("bash-s", "Bash");
  expect(pushAction("bash-s")).toBe("run a command");
  writePreToolUse("edit-s", "Edit");
  expect(pushAction("edit-s")).toBe("make an edit");
  writePreToolUse("write-s", "Write");
  expect(pushAction("write-s")).toBe("make an edit");
  writePreToolUse("ask-s", "AskUserQuestion");
  expect(pushAction("ask-s")).toBe("answer a question");
  writePreToolUse("read-s", "Read");
  expect(pushAction("read-s")).toBe("needs permission");
  expect(pushAction("no-log")).toBe("needs permission"); // no pending tool
});

// --- deviceConnected (per-device consumer marker freshness) -------------------

test("deviceConnected: fresh marker → true, stale (>40s) → false, missing → false", () => {
  const marker = `${CONSUMERS_DIR}/dev-a`;
  expect(deviceConnected("dev-a")).toBe(false); // missing

  writeFileSync(marker, "");
  expect(deviceConnected("dev-a")).toBe(true); // fresh
  expect(deviceConnected("dev-b")).toBe(false); // other devices unaffected

  const stale = (Date.now() - 41_000) / 1000;
  utimesSync(marker, stale, stale);
  expect(deviceConnected("dev-a")).toBe(false); // stale
});

// --- pushPayloadFor (exact payload the service worker renders) ----------------

test("blocked payload: label + category body, sessionId deep link, no capture text", () => {
  writePreToolUse("sess-1", "Bash");
  const event: TransitionEvent = {
    sessionKey: "%1",
    previousStatus: "running",
    currentStatus: "waiting",
    classification: "blocked",
    session: mkSession({ lastCapture: "SECRET pane contents" }),
  };
  const p = pushPayloadFor(event, event.session);
  expect(p.title).toBe("⚡ claude0 · Fix Auth");
  expect(p.body).toBe("run a command?");
  expect(p.sessionId).toBe("sess-1");
  expect(JSON.stringify(p)).not.toContain("SECRET"); // never leaks pane capture
});

test("turnComplete payload: title only — iOS adds its own attribution line", () => {
  const event: TransitionEvent = {
    sessionKey: "%1",
    previousStatus: "running",
    currentStatus: "ready",
    classification: "turnComplete",
    session: mkSession({ status: "ready" }),
  };
  const p = pushPayloadFor(event, event.session);
  expect(p.title).toBe("✅ claude0 · Fix Auth");
  expect(p.body).toBe("");
  expect(p.sessionId).toBe("sess-1");
});

// --- dispatchHeldApprovalPushes (hook-held approvals never transition) -----------
// A held approval renders no pane picker, so the status stays `running` and the
// transition dispatch can't fire. These pin the gating: once per hold, source-device
// only, suppressed-while-watching re-arms on background. The sidecar write doubles as
// the observable "push path taken" signal (no subscription exists under temp HOME, so
// sendWebPush itself no-ops).

function writeHold(sessionId: string, toolUseId: string, ts = Date.now()): void {
  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(
    `${PENDING_DIR}/${sessionId}.json`,
    JSON.stringify({ sessionId, ts, pid: process.pid, tool: "Write", tool_use_id: toolUseId }),
  );
}

const sidecar = (sessionId: string) => `${PENDING_DIR}/${sessionId}.pushed`;

/** A phone-driven turn: the UserPromptSubmit event + a text-matching source marker. */
function driveFromPhone(sessionId: string, deviceId: string): void {
  writeFileSync(
    eventLogPath(sessionId),
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "do it" }) + "\n",
  );
  markPortkeySource(sessionId, { deviceId, text: "do it" });
}

test("held approval from a portkey turn pushes once and remembers the hold", async () => {
  writeHold("sess-1", "tu_1");
  driveFromPhone("sess-1", "dev-1");
  await dispatchHeldApprovalPushes([mkSession()]);
  expect(readFileSync(sidecar("sess-1"), "utf8")).toMatch(/^tu_1:\d+$/);
  // Same hold again: sidecar unchanged (mtime not what we pin — content is).
  const first = readFileSync(sidecar("sess-1"), "utf8");
  await dispatchHeldApprovalPushes([mkSession()]);
  expect(readFileSync(sidecar("sess-1"), "utf8")).toBe(first);
});

test("a NEW hold (different tool_use_id) pushes again", async () => {
  writeHold("sess-1", "tu_1");
  driveFromPhone("sess-1", "dev-1");
  await dispatchHeldApprovalPushes([mkSession()]);
  writeHold("sess-1", "tu_2");
  await dispatchHeldApprovalPushes([mkSession()]);
  expect(readFileSync(sidecar("sess-1"), "utf8")).toMatch(/^tu_2:\d+$/);
});

test("a new hold with an EMPTY tool_use_id still pushes (ts disambiguates)", async () => {
  // The shell-side tool_use_id grep can miss; an id-only dedupe key would match
  // every later hold on the session and mute it permanently.
  const t1 = Date.now() - 1000;
  const t2 = Date.now();
  writeHold("sess-1", "", t1);
  driveFromPhone("sess-1", "dev-1");
  await dispatchHeldApprovalPushes([mkSession()]);
  expect(readFileSync(sidecar("sess-1"), "utf8")).toBe(`:${t1}`);
  writeHold("sess-1", "", t2);
  await dispatchHeldApprovalPushes([mkSession()]);
  expect(readFileSync(sidecar("sess-1"), "utf8")).toBe(`:${t2}`);
});

test("watching device suppresses the push but does NOT spend the hold", async () => {
  writeHold("sess-1", "tu_1");
  driveFromPhone("sess-1", "dev-1");
  mkdirSync(CONSUMERS_DIR, { recursive: true });
  writeFileSync(`${CONSUMERS_DIR}/dev-1`, ""); // fresh SSE marker = watching
  await dispatchHeldApprovalPushes([mkSession()]);
  expect(existsSync(sidecar("sess-1"))).toBe(false);
  // Device backgrounds (marker gone) → next tick pushes.
  rmSync(`${CONSUMERS_DIR}/dev-1`);
  await dispatchHeldApprovalPushes([mkSession()]);
  expect(readFileSync(sidecar("sess-1"), "utf8")).toMatch(/^tu_1:\d+$/);
});

test("no push for desk-driven turns or unknown sessions", async () => {
  writeHold("sess-1", "tu_1"); // no source marker at all (desk turn)
  await dispatchHeldApprovalPushes([mkSession()]);
  expect(existsSync(sidecar("sess-1"))).toBe(false);
  writeHold("sess-gone", "tu_9");
  driveFromPhone("sess-gone", "dev-1");
  await dispatchHeldApprovalPushes([mkSession()]); // sess-gone not in the list
  expect(existsSync(sidecar("sess-gone"))).toBe(false);
});

afterEach(() => {
  rmSync(EVENTS_DIR, { recursive: true, force: true });
});
