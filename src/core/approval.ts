/**
 * Approval IPC (Inc6) — the consumer side of the attach-aware blocking PreToolUse
 * hook.
 *
 * When a tool needs permission on a DETACHED session, `pretooluse.sh` writes
 * `pending/<sessionId>.json` and block-polls `decisions/<sessionId>.json`.
 * `decideApproval` writes that decision file; the hook reads it and returns the
 * permission decision to Claude. Attached desk sessions never block (the hook
 * exits neutral), so only detached sessions appear in `listPendingApprovals`.
 *
 * Sync (matching the contract `void` signatures); these files are tiny.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { PATHS } from "./config";
import { readEvents, EVENTS_DIR } from "./hook-events";
import { SOURCE_DIR } from "./input-source";
import type { PendingApproval, PendingHold } from "../types";
import type { PendingQuestion } from "./jsonl-reader";

export const PENDING_DIR = `${PATHS.dir}/pending`;
export const DECISIONS_DIR = `${PATHS.dir}/decisions`;

/**
 * How long the blocking APPROVAL hook holds a tool call while polling for a decision:
 * the poll loop in the generated `pretooluse.sh` runs to this deadline. Deliberately
 * short — a hung approval hook blocks the whole session, so Claude's kill must stay
 * close.
 */
export const HOLD_WINDOW_MS = 600_000;

/**
 * How long `questionHook` holds an AskUserQuestion. Much longer than approvals: the
 * hold releases early the moment the user is back at the Mac (focus-release poll), so
 * the window only bounds the away-and-never-answered case — where expiry just drops
 * the question to the native picker, which no longer times out on its own.
 */
export const QUESTION_HOLD_MS = 14_400_000;

/**
 * Extra time Claude0 registers on top of `HOLD_WINDOW_MS` for Claude Code's own PreToolUse
 * timeout — the SIGKILL the poll loops are racing.
 *
 * Claude measures its timeout from hook SPAWN, while a loop can only start its clock once
 * the process is up and stdin is parsed. Registering the two as the same number therefore
 * guarantees the kill lands FIRST, and a killed hook never reaches the `rm -f` that
 * un-registers its marker — which is how orphaned markers are produced in the first place.
 * The grace makes the loop the one that expires first, so it cleans up after itself.
 */
export const HOOK_KILL_GRACE_MS = 15_000;

/** Upper bound on a hold: the full poll window, plus slack for a slow write. */
const MAX_HOLD_MS = HOLD_WINDOW_MS + 10_000;

/** Same bound for question holds, whose poll window is hours, not minutes. */
const QUESTION_MAX_HOLD_MS = QUESTION_HOLD_MS + 10_000;

/**
 * Is the hold recorded in a `pending/*.json` marker still being polled? The hook stamps
 * its own pid; when that process is gone the marker was orphaned (hook killed or crashed
 * mid-block) and nothing will ever read a decision written for it — so callers must fall
 * back to driving the pane instead of writing into the void. The `ts` bound additionally
 * rules out an unrelated process that inherited a recycled pid. Markers with no pid come
 * from a hook installed before the pid stamp and are trusted, so an un-upgraded hook
 * behaves exactly as it did before.
 */
function holdIsLive(raw: PendingHold): boolean {
  if (typeof raw.pid !== "number") return true;
  // Question holds poll for hours; the ts bound must match their window or every
  // reader would reap a perfectly live question hold ten minutes in.
  const maxMs = raw.kind === "question" ? QUESTION_MAX_HOLD_MS : MAX_HOLD_MS;
  if (typeof raw.ts === "number" && Date.now() - raw.ts > maxMs) return false;
  try {
    process.kill(raw.pid, 0); // signal 0 = liveness probe, delivers nothing
    return true;
  } catch {
    return false;
  }
}

/**
 * Read `pending/<sessionId>.json` if a live hook is holding it. A live marker is left
 * alone (three callers read it independently); only an orphaned one is reaped on the way
 * out, so the phantom hold stops being reported on every later poll. Returns null when
 * absent, corrupt, or dead.
 */
function readOrReapHold(sessionId: string): PendingHold | null {
  const file = `${PENDING_DIR}/${sessionId}.json`;
  let raw: PendingHold;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // absent or half-written
  }
  if (holdIsLive(raw)) return raw;
  rmSync(file, { force: true });
  return null;
}

/** Is a live question-hook holding this session's AskUserQuestion for the phone? */
export function questionHeld(sessionId: string): boolean {
  return readOrReapHold(sessionId)?.kind === "question";
}

/** All sessions blocked on a detached approval (globs `pending/*.json`). */
export function listPendingApprovals(): PendingApproval[] {
  let files: string[];
  try {
    files = readdirSync(PENDING_DIR);
  } catch {
    return []; // dir not created yet
  }

  const out: PendingApproval[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      // The filename resolves the path (it's needed before the record can be read); the
      // record's own `sessionId` still wins for what we report.
      const fileId = f.replace(/\.json$/, "");
      // Skip (and reap) a marker whose hook is gone — the caller must drive the pane.
      const raw = readOrReapHold(fileId);
      if (!raw) continue;
      // A held AskUserQuestion intercept shares this dir but is not an approval.
      if (raw.kind === "question") continue;
      const sessionId: string = raw.sessionId ?? fileId;
      // The shell writes a minimal record; enrich `input` from the logged
      // PreToolUse event (full tool_input is already in the event log).
      let input = raw.input;
      if (input === undefined) {
        const pre = readEvents(sessionId)
          .filter((e) => e.hook_event_name === "PreToolUse" && e.tool_use_id === raw.tool_use_id)
          .pop();
        input = pre?.tool_input;
      }
      out.push({
        sessionId,
        ts: raw.ts ?? 0,
        tool: raw.tool ?? "",
        tool_use_id: raw.tool_use_id ?? "",
        input,
      });
    } catch {
      continue; // corrupt/half-written — skip
    }
  }
  return out;
}

