/**
 * I/O coverage for the Inc3/Inc4 event-log reader. The pure edge truth-table is
 * pinned in `event-status.test.ts`; this file pins the fs-touching paths that were
 * only ever checked by hand: the missed-edge backstop (transcript pairing + mtime
 * quiet), append-order/corruption tolerance in `readEvents`, and the
 * pending-tool-call sourcing/closing logic.
 *
 * `./../../test/helpers/home` MUST stay the first import — it redirects $HOME to a
 * temp dir before `hook-events` → `config` freezes `EVENTS_DIR`.
 */

import "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  readEvents,
  eventSourcedStatus,
  pendingToolCall,
  eventLogPath,
  EVENTS_DIR,
} from "./hook-events";
import { fixtureJson } from "../../test/helpers/fixture";
import type { HookEvent } from "../types";

beforeEach(() => {
  rmSync(EVENTS_DIR, { recursive: true, force: true });
  mkdirSync(EVENTS_DIR, { recursive: true });
});

/** Write `events` to a session log, one JSON object per line (append order). */
function writeLog(sessionId: string, events: HookEvent[]): void {
  writeFileSync(eventLogPath(sessionId), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function ev(partial: Partial<HookEvent> & { hook_event_name: HookEvent["hook_event_name"] }, transcript: string): HookEvent {
  return { session_id: "s", cwd: "/tmp", transcript_path: transcript, ...partial } as HookEvent;
}

// --- eventSourcedStatus (pure edges: status = newest determining edge) ---------

test("open PreToolUse → running", async () => {
  const id = "sess-running";
  writeLog(id, [
    ev({ hook_event_name: "UserPromptSubmit" }, "x"),
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_1" }, "x"),
  ]);
  expect(await eventSourcedStatus(id)).toBe("running");
});

test("a stale dangling tool from a prior turn does NOT demote a fresh running turn", async () => {
  // A dropped PostToolUse leaves an open PreToolUse; a new turn then starts
  // (UserPromptSubmit). The old pairing/timeout backstop read this as `ready` and
  // re-fired a spurious turnComplete every cycle (the cos-l2 ⚡ bug). Pure edges
  // keep it `running` — status is whatever the newest edge says.
  const id = "sess-stale-dangling";
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_old" }, "x"), // never closed
    ev({ hook_event_name: "Stop" }, "x"),
    ev({ hook_event_name: "UserPromptSubmit" }, "x"),
  ]);
  expect(await eventSourcedStatus(id)).toBe("running");
});

test("Stop edge → ready; no event log → null", async () => {
  const id = "sess-stop";
  writeLog(id, [ev({ hook_event_name: "Stop" }, "x")]);
  expect(await eventSourcedStatus(id)).toBe("ready");
  expect(await eventSourcedStatus("nonexistent-session")).toBeNull();
});

test("pending AskUserQuestion → waiting", async () => {
  const id = "sess-ask-waiting";
  writeLog(id, [
    ev({ hook_event_name: "UserPromptSubmit" }, "x"),
    ev({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "tu_q" }, "x"),
  ]);
  expect(await eventSourcedStatus(id)).toBe("waiting");
});

// --- readEvents ----------------------------------------------------------------

test("readEvents preserves append order", () => {
  const id = "sess-order";
  writeLog(id, [
    ev({ hook_event_name: "SessionStart" }, "x"),
    ev({ hook_event_name: "UserPromptSubmit" }, "x"),
    ev({ hook_event_name: "Stop" }, "x"),
  ]);
  expect(readEvents(id).map((e) => e.hook_event_name)).toEqual([
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
  ]);
});

test("readEvents skips a corrupt/half-written line, keeps the rest", () => {
  const id = "sess-corrupt";
  writeFileSync(
    eventLogPath(id),
    [
      JSON.stringify(ev({ hook_event_name: "SessionStart" }, "x")),
      '{"hook_event_name":"PreToolUse", "tool_n', // torn mid-write
      JSON.stringify(ev({ hook_event_name: "Stop" }, "x")),
    ].join("\n") + "\n",
  );
  expect(readEvents(id).map((e) => e.hook_event_name)).toEqual(["SessionStart", "Stop"]);
});

test("readEvents returns [] when no log exists", () => {
  expect(readEvents("never-existed")).toEqual([]);
});

// --- pendingToolCall -----------------------------------------------------------

test("pendingToolCall sources the last OPEN PreToolUse (A3)", () => {
  const id = "sess-pending";
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "tu_old", tool_input: { file_path: "/a" } }, "x"),
    ev({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "tu_old" }, "x"),
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_new", tool_input: { command: "ls", description: "list" } }, "x"),
  ]);
  const call = pendingToolCall(id);
  expect(call).not.toBeNull();
  expect(call!.name).toBe("Bash");
  expect(call!.toolUseId).toBe("tu_new");
  expect(call!.command).toBe("ls");
  expect(call!.description).toBe("list");
});

