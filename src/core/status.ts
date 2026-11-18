/**
 * Detects the status of a Claude Code session from captured tmux pane output.
 */

export type SessionStatus = "running" | "waiting" | "ready" | "idle" | "archived";

export interface StatusResult {
  status: SessionStatus;
  contextPercent?: number;
}

const RUNNING_PATTERNS = [
  /^ *[·✢✳✶∗✻✽] .*…/m,             // Spinner char + active verb with ellipsis (e.g. "✳ Adding…")
  /^ *·\s*$/m,                     // Standalone middle dot (initial thinking state, no text yet)
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,               // Legacy braille spinner characters
];

const WAITING_PATTERNS = [
  /Do you want to /i,            // Tool confirmation prompts (proceed, make this edit, etc.)
  /Claude wants to/,            // Tool use confirmation
  /Allow\s+Deny/,               // Permission buttons
  /Always allow/,               // Permission option
  /\(y\/n\)/i,                  // "(y/n)" confirmation
  /\[Y\/n\]/,                   // "[Y/n]" confirmation
  /\[y\/N\]/,                   // "[y/N]" confirmation
  /Would you like to proceed/i,  // Plan mode approval prompt
];

// The AskUserQuestion widget's own tells, safe against look-alikes: the option-list
// footer says "Enter to select" (the rewind picker says "Enter to continue", permission
// prompts have no such footer), and the multi-question wizard adds a ←/→ checkbox nav
// bar. Deliberately NOT the ☐ glyph alone — task-list lines reuse it, so a running
// session's todo list would read as an open picker.
const QUESTION_PICKER_PATTERNS = [
  /Enter to select/, // option-list footer (single- and multi-question widgets)
  /←.*[☐✔].*→/, // multi-question tab nav bar
];

/**
 * Whether an AskUserQuestion widget is visibly on the captured pane bottom.
 * Trailing blank rows are trimmed first: a capture spans the full pane height, and on
 * a short session the widget sits at the top of mostly-empty rows — the sample must be
 * the bottom of the CONTENT, not the bottom of the pane. Pure classifier, exported for
 * tests.
 */
export function questionPickerVisible(capturedOutput: string): boolean {
  const bottom = capturedOutput.trimEnd().split("\n").slice(-20).join("\n");
  return QUESTION_PICKER_PATTERNS.some((p) => p.test(bottom));
}

// A tool PERMISSION prompt (Edit/Bash/etc.) — Claude's numbered Yes/No confirmation shown
// before a tool runs. Answered by Enter (option 1 "Yes" is pre-selected) / Escape (deny),
// unlike AskUserQuestion (index-nav over checkboxes). Used to surface ATTACHED approvals to
// the bridge: the blocking PreToolUse hook exits neutral for attached sessions (so the
// instant desk prompt shows) and never writes a pending file, so the live pane is the only
// authoritative source that a decision is genuinely required.
const PERMISSION_PROMPT_PATTERNS = [
  /Do you want to /i,            // "Do you want to proceed? / make this edit?"
  /Would you like to proceed/i,  // Plan-mode approval prompt
  /^\s*❯?\s*1\.\s*Yes\b/m,       // The numbered "1. Yes" affirmative option
];

/**
 * Whether a tool permission prompt is currently on-screen. Scoped to the bottom of the
 * capture (where the prompt renders) so stale "do you want to…" text in scrollback can't
 * trigger it, and excludes the AskUserQuestion checkbox UI (that has its own answer path).
 * Callers gate this behind `status === "waiting"` — it's the second confirmation that the
 * pane is blocked ON a permission decision, not the primary waiting/running classifier.
 */
export function isPermissionPrompt(capturedOutput: string): boolean {
  const bottom = capturedOutput.split("\n").slice(-20).join("\n");
  if (questionPickerVisible(capturedOutput)) return false;
  return PERMISSION_PROMPT_PATTERNS.some((p) => p.test(bottom));
}

const SEPARATOR_RE = /^[─━═─\-▪][─━═─\-\s▪]{3,}/;
const TIP_RE = /^⎿\s+Tip:/;  // UI tip lines shown during running — skip like separators
const TASK_RE = /^(?:⎿\s+)?[✔◼◻☐]\s/;  // Task list items (completed/in-progress/pending) — skip to reach spinner
const TASK_SUMMARY_RE = /^…\s+\+\d+/;  // Collapsed task summary (e.g. "… +6 completed") — skip to reach spinner

/**
 * Extract content lines immediately above the ❯ prompt.
 * Claude Code TUI layout (bottom of screen):
 *   [content lines]         ← conversation/tool output
 *   [status line]           ← spinner or completion indicator
 *   [queued message UI]     ← optional, when user types while Claude is running
 *   ────────────────────    ← separator
 *   ❯ [user input]         ← prompt
 *   ────────────────────    ← separator
 *   stats line              ← context %, model, branch
 *   toolbar                 ← accept edits, etc.
 *   [subagent list UI]      ← optional ❯ ◯-prefixed items shown on hover
 *
 * Returns { statusLine, nearbyLines } where:
 *   statusLine = the spinner line if found within range, else the first content line above the prompt
 *   nearbyLines = up to 3 such lines (for multi-line waiting prompts)
 */
