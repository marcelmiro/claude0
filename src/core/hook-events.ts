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

import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { PATHS } from "./config";
import { edgeStatus } from "./event-status";
import type { PendingToolCall } from "./jsonl-reader";
import { toPendingQuestion } from "./jsonl-reader";
import type { HookEvent } from "../types";
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
 * The same events as `readEvents`, newest first, parsed lazily from byte windows read
 * off the end of each half. The per-tick callers (monitor, discovery, bridge) stop
 * within the last few lines, while a full read JSON-parses every logged
 * `tool_response` (MBs per session) on every tick.
 */
export function* eventsNewestFirst(sessionId: string): Generator<HookEvent> {
  // Current half first — it holds the newer events. An early stop never opens `.old`.
  for (const path of [eventLogPath(sessionId), `${eventLogPath(sessionId)}.old`]) {
    for (const line of linesNewestFirst(path)) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as HookEvent;
      } catch {
        // corrupt/half-written line — skip
      }
    }
  }
}

const TAIL_WINDOW = 64 * 1024;

/** A file's lines, last first; nothing if it's absent. The open fd keeps reading the
 *  same inode if a rotation renames it mid-walk. */
function* linesNewestFirst(path: string): Generator<string> {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    let pos = fstatSync(fd).size;
    let partial = Buffer.alloc(0); // start of the already-walked region, line not yet complete
    while (pos > 0) {
      const n = Math.min(TAIL_WINDOW, pos);
      pos -= n;
      const window = Buffer.allocUnsafe(n);
      readSync(fd, window, 0, n, pos);
      const chunk = partial.length ? Buffer.concat([window, partial]) : window;
      let end = chunk.length;
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] !== 10) continue;
        if (end > i + 1) yield chunk.toString("utf8", i + 1, end);
        end = i;
      }
      partial = chunk.subarray(0, end);
    }
    if (partial.length) yield partial.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Event-sourced status for a session, or `null` if it has no event log (the caller
 * then falls back to the `status.ts` scraper — ADR-2 opt-in by presence).
 *
 * Pure edges: the status is exactly what `edgeStatus` reads off the newest
 * determining hook event. No transcript read, no timeout, no pairing — a dropped
 * terminal edge is rare and self-heals on the next event, which is far cheaper than
 * the false `ready`s a transcript backstop produced on long-running sessions.
 * `async` only to keep the call sites (which `await`) unchanged.
 */
export async function eventSourcedStatus(sessionId: string): Promise<SessionStatus | null> {
  let any = false;
  for (const e of eventsNewestFirst(sessionId)) {
    any = true;
    const status = edgeStatus(e);
    if (status) return status;
  }
  return any ? "idle" : null;
}

/**
 * The tool/question awaiting approval, sourced from the last open PreToolUse
 * event (A3: pending interactions are NOT in the transcript before they resolve).
 * Returns null when no PreToolUse is open. Shape mirrors `jsonl-reader`'s
 * `PendingToolCall` so the preview/Space-menu renderers consume it unchanged.
 */
export function pendingToolCall(sessionId: string): PendingToolCall | null {
  // A tool is only genuinely pending if it opened in the CURRENT (unfinished) turn.
  // After a `Stop` (turn end) every tool is done — even if its PostToolUse was never
  // captured (e.g. a Bash that spawned a detached process keeping the hook's pipe
  // open), so a PreToolUse before the last Stop is stale, not "running". A live
  // AskUserQuestion / permission prompt blocks mid-turn, so NO Stop follows it — it
  // stays after the last Stop and is still surfaced. A tool's PostToolUse is appended
  // after its PreToolUse, so walking newest first meets the close before the open.
  // Subagents log into the parent's session log and keep opening tools while the main
  // thread blocks, so their calls would shadow a held question. Their AskUserQuestion
  // still counts: the question hook doesn't filter subagents, so it can be held too.
  const closed = new Set<string>();
  let pre: HookEvent | undefined;
  for (const e of eventsNewestFirst(sessionId)) {
    if (e.hook_event_name === "Stop") break;
    if (e.hook_event_name === "PostToolUse" && e.tool_use_id) closed.add(e.tool_use_id);
    if (e.agent_id && e.tool_name !== "AskUserQuestion") continue;
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