test("pendingToolCall returns null when the PreToolUse is closed by PostToolUse", () => {
  const id = "sess-closed";
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_1", tool_input: { command: "ls" } }, "x"),
    ev({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "tu_1" }, "x"),
  ]);
  expect(pendingToolCall(id)).toBeNull();
});

test("pendingToolCall: an open PreToolUse before the last Stop is stale → null", () => {
  // A dropped PostToolUse (e.g. a Bash that spawned a detached process holding the
  // hook's pipe) leaves a PreToolUse open; the turn then ends with Stop. That tool is
  // NOT still running — without this guard the bridge showed a phantom "running — Bash".
  const id = "sess-stale-pre";
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_dangling", tool_input: { command: "caffeinate claude0 bridge" } }, "x"),
    ev({ hook_event_name: "Stop" }, "x"),
  ]);
  expect(pendingToolCall(id)).toBeNull();
});

test("pendingToolCall: a fresh PreToolUse after the last Stop is live → returned", () => {
  // A stale dangling tool from a prior turn must not mask a genuinely in-flight tool
  // opened in the current (post-Stop) turn.
  const id = "sess-fresh-after-stop";
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "tu_stale", tool_input: { file_path: "/a" } }, "x"),
    ev({ hook_event_name: "Stop" }, "x"),
    ev({ hook_event_name: "UserPromptSubmit" }, "x"),
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_live", tool_input: { command: "ls" } }, "x"),
  ]);
  const call = pendingToolCall(id);
  expect(call?.name).toBe("Bash");
  expect(call?.toolUseId).toBe("tu_live");
});

test("pendingToolCall: a subagent's open tool doesn't shadow the main thread's held question", () => {
  // Subagents log into their parent's session log (tagged `agent_id`); background agents
  // keep opening tools while the main thread is blocked on AskUserQuestion.
  const id = "sess-subagent-shadow";
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "tu_ask", tool_input: { questions: [{ question: "Q?", header: "H", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }] } }, "x"),
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_sub", agent_id: "a1", tool_input: { command: "ls" } }, "x"),
  ]);
  expect(pendingToolCall(id)?.toolUseId).toBe("tu_ask");
});

test("pendingToolCall: a subagent's open tool alone is not the session's pending call", () => {
  const id = "sess-subagent-only";
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_sub", agent_id: "a1", tool_input: { command: "ls" } }, "x"),
  ]);
  expect(pendingToolCall(id)).toBeNull();
});

test("pendingToolCall: a subagent's AskUserQuestion is still surfaced (the question hook holds it too)", () => {
  const id = "sess-subagent-ask";
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "tu_sub_ask", agent_id: "a1", tool_input: { questions: [{ question: "Q?", header: "H", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }] } }, "x"),
  ]);
  expect(pendingToolCall(id)?.toolUseId).toBe("tu_sub_ask");
});

test("pendingToolCall maps AskUserQuestion questions[0] → structured options", () => {
  const id = "sess-ask";
  const ask = fixtureJson("hooks/pretooluse-askuserquestion.json") as HookEvent;
  writeLog(id, [ask]);
  const call = pendingToolCall(id);
  expect(call?.name).toBe("AskUserQuestion");
  expect(call?.question).toBeDefined();
  expect(call!.question!.question).toBe("Pick a fruit");
  expect(call!.question!.header).toBe("Fruit");
  expect(call!.question!.multiSelect).toBe(false);
  expect(call!.question!.options.map((o) => o.label)).toEqual(["Apple", "Banana", "Cherry"]);
  expect(call!.question!.toolUseId).toBe("toolu_017qQwTYpzg8d65MoEjqtPj8");
});

test("pendingToolCall parses ALL questions of a multi-question AskUserQuestion", () => {
  const id = "sess-ask-multi";
  writeLog(id, [
    ev(
      {
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_use_id: "tu_multi",
        tool_input: {
          questions: [
            { question: "Pick a fruit", header: "Fruit", multiSelect: false, options: [{ label: "Apple" }, { label: "Banana" }] },
            { question: "Pick colors", header: "Color", multiSelect: true, options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }] },
          ],
        },
      },
      "x",
    ),
  ]);
  const call = pendingToolCall(id);
  expect(call?.questions).toBeDefined();
  expect(call!.questions!.length).toBe(2);
  // Singular `question` stays = questions[0] for the unchanged display consumers.
  expect(call!.question).toEqual(call!.questions![0]);
  expect(call!.questions![1]!.header).toBe("Color");
  expect(call!.questions![1]!.multiSelect).toBe(true);
  expect(call!.questions![1]!.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue"]);
  expect(call!.questions![1]!.toolUseId).toBe("tu_multi");
});
