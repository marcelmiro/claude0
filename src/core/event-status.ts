/**
 * Event-sourced status derivation (Contract A).
 *
 * Pure function over the raw `HookEvent` history (append order, newest last).
 * Status comes from hook edges, NOT the scraped viewport — so the scroll-up
 * viewport that fools `detectStatus` (status.ts) is irrelevant here.
 *
 * Status is exactly what the newest determining edge says — a pure edge model,
 * no transcript backstop. Walks newest → oldest and returns on the first edge
 * that determines status, so a trailing meta/unknown event never strands it.
 *
 * Truth table (see `event-status.test.ts`):
 *   SessionStart                     → idle
 *   UserPromptSubmit                 → running
 *   PreToolUse (no PostToolUse yet)  → running   (AskUserQuestion → waiting:
 *                                                 a pending question blocks on the user)
 *   PostToolUse (result in hand,     → running   (still working until Stop/idle —
 *     no Stop)                                     never map a bare PostToolUse to ready)
 *   Notification permission_prompt   → waiting
 *   Notification idle_prompt         → ready
 *   Stop                             → ready
 *   SubagentStop                     → (non-determining; skip — see below)
 *
 * No transcript-based backstop: earlier versions demoted a "running" edge to
 * "ready" using transcript silence (a timeout) or a dangling PreToolUse's
 * tool_result (pairing). Both fired on genuinely-working sessions — long
 * Bash/auto-mode/subagent runs go silent, and a stale dangling tool from a prior
 * turn made a fresh running turn read "ready" — producing spurious turnComplete
 * attention pings. A dropped terminal edge is rare and self-heals on the next
 * event, so trusting the edges is both simpler and more correct.
 */

import type { SessionStatus } from "./status";

// Re-export so `event-status.test.ts` can import `HookEvent` from "./event-status".
export type { HookEvent } from "../types";
import type { HookEvent } from "../types";

export function deriveStatus(events: HookEvent[]): SessionStatus {
  for (let i = events.length - 1; i >= 0; i--) {
    const status = edgeStatus(events[i]);
    if (status) return status;
  }
  return "idle";
}

/** The status one event determines on its own, or null for a non-determining edge. */
export function edgeStatus(event: HookEvent): SessionStatus | null {
  switch (event.hook_event_name) {
    case "Stop":
      return "ready";
    case "Notification":
      if (event.notification_type === "permission_prompt") return "waiting";
      if (event.notification_type === "idle_prompt") return "ready";
      return null; // unknown notification flavor — look further back
    case "PreToolUse":
      // A pending AskUserQuestion is the model blocked on the user — `waiting`,
      // not `running`. It emits no permission_prompt Notification (it's a tool,
      // not a permission gate), so this is the only place it can be typed.
      // Permission-gated tools still flow through Notification above.
      return event.tool_name === "AskUserQuestion" ? "waiting" : "running";
    case "PostToolUse":
      // The tool finished, but the turn has not (no Stop) — Claude is still
      // working with the result. A bare PostToolUse is `running`, not `ready`.
      return "running";
    case "UserPromptSubmit":
      return "running";
    case "SubagentStop":
      // NON-determining: a subagent finishing says nothing about whether the
      // PARENT turn is running — that's decided by the parent's own edges. In
      // auto-mode / agent sessions a SubagentStop routinely trickles in AFTER the
      // turn's Stop+idle_prompt; returning "running" here un-finished a done
      // session (the stuck-running bug). Skip it and read the real status behind.
      return null;
    case "SessionStart":
      return "idle";
    default:
      return null;
  }
}