/**
 * Garbage-collect on-disk session files (`events/`, `pending/`, `decisions/`)
 * whose `<session_id>` has no live tmux pane (Inc7 rotation, data-model §7).
 * `liveSessionIds` is the pane↔session liveness already computed during discovery
 * — reuse it, don't add a scan. Reaps zombie approvals from a killed-mid-block
 * pane and unbounded dead-session logs.
 */
export function reapDeadSessionFiles(liveSessionIds: Set<string>): void {
  for (const dir of [EVENTS_DIR, PENDING_DIR, DECISIONS_DIR, SOURCE_DIR]) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue; // dir not created yet
    }
    for (const f of files) {
      // Only reap finished session files. In-flight temp files (e.g. the Stop
      // hook's `<id>.jsonl.tmp` during an atomic log-trim) must be left alone —
      // deleting one mid-rename makes the hook's `mv` fail with ENOENT.
      const m = f.match(/^(.*)\.(jsonl|json|pushed)$/);
      if (!m) continue;
      const sessionId = m[1];
      if (!liveSessionIds.has(sessionId)) {
        try {
          rmSync(`${dir}/${f}`);
        } catch {
          // already gone / racing another reaper — fine
        }
      }
    }
  }
}

/**
 * Resolve a pending approval. Writes `decisions/<sessionId>.json`; the blocking
 * hook polls it (every 500ms) and maps `decision` to `permissionDecision`. The
 * `tool_use_id` lets the hardened poll consume only its own decision — a stale
 * question decision (or a mismatched approval) must not satisfy this block.
 */
export function decideApproval(
  sessionId: string,
  decision: "allow" | "deny",
  opts?: { reason?: string; toolUseId?: string },
): void {
  try {
    mkdirSync(DECISIONS_DIR, { recursive: true });
    const payload: Record<string, unknown> = {
      sessionId,
      kind: "approval",
      decision,
      ts: Date.now(),
    };
    if (opts?.toolUseId) payload.tool_use_id = opts.toolUseId;
    if (opts?.reason) payload.reason = opts.reason;
    writeFileSync(`${DECISIONS_DIR}/${sessionId}.json`, JSON.stringify(payload));
  } catch {
    // Non-fatal — the hook's 600s timeout falls through to the desk TUI prompt.
  }
}

/**
 * Write `decisions/<sessionId>.json` (kind:"question") ONLY when a matching
 * `pending/<sessionId>.json` (kind:"question" and same `tool_use_id`) is being held by a
 * question-hook that is still running. `outcome` carries what the hook should do with it:
 * `answers` to resolve the tool, or `clarify` to deny it. Returns whether it wrote.
 */
function writeQuestionDecision(
  sessionId: string,
  toolUseId: string,
  outcome: { answers: Record<string, string> } | { clarify: true },
): boolean {
  try {
    const raw = readOrReapHold(sessionId);
    if (raw?.kind !== "question" || raw.tool_use_id !== toolUseId) return false;
    mkdirSync(DECISIONS_DIR, { recursive: true });
    writeFileSync(
      `${DECISIONS_DIR}/${sessionId}.json`,
      JSON.stringify({ sessionId, kind: "question", tool_use_id: toolUseId, ...outcome, ts: Date.now() }),
    );
    return true;
  } catch {
    // No matching pending question (no hook holding) → caller sends keys instead.
    return false;
  }
}

/**
 * Resolve a held AskUserQuestion intercept. Returns whether a live hook was holding it —
 * the caller uses `false` to fall back to the send-keys path (un-intercepted /
 * native-widget case, and an abandoned hold, where the question has fallen through to the
 * on-screen widget).
 */
export function decideQuestion(
  sessionId: string,
  toolUseId: string,
  answers: Record<string, string>,
): boolean {
  return writeQuestionDecision(sessionId, toolUseId, { answers });
}

/**
 * Decline a held AskUserQuestion so the agent yields the turn and lets the user chat
 * (the phone's "Chat about this"). Writes `decisions/<sessionId>.json` with `clarify:true`
 * instead of answers — the question-hook turns this into a `permissionDecision:"deny"`.
 * Returns `false` (no live hold) for the un-intercepted native-widget case and for an
 * abandoned hold, neither of which has a decline-via-file path — declining is the one
 * action with no keystroke equivalent, so the caller surfaces it as a rejection.
 */
export function declineQuestion(sessionId: string, toolUseId: string): boolean {
  return writeQuestionDecision(sessionId, toolUseId, { clarify: true });
}

/**
 * Build the wire-format `answers` map for `updatedInput`: keyed by question TEXT
 * (the wire format requires it), value = the selected option label (single-select)
 * or comma-joined labels (multi-select). Identical question text within one prompt
 * collides (last-wins) — Claude doesn't emit identically-worded questions in one
 * call. A multi-select label containing a comma is ambiguous on the wire (known
 * limit, matches ccgram).
 */
export function buildAnswersMap(
  questions: PendingQuestion[],
  selections: (number | number[])[],
): Record<string, string> {
  const map: Record<string, string> = {};
  questions.forEach((q, i) => {
    const sel = selections[i];
    const labelFor = (n: number) => q.options[n]?.label ?? "";
    map[q.question] = Array.isArray(sel) ? sel.map(labelFor).join(",") : labelFor(sel ?? -1);
  });
  return map;
}
