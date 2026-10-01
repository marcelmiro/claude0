/**
 * Per-session input-source attribution (portkey push notifications).
 *
 * The bridge's mutating routes call `markPortkeySource` on a successful action,
 * writing `source/<sessionId>.json`. At notification-dispatch time the monitor
 * calls `sourceForSession` to decide whether the most recent input on a session
 * came from portkey (→ push) or the Mac TUI (→ stay silent).
 *
 * Attribution anchors on values INTRINSIC to the hook events — a
 * `UserPromptSubmit`'s `prompt_id` (current-turn identity) and the sent message
 * `text`. Both survive `event.sh`'s `tail -200` log truncation: no absolute
 * indices, no timestamps. A turn scrolled out of the window fails to `"tui"`
 * (missed push — the tolerable direction), never a stuck `"portkey"`.
 *
 * The `.json` extension is deliberate: the GC regex in `approval.ts`
 * (`reapDeadSessionFiles`) matches `<id>.json` and reaps dead-session markers
 * with no regex change.
 */

import { readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { PATHS, writeAtomic } from "./config";
import { readEvents } from "./hook-events";
import type { InputSource } from "../types";

export const SOURCE_DIR = `${PATHS.dir}/source`;

interface SourceMarker {
  turnPromptId?: string;
  text?: string;
  /** Which portkey device drove the action — the push target for this turn. */
  deviceId?: string;
}

function markerPath(sessionId: string): string {
  return `${SOURCE_DIR}/${sessionId}.json`;
}

/**
 * Record that portkey drove this session. Message/rewind routes pass `text` (the sent
 * message); answer/decision routes pass nothing. BOTH anchors are always written when
 * available: a message sent while the session is mid-turn is queued and — when consumed
 * inside a tool loop — never fires its own `UserPromptSubmit`, so the text alone would
 * never match and the turn-complete push would be wrongly suppressed. The still-current
 * turn's `prompt_id` covers that case; the text covers the turn-end dequeue (a NEW
 * prompt whose text is ours). Atomic (`.tmp`→rename) so a concurrent reader never sees
 * a half-written file. Non-fatal on error.
 */
export function markPortkeySource(
  sessionId: string,
  opts: { deviceId?: string; text?: string } = {},
): void {
  try {
    mkdirSync(SOURCE_DIR, { recursive: true });
    const marker: SourceMarker = {};
    if (opts.deviceId != null) marker.deviceId = opts.deviceId;
    if (opts.text != null) marker.text = opts.text;
    const events = readEvents(sessionId);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.hook_event_name === "UserPromptSubmit" && events[i]!.prompt_id) {
        marker.turnPromptId = events[i]!.prompt_id;
        break;
      }
    }
    writeAtomic(markerPath(sessionId), JSON.stringify(marker));
  } catch {
    // Non-fatal — a missed marker just means no push for this action.
  }
}

/**
 * Turns the harness injects, which Claude logs as `UserPromptSubmit` with a
 * prompt_id of their own: a completed background task and a subagent's hand-back.
 * The human did not type them, so they must not shadow the portkey marker — the
 * phone still drove this session. Sibling list for JSONL records (not hook events):
 * `NON_PROMPT_PREFIXES` in last-turn.ts.
 */
const INJECTED_PROMPT =
  /^\s*<(task-notification|agent-message|teammate-message|system-reminder)\b/;

/**
 * Whether the most recent input on this session came from portkey — and if so,
 * from which device (the push target). No marker ⇒ `"tui"`. Matches when the
 * human's latest real prompt was the portkey message (text-match) OR portkey acted
 * inside the still-current turn (`prompt_id`-match). A newer TYPED turn shadows the
 * marker ⇒ `"tui"`.
 *
 * The two anchors deliberately read different references. `text` compares against the
 * latest NON-injected prompt: a background task finishing mid-turn logs its own
 * UserPromptSubmit, and comparing against that would drop the attribution and silently
 * kill the turn-complete push — with no fallback, because `turnPromptId` names the
 * PREVIOUS turn on this path (`markPortkeySource` runs on the send route, before Claude
 * has logged the new turn's UserPromptSubmit). `prompt_id` compares against the latest
 * prompt of ANY kind, because it identifies the currently-active turn — which is exactly
 * an injected one when a message is queued into a task-notification's turn.
 */
export function sourceForSession(sessionId: string): InputSource {
  let marker: SourceMarker;
  try {
    marker = JSON.parse(readFileSync(markerPath(sessionId), "utf8")) as SourceMarker;
  } catch {
    return { source: "tui" }; // no marker (fresh / TUI-only session)
  }

  const events = readEvents(sessionId);
  let lastUps: { prompt?: string; prompt_id?: string } | undefined; // any kind — the active turn
  let lastTyped: { prompt?: string; prompt_id?: string } | undefined; // the human's own
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.hook_event_name !== "UserPromptSubmit") continue;
    lastUps ??= e;
    if (!INJECTED_PROMPT.test(e.prompt ?? "")) {
      lastTyped = e;
      break;
    }
  }

  const portkey: InputSource = { source: "portkey", deviceId: marker.deviceId };
  if (marker.text != null && lastTyped?.prompt?.trim() === marker.text.trim()) return portkey;
  if (marker.turnPromptId != null && lastUps?.prompt_id === marker.turnPromptId) return portkey;
  return { source: "tui" };
}

/**
 * Drop the portkey marker — the user took the session over at the Mac (focused
 * its pane in the terminal), so later transitions must not push to a phone.
 */
export function clearSource(sessionId: string): void {
  try {
    unlinkSync(markerPath(sessionId));
  } catch {
    // Already gone / never marked — fine.
  }
}
