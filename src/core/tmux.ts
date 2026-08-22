import type { PaneInfo } from "../types.ts";
import { isPermissionPrompt } from "./status";
import { retryOnDeadline } from "./deadline";
import { USER_SHELL } from "./launch-command";
import { clientActivityPresence } from "./presence";

/** Plain shells, as `pane_current_command`/window names — the shared answer to
 *  "is this pane just sitting at a shell?" (reset keep-list, restore-sessions
 *  safety check, sidebar corpse detection). */
export const SHELL_NAMES = ["zsh", "bash", "fish", "sh"];

/**
 * Get the "main" tmux session name (i.e. not the popup session).
 *
 * Prefers the session of an ATTACHED client: the bridge runs as a detached
 * background process, so `display-message -p '#S'` would resolve to tmux's
 * most-recently-active session — non-deterministic, and not necessarily the one
 * the user is sitting in. Targeting the attached client keeps phone-created
 * sessions landing where the user actually works. Falls back to the current
 * session when nothing is attached (e.g. the TUI popup, which shares context).
 */
export async function getMainSession(): Promise<string | null> {
  try {
    // An attached client's session is the user's real session; the bridge isn't a client.
    const attached = (await Bun.$`tmux list-clients -F '#{client_session}'`.quiet().text())
      .trim()
      .split("\n")
      .filter(Boolean)[0];
    // Popup runs in the same session context (tmux 3.3+), so current IS the main session
    const session = attached || (await Bun.$`tmux display-message -p '#S'`.quiet().text()).trim();
    if (!session) return null;
    // Return session:windowId so new-window -a inserts after the active window
    const windowId = (await Bun.$`tmux display-message -t ${session} -p '#{window_id}'`.quiet().text()).trim();
    return windowId ? `${session}:${windowId}` : session;
  } catch {
    return null;
  }
}

/**
 * List all tmux panes across every session and window.
 * Returns an empty array if tmux is not running or the command fails.
 */
