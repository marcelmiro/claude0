/**
 * Input-source attribution (portkey push gating). Pins the truncation-safe
 * anchor logic: text-match on the current turn's UserPromptSubmit, prompt_id-match
 * for approvals/answers, and the fail-to-"tui" direction when the anchor turn has
 * scrolled out of the 200-line log tail. Markers carry the originating deviceId —
 * the per-device push target — and clearSource() drops the marker entirely
 * (Mac-takeover: focusing the pane in the terminal silences later pushes).
 *
 * `home` helper first — freezes SOURCE_DIR/EVENTS_DIR under a temp HOME.
 */

import "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { markPortkeySource, sourceForSession, clearSource, SOURCE_DIR } from "./input-source";
import { EVENTS_DIR, eventLogPath } from "./hook-events";
import type { HookEvent } from "../types";

beforeEach(() => {
  for (const dir of [EVENTS_DIR, SOURCE_DIR]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
});

function writeLog(id: string, events: Partial<HookEvent>[]): void {
  const lines = events.map((e) => JSON.stringify({ session_id: id, ...e })).join("\n");
  writeFileSync(eventLogPath(id), lines + "\n");
}

test('"tui" when no marker exists', () => {
  writeLog("s1", [{ hook_event_name: "UserPromptSubmit", prompt: "hi", prompt_id: "p1" }]);
  expect(sourceForSession("s1")).toEqual({ source: "tui" });
});

test('"portkey" with deviceId when marker text equals the last UserPromptSubmit.prompt', () => {
  writeLog("s2", [{ hook_event_name: "UserPromptSubmit", prompt: "fix the bug", prompt_id: "p1" }]);
  markPortkeySource("s2", { deviceId: "iphone-1", text: "fix the bug" });
  expect(sourceForSession("s2")).toEqual({ source: "portkey", deviceId: "iphone-1" });
});

test('"portkey" when marker turnPromptId equals the last UserPromptSubmit.prompt_id (approval-after-TUI-prompt)', () => {
  // TUI typed the prompt; portkey approved a tool mid-turn (no text marker).
  writeLog("s3", [
    { hook_event_name: "UserPromptSubmit", prompt: "typed at desk", prompt_id: "turn-9" },
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" },
  ]);
  markPortkeySource("s3", { deviceId: "ipad-1" }); // no text ⇒ anchors turn-9
  expect(sourceForSession("s3")).toEqual({ source: "portkey", deviceId: "ipad-1" });
});

test('"tui" when a newer UserPromptSubmit follows the anchor turn', () => {
  // Portkey message (marked at send time, when its own UPS is the newest), then a
  // desk-typed prompt starts a new turn — both anchors are shadowed.
  writeLog("s4", [{ hook_event_name: "UserPromptSubmit", prompt: "from phone", prompt_id: "p1" }]);
  markPortkeySource("s4", { deviceId: "iphone-1", text: "from phone" });
  writeLog("s4", [
    { hook_event_name: "UserPromptSubmit", prompt: "from phone", prompt_id: "p1" },
    { hook_event_name: "UserPromptSubmit", prompt: "typed at desk", prompt_id: "p2" },
  ]);
  expect(sourceForSession("s4")).toEqual({ source: "tui" });
});

test('a background task finishing mid-turn does NOT shadow the marker (still "portkey")', () => {
  // Claude logs a completed background task as its own UserPromptSubmit. Comparing the
  // marker text against THAT dropped the attribution, and the turn-complete push with
  // it — the prompt_id anchor can't save this path because markPortkeySource runs on the
  // send route, so turnPromptId names the previous turn (here: "p0", not "from phone").
  writeLog("s10", [{ hook_event_name: "UserPromptSubmit", prompt: "earlier", prompt_id: "p0" }]);
  markPortkeySource("s10", { deviceId: "ipad-1", text: "from phone" });
  writeLog("s10", [
    { hook_event_name: "UserPromptSubmit", prompt: "earlier", prompt_id: "p0" },
    { hook_event_name: "UserPromptSubmit", prompt: "from phone", prompt_id: "p1" },
    { hook_event_name: "UserPromptSubmit", prompt: "<task-notification>\n<task-id>abc</task-id>", prompt_id: "p2" },
  ]);
  expect(sourceForSession("s10")).toEqual({ source: "portkey", deviceId: "ipad-1" });
});

test('a subagent hand-back does NOT shadow the marker (still "portkey")', () => {
  writeLog("s11", [{ hook_event_name: "UserPromptSubmit", prompt: "from phone", prompt_id: "p1" }]);
  markPortkeySource("s11", { deviceId: "ipad-1", text: "from phone" });
  writeLog("s11", [
    { hook_event_name: "UserPromptSubmit", prompt: "from phone", prompt_id: "p1" },
    { hook_event_name: "UserPromptSubmit", prompt: "<agent-message from=\"x\">done</agent-message>", prompt_id: "p2" },
  ]);
  expect(sourceForSession("s11")).toEqual({ source: "portkey", deviceId: "ipad-1" });
});

test('a message queued into a task-notification\'s turn attributes via prompt_id', () => {
  // The injected turn IS the active turn here, so the prompt_id anchor must still read
  // the latest prompt of ANY kind — skipping injected turns outright would lose this.
  writeLog("s12", [
    { hook_event_name: "UserPromptSubmit", prompt: "typed at desk", prompt_id: "turn-1" },
    { hook_event_name: "UserPromptSubmit", prompt: "<task-notification>\n<task-id>abc</task-id>", prompt_id: "turn-2" },
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" },
  ]);
  markPortkeySource("s12", { deviceId: "iphone-1", text: "queued from phone" }); // anchors turn-2
  expect(sourceForSession("s12")).toEqual({ source: "portkey", deviceId: "iphone-1" });
});

test('a real typed prompt AFTER the portkey turn still shadows, even with an injection after it', () => {
  writeLog("s13", [{ hook_event_name: "UserPromptSubmit", prompt: "from phone", prompt_id: "p1" }]);
  markPortkeySource("s13", { deviceId: "ipad-1", text: "from phone" });
  writeLog("s13", [
    { hook_event_name: "UserPromptSubmit", prompt: "from phone", prompt_id: "p1" },
    { hook_event_name: "UserPromptSubmit", prompt: "typed at desk", prompt_id: "p2" },
    { hook_event_name: "UserPromptSubmit", prompt: "<task-notification>\n<task-id>abc</task-id>", prompt_id: "p3" },
  ]);
  expect(sourceForSession("s13")).toEqual({ source: "tui" });
});

test('"portkey" for a message queued mid-turn (no UPS of its own — prompt_id anchor)', () => {
  // The turn was desk-typed; the phone sends while it runs. The queued message is
  // consumed inside the tool loop and never fires UserPromptSubmit, so the text alone
  // would never match — the still-current turn's prompt_id is what attributes it.
  writeLog("s7", [
    { hook_event_name: "UserPromptSubmit", prompt: "typed at desk", prompt_id: "turn-4" },
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" },
  ]);
  markPortkeySource("s7", { deviceId: "iphone-1", text: "queued from phone" });
  expect(sourceForSession("s7")).toEqual({ source: "portkey", deviceId: "iphone-1" });
});

test('truncation: anchor UserPromptSubmit trimmed out of the tail ⇒ "tui", never a stuck "portkey"', () => {
  markPortkeySource("s5", { deviceId: "iphone-1", text: "the original message" });
  // The 200-line trim scrolled the anchor turn out; only later events remain.
  writeLog("s5", [
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1" },
    { hook_event_name: "Stop" },
  ]);
  expect(sourceForSession("s5")).toEqual({ source: "tui" });
});

test('markPortkeySource(id) with no UserPromptSubmit writes an empty marker ⇒ stays "tui"', () => {
  writeLog("s6", [{ hook_event_name: "SessionStart" }]);
  markPortkeySource("s6");
  expect(sourceForSession("s6")).toEqual({ source: "tui" });
});

test('pre-web-push marker (no deviceId) still attributes "portkey" with deviceId undefined', () => {
  writeLog("s8", [{ hook_event_name: "UserPromptSubmit", prompt: "old marker", prompt_id: "p1" }]);
  markPortkeySource("s8", { text: "old marker" });
  const src = sourceForSession("s8");
  expect(src.source).toBe("portkey");
  expect((src as { deviceId?: string }).deviceId).toBeUndefined();
});

test('clearSource drops the marker ⇒ "tui" (Mac takeover mid-turn)', () => {
  writeLog("s9", [
    { hook_event_name: "UserPromptSubmit", prompt: "from phone", prompt_id: "p1" },
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" },
  ]);
  markPortkeySource("s9", { deviceId: "iphone-1", text: "from phone" });
  expect(sourceForSession("s9")).toEqual({ source: "portkey", deviceId: "iphone-1" });
  clearSource("s9");
  expect(sourceForSession("s9")).toEqual({ source: "tui" });
  clearSource("s9"); // idempotent — already gone
});