export function getAbovePrompt(lines: string[]): { statusLine: string; nearbyLines: string } {
  // Find the real ❯ input prompt: a ❯ line whose preceding non-empty line is a separator.
  // This excludes subagent list items ("❯ ◯ .plan-reviewer") that appear below the prompt.
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("❯")) continue;
    let prev = -1;
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      if (lines[j].trim()) { prev = j; break; }
    }
    if (prev !== -1 && SEPARATOR_RE.test(lines[prev].trim())) {
      promptIdx = i;
      break;
    }
  }
  // Fallback: last ❯ (handles edge cases where the separator is missing or off-screen)
  if (promptIdx === -1) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes("❯")) { promptIdx = i; break; }
    }
  }
  if (promptIdx === -1) return { statusLine: "", nearbyLines: "" };

  // Collect non-empty, non-separator lines above the prompt.
  // Scan a wider window than `above.length >= 3` would normally allow, so we can
  // find a spinner sitting above a queued-message UI between it and the prompt.
  const above: string[] = [];
  let spinnerLine = "";
  for (let i = promptIdx - 1; i >= Math.max(0, promptIdx - 25); i--) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || SEPARATOR_RE.test(trimmed) || TASK_RE.test(trimmed) || TASK_SUMMARY_RE.test(trimmed)) continue;
    // Skip right-aligned decorative content (e.g. Mottlex companion art)
    const leadingSpaces = line.length - line.trimStart().length;
    if (leadingSpaces > line.length * 0.6 && trimmed.length < 30) continue;
    if (TIP_RE.test(trimmed)) {
      // Tip line found — discard any continuation lines we already collected
      // (in narrow panes, tips wrap and continuations appear between tip header and separator)
      above.length = 0;
      spinnerLine = "";
      continue;
    }
    if (!spinnerLine && RUNNING_PATTERNS.some(p => p.test(trimmed))) {
      // Spinner marks the bottom of the active region — older content above it
      // is pre-spinner history (past assistant messages, user answers, etc.) and
      // must not pollute nearbyLines, or stray "do you want to" text from
      // earlier in the conversation will falsely trigger the waiting check.
      spinnerLine = trimmed;
      above.push(trimmed);
      break;
    }
    above.push(trimmed);
    if (above.length >= 8) break;
  }
  return {
    statusLine: spinnerLine || above[0] || "",
    nearbyLines: above.slice(0, 3).join("\n"),
  };
}

export function detectStatus(
  capturedOutput: string,
  hasProcess: boolean,
): StatusResult {
  if (!hasProcess) {
    return { status: "idle" };
  }

  const lines = capturedOutput.split("\n");
  const contextPercent = parseContextPercent(capturedOutput);
  const { statusLine, nearbyLines } = getAbovePrompt(lines);

  // 1. Waiting: permission/confirmation prompts take priority over running
  //    (spinner chars can linger in pane output while a prompt is displayed)
  for (const pattern of WAITING_PATTERNS) {
    if (pattern.test(nearbyLines)) {
      return { status: "waiting", contextPercent };
    }
  }

  // 2. Waiting: an AskUserQuestion widget replaces the input box at the bottom of screen
  if (questionPickerVisible(capturedOutput)) {
    return { status: "waiting", contextPercent };
  }

  // 3. Running: spinner on the status line (first line above prompt separator).
  //    Only check statusLine — old spinner text (e.g. "✻ Optimus Priming…") lingers
  //    in nearbyLines/scrollback after Claude finishes, causing false positives.
  for (const pattern of RUNNING_PATTERNS) {
    if (pattern.test(statusLine)) {
      return { status: "running", contextPercent };
    }
  }

  // 4. Ready: has a process but no spinner or prompt detected
  return { status: "ready", contextPercent };
}

function parseContextPercent(capturedOutput: string): number | undefined {
  const ctxMatch = capturedOutput.match(/(\d+(?:\.\d+)?k?)\/(\d+(?:\.\d+)?k?)\s*\((\d+)%\)/);
  if (ctxMatch) {
    return parseInt(ctxMatch[3], 10);
  }
  return undefined;
}

// Relative-time formatting is shared with the phone UI — see `shared/time-ago.js`.
export { formatTimeAgo } from "../shared/time-ago.js";

/**
 * The instant a session last did something, for display. Prefers the last
 * conversational turn over the transcript's file mtime: bookkeeping writes and bulk
 * resumes advance mtime with no conversation behind them, which made long-idle
 * sessions read as minutes old.
 */
export function sessionActivityAt(session: { lastTurnAt?: Date; modified: Date }): Date {
  return session.lastTurnAt ?? session.modified;
}