export async function listPanes(): Promise<PaneInfo[]> {
  try {
    const output = await retryOnDeadline(
      () =>
        Bun.$`tmux list-panes -a -F '#{pane_tty} #{pane_id} #{session_name} #{window_index} #{window_name} #{pane_current_path}'`
          .quiet()
          .text(),
      5000,
      "tmux list-panes",
    );

    const lines = output.trim().split("\n").filter(Boolean);

    return lines.map((line) => {
      const [tty, paneId, sessionName, windowIndexStr, windowName, ...pathParts] =
        line.split(" ");
      return {
        tty,
        paneId,
        sessionName,
        windowIndex: parseInt(windowIndexStr, 10),
        windowName,
        currentPath: pathParts.join(" "),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Capture the last 50 lines of visible content from the given tmux pane.
 * Pass escapes: true to include ANSI escape sequences (for color rendering).
 * Returns an empty string if the pane doesn't exist or tmux isn't running.
 *
 * Scraper-fallback width caveat (Inc7 #4): `detectStatus` patterns assume a wide
 * enough pane that the spinner/prompt lines don't wrap. Claude0 launches sessions with
 * `tmux new-window` (inherits the client width) and must not reflow existing panes,
 * so there is no `new-session -x 120` site to pin. This only affects pre-hook
 * sessions on the scraper path; event-status (now primary) is width-independent.
 */
export async function capturePane(
  paneId: string,
  options?: { escapes?: boolean },
): Promise<string> {
  try {
    const args = ["-t", paneId, "-p", "-J", "-S", "-50"];
    if (options?.escapes) args.push("-e");
    const output = await retryOnDeadline(() => Bun.$`tmux capture-pane ${args}`.quiet().text(), 5000, "tmux capture-pane");
    return output;
  } catch {
    return "";
  }
}

/**
 * Rename a tmux window.
 */
export async function renameWindow(
  sessionName: string,
  windowIndex: number,
  name: string,
): Promise<void> {
  try {
    // Use Bun.spawnSync instead of Bun.$ to avoid a Bun shell bug where
    // multiple interpolated variables with Unicode chars (like ⚡) cause
    // internal variable names to leak into arguments.
    Bun.spawnSync(["tmux", "rename-window", "-t", `${sessionName}:${windowIndex}`, name]);
  } catch {
    // window may have closed
  }
}

/**
 * Kill a tmux pane by its ID.
 */
export async function killPane(paneId: string): Promise<void> {
  try {
    await Bun.$`tmux kill-pane -t ${paneId}`.quiet();
  } catch {
    // pane may already be gone
  }
}


/**
 * Get the current window name for a tmux session:window.
 */
export async function getWindowName(sessionName: string, windowIndex: number): Promise<string> {
  try {
    const output = await Bun.$`tmux display-message -t ${sessionName}:${windowIndex} -p '#{window_name}'`.quiet().text();
    return output.trim();
  } catch {
    return "";
  }
}

/**
 * Display a brief message in the tmux status bar.
 * Uses -c to target the most recently active client, so it works from
 * background processes that aren't attached to a tmux client.
 */
export async function displayMessage(message: string): Promise<void> {
  try {
    // Get the most recently active tmux client
    const client = (await Bun.$`tmux list-clients -F '#{client_name}'`.quiet().text()).trim().split("\n")[0];
    if (client) {
      await Bun.$`tmux display-message -c ${client} ${message}`.quiet();
    }
  } catch {
    // no tmux clients attached
  }
}

/**
 * Send key names (e.g. "Enter", "Down", "Escape") to a tmux pane.
 */
export async function sendKeys(paneId: string, keys: string[]): Promise<void> {
  try {
    const args = ["-t", paneId, ...keys];
    await Bun.$`tmux send-keys ${args}`.quiet();
  } catch {
    // pane may have closed
  }
}

/**
 * Send literal text followed by Enter to a tmux pane.
 *
 * The text and the Enter MUST be separate tmux writes with a gap between them.
 * A chained `send-keys -l text ; send-keys Enter` (one coalesced write) makes the
 * bytes arrive in a single burst, which Claude's TUI reads as a *paste*: the
 * trailing `\r` is absorbed as a newline inside the input box instead of
 * submitting, so the message sits in the prompt unsent (and stacks up on retry).
 * This is the same coalescing hazard documented in `sendKeysSequential`. Sending
 * the text, pausing, then sending a standalone Enter lets Claude commit the input
 * and interpret the Enter as a submit.
 */
export async function sendTextAndEnter(paneId: string, text: string): Promise<void> {
  try {
    // `--` ends option parsing: a message starting with `-` (a bullet list) is otherwise
    // read by tmux as a flag ("invalid flag"), and nothing is typed.
    Bun.spawnSync(["tmux", "send-keys", "-t", paneId, "-l", "--", text]);
    await Bun.sleep(250);
    Bun.spawnSync(["tmux", "send-keys", "-t", paneId, "Enter"]);
  } catch {
    // pane may have closed
  }
}

/** Send a single tmux key/chord (e.g. "Up", "Enter", "Escape", "C-u") to a pane. */
export async function sendKey(paneId: string, key: string): Promise<void> {
  try {
    Bun.spawnSync(["tmux", "send-keys", "-t", paneId, key]);
  } catch {
    // pane may have closed
  }
}

/** Send literal text to a pane WITHOUT a trailing Enter (cf. sendTextAndEnter). */
export async function sendLiteral(paneId: string, text: string): Promise<void> {
  try {
    Bun.spawnSync(["tmux", "send-keys", "-t", paneId, "-l", "--", text]);
  } catch {
    // pane may have closed
  }
}

/**
 * Send text wrapped in bracketed-paste markers (`ESC[200~ … ESC[201~`), i.e. exactly what
 * a real terminal paste looks like. This is the trigger that makes Claude Code's TUI treat
 * an image file path as an inline `[Image #N]` attachment (verified live: a BARE
 * `send-keys -l <path>` stays literal text; the bracketed-paste form attaches). Claude
 * base64-embeds the file's bytes at paste time, so the file must exist now but is safe to
 * delete after submit.
 */
export async function sendBracketedPaste(paneId: string, text: string): Promise<void> {
  try {
    Bun.spawnSync(["tmux", "send-keys", "-t", paneId, "-l", `\x1b[200~${text}\x1b[201~`]);
  } catch {
    // pane may have closed
  }
}

/**
 * Launch `claude` in a NEW tmux window in `repoPath`, inserted after the active
 * window (`-a`), mirroring the TUI's simple-case new-session launch (index.ts).
 * `targetSession` is `session:windowId` from getMainSession(). The session id is
 * dictated with `--session-id` (minted by the caller) rather than learned from the
 * SessionStart hook after boot, so the caller holds it up front.
 *
 * Wrapped in a login shell (`zsh -c '…; exec zsh -l'`, same convention as
 * launchResumeWindow) rather than exec'd bare: when the bridge daemon (not a tmux
 * client) creates the window, tmux execs the command with the session's minimal
 * environment, and `claude --session-id` then exits 1 during its session-file init —
 * verified live. A login shell sets up the full environment `--session-id` needs, and
 * `exec zsh -l` leaves an inspectable shell if claude ever does exit. Returns the new
 * window's pane id (`-P -F '#{pane_id}'`).
 */
export async function launchClaudeWindow(
  targetSession: string,
  repoPath: string,
  name: string,
  sessionId: string,
): Promise<string> {
  const cmd = `claude --session-id ${sessionId}; exec ${USER_SHELL} -l`;
  // `-d`: don't make the new window active. This launch is driven from the phone (Portkey),
  // so the Mac's tmux client must stay on whatever window the user was in — no focus steal.
  const out =
    await Bun.$`tmux new-window -a -d -t ${targetSession} -n ${name} -c ${repoPath} -P -F ${"#{pane_id}"} ${USER_SHELL} -c ${cmd}`
      .quiet()
      .text();
  return out.trim();
}

/**
 * Resume an existing session in a NEW tmux window: `claude --resume=<sessionId>` in
 * `repoPath`, inserted after the active window but not focused (`-a -d`). Uses the established resume
 * convention `zsh -c '…; exec zsh -l'` (index.ts) so a failed resume leaves an inspectable
 * shell rather than a raced bare-exec close. Returns the new window's pane id so the caller
 * can wait for that pane's SessionStart hook to re-register the session id.
 */
export async function launchResumeWindow(
  targetSession: string,
  repoPath: string,
  name: string,
  sessionId: string,
): Promise<string> {
  const cmd = `claude --resume=${sessionId}; exec ${USER_SHELL} -l`;
  // `-d`: don't make the new window active. Phone-driven (Portkey) resume, so the Mac's tmux
  // client stays on the user's current window — no focus steal.
  const out =
    await Bun.$`tmux new-window -a -d -t ${targetSession} -n ${name} -c ${repoPath} -P -F ${"#{pane_id}"} ${USER_SHELL} -c ${cmd}`
      .quiet()
      .text();
  return out.trim();
}

/**
 * Fork an existing session into a NEW tmux window: `claude --session-id <forkId>
 * --resume=<parentSessionId> --fork-session` in `repoPath`, inserted after the active
 * window but not focused (`-a -d`). The fork mints its own id (`forkId`, minted by the
 * caller like `launchClaudeWindow`) and copies the parent's history up to the fork point,
 * diverging from there; the parent is untouched. Same `zsh -c '…; exec zsh -l'` convention
 * so a failed fork leaves an inspectable shell. Returns the new window's pane id.
 */
export async function launchForkWindow(
  targetSession: string,
  repoPath: string,
  name: string,
  forkId: string,
  parentSessionId: string,
): Promise<string> {
  const cmd = `claude --session-id ${forkId} --resume=${parentSessionId} --fork-session; exec ${USER_SHELL} -l`;
  // `-d`: don't make the new window active. Phone-driven (Portkey) fork, so the Mac's tmux
  // client stays on the user's current window — no focus steal.
  const out =
    await Bun.$`tmux new-window -a -d -t ${targetSession} -n ${name} -c ${repoPath} -P -F ${"#{pane_id}"} ${USER_SHELL} -c ${cmd}`
      .quiet()
      .text();
  return out.trim();
}

/**
 * Send keys ONE AT A TIME with a small gap between them.
 *
 * tmux coalesces a multi-key `send-keys` into a single write, and Claude's TUI
 * then silently DROPS arrow-key escape sequences (`Down`/`Right` = `\e[B`/`\e[C`)
 * and mangles rapid digit toggles when they arrive back-to-back — verified live:
 * batched `Down Down Enter` selected the default option, not the third. Spacing the
 * keys out makes every one register in order. The 250ms gap is empirically the
 * floor that reliably lands a multiSelect digit→digit→Right→Enter sequence (130ms
 * dropped keys; 250ms verified live end-to-end).
 */
export async function sendKeysSequential(
  paneId: string,
  keys: string[],
  gapMs = 250,
): Promise<void> {
  for (const key of keys) {
    await sendKeys(paneId, [key]);
    await Bun.sleep(gapMs);
  }
}

/**
 * Answer an on-screen AskUserQuestion by pressing the option's NUMBER.
 *
 * Claude's question menu is numbered (`1. Apple`, `2. Banana`, …), so the digit is
 * an ABSOLUTE selector — it can't be thrown off by where the cursor starts or by
 * arrow keys being dropped (the old `Down`×n navigation silently picked the first
 * option; verified live). Keys go out sequentially via `sendKeysSequential`.
 *
 * - single-select (`number`): press the option's digit, then `Enter`. On current
 *   Claude (2.1.x) the digit alone auto-submits, so the `Enter` is a harmless no-op
 *   on the empty composer; it's kept as a fallback for older builds where the digit
 *   only highlighted and `Enter` did the submitting.
 * - multiSelect (`number[]`): press each option's digit to toggle its checkbox,
 *   then `Right` (to the Submit tab) + `Enter`.
 *
 * Keyed by paneId because the caller (TUI) already holds the pane; the Impl #3
 * bridge resolves sessionId→paneId before calling. Caller gates on event-status.
 */
export async function answerQuestion(
  paneId: string,
  selections: (number | number[])[],
): Promise<void> {
  await sendKeysSequential(paneId, answerKeys(selections));
  // Recent Claude versions add a "Review your answers" confirmation on the Submit tab
  // (❯ 1. Submit answers). The sequence above ends with an Enter that submits it — but
  // on a busy pane that Enter can arrive before the review screen has painted and get
  // dropped, leaving the answers selected but unconfirmed (the failure the bridge hit).
  // Confirm from the live pane and re-press Enter only when the review is still showing.
  if (await isAnswerReviewOpen(paneId)) await sendKey(paneId, "Enter");
}

/**
 * Whether the AskUserQuestion "Review your answers" confirmation screen is still on-screen
 * (its `❯ 1. Submit answers` / `Ready to submit your answers?` prompt). Scoped narrowly so
 * it fires ONLY for an unconfirmed review — not for a mid-widget state — so the extra Enter
 * can't mis-answer a question tab.
 */
async function isAnswerReviewOpen(paneId: string): Promise<boolean> {
  await Bun.sleep(400); // let the review screen finish painting before we sample it
  const bottom = (await capturePane(paneId)).split("\n").slice(-20).join("\n");
  return /Ready to submit your answers\?|❯\s*1\.\s*Submit answers/.test(bottom);
}

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

/**
 * Whether the AskUserQuestion widget is actually on-screen right now. Gates the
 * send-keys answer fallback: keystrokes fired at a pane that isn't showing the picker
 * (spinner, plain composer) are silently swallowed, so answering must fail honestly
 * instead of reporting ok. Samples after a short settle so a widget mid-repaint isn't
 * misread as absent (same discipline as `isAnswerReviewOpen`).
 */
export async function isQuestionPickerOpen(paneId: string): Promise<boolean> {
  await Bun.sleep(400);
  return questionPickerVisible(await capturePane(paneId));
}

/**
 * Whether the user is demonstrably at the desk looking at this pane: active tmux
 * window + attached client + a client keystroke inside the presence window. TS port
 * of the three probes in `question-pretooluse.sh`'s focus gate (cli.ts) — keep the
 * two in sync. Polarity is the OPPOSITE of the gate's: this feeds the hold's release
 * check, so any probe error/ambiguity returns false (keep holding), whereas the gate
 * fails toward the native widget (don't intercept). Only a positively-confirmed
 * presence releases.
 */
export async function atDeskFocus(paneId: string): Promise<boolean> {
  try {
    const wa = (await Bun.$`tmux display-message -p -t ${paneId} '#{window_active}'`.quiet().text()).trim();
    if (wa !== "1") return false;
    const session = (await Bun.$`tmux display-message -p -t ${paneId} '#{session_name}'`.quiet().text()).trim();
    if (!session) return false;
    const clients = (await Bun.$`tmux list-clients -t ${session}`.quiet().text()).trim();
    if (!clients) return false;
    // Presence = a client of this session typed within the window. Only a positive
    // "present" releases — "unknown" keeps holding.
    return (await clientActivityPresence(session)) === "present";
  } catch {
    return false;
  }
}

/**
 * Whether the picker's "Type something." inline input has focus. In that state digits
 * type characters instead of selecting an option — no key is safe to send. The tell is
 * the `ctrl+g to edit` footer hint, which only renders while that row is focused.
 * Pure classifier, exported for tests.
 */
export function freeTextRowFocused(capturedOutput: string): boolean {
  const bottom = capturedOutput.trimEnd().split("\n").slice(-20).join("\n");
  return /ctrl\+g to edit/.test(bottom);
}

/**
 * The keystroke for the native picker's own "Chat about this" row, read from the
 * RENDERED capture — never computed from the question spec, so it survives layout
 * differences (multi-question tabs, option-count changes). Null when the row isn't
 * identifiable. Pure classifier, exported for tests.
 */
export function chatRowKey(capturedOutput: string): string | null {
  const bottom = capturedOutput.trimEnd().split("\n").slice(-20).join("\n");
  const m = bottom.match(/(\d)\.\s+Chat about this/);
  return m ? m[1]! : null;
}

/**
 * Drive the on-screen picker's "Chat about this" row — the un-held equivalent of the
 * hook's clarify decision (the tool resolves as decline-and-wait, then the phone's
 * typed message continues the conversation). Pre-flights from a fresh capture: no
 * picker, or a permission prompt (also digit-actionable — a digit here would answer
 * it), or a focused free-text row → false, nothing sent. A visible picker whose chat
 * row can't be parsed (future copy change) falls back to Escape, which declines the
 * question the blunter way but still yields the turn for the follow-up message.
 */
export async function clarifyQuestion(paneId: string): Promise<boolean> {
  await Bun.sleep(400); // settle, matching isQuestionPickerOpen's repaint discipline
  const captured = await capturePane(paneId);
  if (!questionPickerVisible(captured) || isPermissionPrompt(captured)) return false;
  if (freeTextRowFocused(captured)) return false;
  await sendKey(paneId, chatRowKey(captured) ?? "Escape");
  return true;
}

/**
 * Dispatch to the right keystroke model by question count (the two are different
 * widgets — see `questionAnswerKeys` vs `multiQuestionKeys`). A single-question
 * answer is a 1-element array; N>1 is the tabbed prompt.
 */
export function answerKeys(selections: (number | number[])[]): string[] {
  return selections.length === 1
    ? questionAnswerKeys(selections[0]!)
    : multiQuestionKeys(selections);
}

/**
 * Pure key-sequence builder for `answerQuestion` (extracted for testability).
 * `selection` is 0-based; the emitted digit is 1-based to match the menu labels.
 *
 * - single-select (`number`): `[String(idx + 1), "Enter"]` — on current Claude (2.1.x)
 *   the digit auto-submits (verified live) so the `Enter` is a no-op on the empty
 *   composer; kept as a fallback for older builds where the digit only highlighted and
 *   `Enter` did the submitting.
 * - multiSelect (`number[]`): de-duped + ascending digits (toggle each), then
 *   `Right`+`Enter` (→ Submit tab, then submit).
 */
export function questionAnswerKeys(selection: number | number[]): string[] {
  if (typeof selection === "number") {
    return [String(selection + 1), "Enter"];
  }
  const sorted = [...new Set(selection)].sort((a, b) => a - b);
  return [...sorted.map((idx) => String(idx + 1)), "Right", "Enter"];
}

/** 1-based menu digits for one question's selection (single → [digit]; multi →
 *  ascending de-duped digits; empty multi → []). Used per-question by `multiQuestionKeys`. */
function selectionDigits(selection: number | number[]): string[] {
  if (typeof selection === "number") return [String(selection + 1)];
  return [...new Set(selection)].sort((a, b) => a - b).map((idx) => String(idx + 1));
}

/**
 * Key sequence for a MULTI-question AskUserQuestion (N>1), which renders as
 * Left/Right-navigable tabs ending in a Submit tab — a different widget from the
 * single-question menu (hence a separate builder from `questionAnswerKeys`).
 *
 * `selections[i]` is question i's answer (0-based option indices): a `number` for
 * single-select, a `number[]` for multi-select (may be empty — an unanswered
 * multi-select is allowed to submit).
 *
 * Model (LIVE-VERIFIED on claude 2.1.x, 2026-07-01, two real prompts):
 *   1. `Left` × N to clamp focus onto the first question tab. The prompt opens on
 *      Q1, but relative arrows can't assume that; `Left` is a no-op at the leftmost
 *      tab (verified — it does NOT wrap), so over-pressing is safe and N covers the
 *      worst case (focus parked on the Submit tab, N tabs to the right of Q1).
 *   2. For each question in order:
 *      - single-select: press the option digit. This selects AND auto-advances to
 *        the next tab (→ Submit after the last question) — so NO `Right` follows.
 *      - multi-select: press the option digit(s) to toggle (no auto-advance), then
 *        `Right` to step to the next tab. An empty multi-select emits just `Right`.
 *   3. `Enter` on the Submit tab.
 * A bare digit selects/toggles within a question (no per-question Enter — that is
 * only the single-question menu's behaviour).
 */
export function multiQuestionKeys(selections: (number | number[])[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < selections.length; i++) keys.push("Left");
  for (const selection of selections) {
    keys.push(...selectionDigits(selection));
    // Single-select auto-advances on the digit; multi-select (incl. empty) needs Right.
    if (Array.isArray(selection)) keys.push("Right");
  }
  keys.push("Enter");
  return keys;
}

/**
 * Switch to the target tmux pane directly via tmux commands.
 * Works from within a tmux display-popup since tmux commands are server-side.
 */
export async function switchToPane(
  paneId: string,
  sessionName: string,
  windowIndex: number,
): Promise<void> {
  try {
    await Bun.$`tmux select-window -t ${sessionName}:${windowIndex}`.quiet();
    await Bun.$`tmux select-pane -t ${paneId}`.quiet();
  } catch {
    // ignore — pane may have closed between selection and switch
  }
}
