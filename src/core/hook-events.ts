/**
 * Per-session hook event log reader (Inc3).
 *
 * The WRITER is the installed hook script (`event.sh` / `pretooluse.sh`), which
 * appends the raw hook payload — one JSON object per line — to
 * `events/<session_id>.jsonl`. This module only reads.
 *
 * Read WITHOUT truncation (append order, newest last) — `deriveStatus` needs the
 * recent edge history, which is incompatible with the consume-and-truncate
 * contract of the separate `hook-events` pane-map (`state.ts`, untouched). Corrupt
 * or half-written lines are skipped (per-line try/parse) for forward/partial-write
 * safety. Sync to match the contract signature and avoid an await on the ~3s
 * discovery hot path (the log is bounded to 200–400 lines).
 */

import { readFileSync } from "node:fs";
import { PATHS } from "./config";
import { deriveStatus } from "./event-status";
import { parseTranscript } from "./transcript";
import type { PendingToolCall } from "./jsonl-reader";
import { toPendingQuestion } from "./jsonl-reader";
import type { HookEvent, TranscriptTurn } from "../types";
import type { SessionStatus } from "./status";

export const EVENTS_DIR = `${PATHS.dir}/events`;

/** Absolute path to a session's event log. */
export function eventLogPath(sessionId: string): string {
  return `${EVENTS_DIR}/${sessionId}.jsonl`;
}

/** Whether an event log exists for this session (drives the opt-in fallback). */
export function hasEventLog(sessionId: string): boolean {
  try {
    readFileSync(eventLogPath(sessionId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a session's hook events in append order (newest last); [] if no log. The
 * writer rotates the log to `.old` at 200 lines, so the rotated half comes first.
 */
export function readEvents(sessionId: string): HookEvent[] {
  // Current half FIRST: a rotation landing between the two reads then duplicates a
  // generation (harmless) instead of skipping one. Each half is read on its own —
  // just after a rotation only `.old` exists.
  const read = (path: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return ""; // absent — no log yet (opt-in fallback handles it) or not rotated yet
    }
  };
  const current = read(eventLogPath(sessionId));
  const raw = read(`${eventLogPath(sessionId)}.old`) + current;

  const events: HookEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as HookEvent);
    } catch {
      continue; // corrupt/half-written line — skip
    }
  }
  return events;
}

/**
 * Event-sourced status for a session, or `null` if it has no event log (the caller
 * then falls back to the `status.ts` scraper — ADR-2 opt-in by presence).
 *
 * Pure edges: the status is exactly what `deriveStatus` reads off the newest
 * determining hook event. No transcript read, no timeout, no pairing — a dropped
 * terminal edge is rare and self-heals on the next event, which is far cheaper than
 * the false `ready`s a transcript backstop produced on long-running sessions.
 * `async` only to keep the call sites (which `await`) unchanged.
 */
export async function eventSourcedStatus(sessionId: string): Promise<SessionStatus | null> {
  const events = readEvents(sessionId);
  if (events.length === 0) return null;
  return deriveStatus(events);
}

/**
 * The tool/question awaiting approval, sourced from the last open PreToolUse
 * event (A3: pending interactions are NOT in the transcript before they resolve).
 * Returns null when no PreToolUse is open. Shape mirrors `jsonl-reader`'s
 * `PendingToolCall` so the preview/Space-menu renderers consume it unchanged.
 */
export function pendingToolCall(sessionId: string): PendingToolCall | null {
  const events = readEvents(sessionId);
  const closed = new Set<string>();
  for (const e of events) {
    if (e.hook_event_name === "PostToolUse" && e.tool_use_id) closed.add(e.tool_use_id);
  }
  // A tool is only genuinely pending if it opened in the CURRENT (unfinished) turn.
  // After a `Stop` (turn end) every tool is done — even if its PostToolUse was never
  // captured (e.g. a Bash that spawned a detached process keeping the hook's pipe
  // open), so a PreToolUse before the last Stop is stale, not "running". A live
  // AskUserQuestion / permission prompt blocks mid-turn, so NO Stop follows it — it
  // stays after the last Stop and is still surfaced.
  let lastStop = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.hook_event_name === "Stop") {
      lastStop = i;
      break;
    }
  }
  let pre: HookEvent | undefined;
  for (let i = events.length - 1; i > lastStop; i--) {
    const e = events[i];
    if (e.hook_event_name === "PreToolUse" && e.tool_use_id && !closed.has(e.tool_use_id)) {
      pre = e;
      break;
    }
  }
  if (!pre?.tool_name) return null;

  const input = (pre.tool_input ?? {}) as Record<string, any>;
  const toolUseId = pre.tool_use_id ?? "";
  const call: PendingToolCall = { name: pre.tool_name, toolUseId };
  if (typeof input.file_path === "string") call.filePath = input.file_path;
  if (typeof input.command === "string") call.command = input.command;
  if (typeof input.description === "string") call.description = input.description;
  if (typeof input.pattern === "string") call.pattern = input.pattern;
  if (pre.tool_name === "Edit") {
    if (typeof input.old_string === "string") call.oldString = input.old_string;
    if (typeof input.new_string === "string") call.newString = input.new_string;
  } else if (pre.tool_name === "Write") {
    if (typeof input.content === "string") call.content = input.content.slice(0, 500);
  } else if (pre.tool_name === "AskUserQuestion" && input.questions?.[0]) {
    const questions = input.questions.map((q: any) => toPendingQuestion(q, toolUseId));
    call.questions = questions;
    call.question = questions[0];
  }
  return call;
}

/** Tail-read + parse a transcript (tolerant of the truncated first line). */
export async function readTranscriptTurns(path: string): Promise<TranscriptTurn[]> {
  try {
    const file = Bun.file(path);
    const stat = await file.stat();
    if (!stat) return [];
    const TAIL = 64 * 1024;
    const offset = Math.max(0, stat.size - TAIL);
    const chunk = await file.slice(offset, stat.size).text();
    return parseTranscript(chunk);
  } catch {
    return [];
  }
}
