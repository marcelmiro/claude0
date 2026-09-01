/**
 * Session handoff surface (Impl 2.5) — the `core/` functions the Impl #3 bridge
 * consumes so it stays a thin transport/presentation layer with no new
 * Claude-wrapping logic. All additive, read-only over existing on-disk artifacts
 * (per-pane files under `panes/`, `events/<id>.jsonl`, transcript JSONL); the senders reuse
 * the existing `send-keys` path. Headless: no blessed/ui imports (boundary.test.ts).
 *
 * `SessionTranscript`/`SendResult` are co-located here (not in `types.ts`) because
 * they reference `PendingToolCall`/`PendingQuestion`, which live in `jsonl-reader.ts`
 * — hoisting them into `types.ts` would create a `types.ts → core/` import that does
 * not exist today.
 */

import { Glob } from "bun";
import { homedir } from "os";
import { resolveTranscriptPath, resolveTranscriptPaths, readLastPromptAt } from "./last-turn";
import { lastAssistantMessage, parseActiveBranch, parseTranscript, TEAMMATE_PREFIX } from "./transcript";
import { pendingToolCall } from "./hook-events";
import { loadPaneSessions, savePaneSessions } from "./state";
import { findClaudeProcesses } from "./process";
import {
  listPanes,
  sendTextAndEnter,
  answerQuestion,
  isQuestionPickerOpen,
  clarifyQuestion,
  getMainSession,
  launchClaudeWindow,
  launchResumeWindow,
  launchForkWindow,
  capturePane,
  sendKey,
  sendLiteral,
  sendBracketedPaste,
  killPane,
} from "./tmux";
import { isPermissionPrompt } from "./status";
import { recoverWorktreeTranscript } from "./recover";
import { buildBaseName } from "./notifications";
import { slugify } from "./names";
import { parseBackgroundTasks, liveScripts, type BackgroundTask } from "./background-tasks";
import { decideQuestion, declineQuestion, buildAnswersMap } from "./approval";
import { parkedJobSessions } from "./session-state";
import { jsonlLines, type PendingQuestion, type PendingToolCall } from "./jsonl-reader";
import type { RestoreState, ToolResultSummary, TranscriptBlock, TranscriptTurn } from "../types";

export interface SessionTranscript {
  turns: TranscriptTurn[];
  lastAssistant?: string;
  pendingTool?: PendingToolCall;
  /** First question of an open AskUserQuestion (single-question display path). */
  openQuestion?: PendingQuestion;
  /** Every question of an open AskUserQuestion (drives the multi-question answer UI). */
  openQuestions?: PendingQuestion[];
  usage?: ContextUsage;
  /** Subagents this session fanned out to (sourced from the `subagents/` dir); omitted when none. */
  subagents?: SubagentSummary[];
  /**
   * Background scripts the session launched and is still waiting on (`run_in_background`
   * Bash whose `<task-notification>` hasn't arrived). The turn genuinely ends during such
   * a wait, so without this the session just reads "ready" while e.g. a pr-triage Codex
   * wait runs for tens of minutes. Omitted when none.
   */
  pendingScripts?: BackgroundTask[];
  /**
   * Messages sitting in Claude Code's input queue — sent while the session was mid-turn
   * and not yet consumed. The phone renders these as dim "queued" bubbles: they are not
   * turns yet (no transcript record beyond the queue op), but without them a second
   * consecutive send is simply invisible until Claude picks it up. Omitted when empty.
   */
  queuedPending?: string[];
  /**
   * ISO instant of the newest real typed prompt — the phone's boundary between subagents
   * that finished "since you last asked" (fresh reports, shown) and older ones (collapsed).
   */
  lastPromptAt?: string;
  /**
   * Opaque disk revision of the transcript file (`size:mtimeMs`) — bumps on ANY JSONL write
   * (append OR rewind's new branch). The phone snapshots it at rewind time and clears its
   * optimistic (truncated + prefilled) view once `rev` changes, i.e. once the resend lands.
   */
  rev?: string;
}

/**
 * One `Agent`/`Task` subagent the phone can drill into. Sourced from the session's
 * `subagents/agent-<agentId>.meta.json` + the agent's own jsonl. `spawnDepth` is present
 * on only ~43% of agents (a cheap indent when we have it) — hence optional.
 */
export interface SubagentSummary {
  agentId: string;
  agentType: string;
  description: string;
  status: "done" | "running";
  spawnDepth?: number;
  /** When a done agent's jsonl last grew (its completion instant, as mtime ISO). */
  finishedAt?: string;
}

/** Context-window usage for the mobile status-bar readout (mirrors the Mac statusline). */
export interface ContextUsage {
  tokens: number; // input + cache_creation + cache_read of the last assistant turn
  size: number; // context-window size the tokens are measured against
  percent: number; // rounded tokens/size
}

/** The Claude pane's rendered statusline + permission-mode line, scraped from capture. */
export interface PaneStatusline {
  statusline?: string; // the user's custom statusline text (tokens • branch • model • …)
  mode?: string; // e.g. "⏵⏵ auto mode on", "⏸ plan mode on"
  model?: string; // current model as an arg key (opus/sonnet/…), parsed from the statusline
  effort?: string; // current reasoning effort (low/…/ultracode), when the statusline renders it
}

// The model/effort arg forms Claude accepts (`/model <x>`, `/effort <x>`) — the switcher's
// allowlists. Note the `[1m]` suffix, NOT the bare alias: `opus` resolves to the non-1M base
// model, whereas the picker's "Opus" and "Default" both select the 1M variant. The `opus`
// alias tracks the current Opus (Opus 5); the previous Opus has no alias and is reachable
// only by its full model id.
export const MODEL_ARGS = [
  "default",
  "opus[1m]",
  "claude-opus-4-8[1m]",
  "fable",
  "sonnet",
  "haiku",
] as const;
export const EFFORT_ARGS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;
export const isModelArg = (v: string): boolean => (MODEL_ARGS as readonly string[]).includes(v);
export const isEffortArg = (v: string): boolean => (EFFORT_ARGS as readonly string[]).includes(v);

// Non-Opus families map display → arg key directly. Opus is special (1M vs base variant) and
// is handled inline in parseStatusline.
const MODEL_FAMILIES: Array<[RegExp, string]> = [
  [/sonnet/i, "sonnet"],
  [/haiku/i, "haiku"],
  [/fable/i, "fable"],
];

/**
 * Parse the current model (as an arg key) and effort level out of the rendered statusline
 * (`tokens • branch • model • <effort>`), by TOKEN-SCAN not fixed index — the effort segment
 * is absent for models without reasoning effort, and its position shifts. Returns only the
 * fields it can identify; a garbled/foreign statusline yields `{}` (never throws).
 *
 * Opus renders its version in the display name ("Opus 5", "Opus 4.8") plus a "(1M context)"
 * suffix on the 1M variant — so "Opus 5 (1M context)" → `opus[1m]` (the menu's Opus option,
 * also how "Default" renders), while plain "Opus 5" → `opus` (the non-1M base, not in the menu
 * so it simply marks nothing).
 */
export function parseStatusline(line: string): { model?: string; effort?: string } {
  const out: { model?: string; effort?: string } = {};
  for (const raw of line.split("•")) {
    const seg = raw.trim();
    if (isEffortArg(seg)) out.effort = seg; // effort is the trailing segment — last match wins
    if (!out.model) {
      if (/opus/i.test(seg)) {
        const base = /4\.8/.test(seg) ? "claude-opus-4-8" : "opus";
        out.model = /1m/i.test(seg) ? `${base}[1m]` : base;
      } else {
        const fam = MODEL_FAMILIES.find(([re]) => re.test(seg));
        if (fam) out.model = fam[1];
      }
    }
  }
  return out;
}

/**
 * Read the live statusline + mode straight from the pane — the only faithful source
 * for the user's CUSTOM statusline (its true context-window %, branch, model) and the
 * current permission mode (auto/plan), neither of which is in any file. The statusline
 * is anchored by its token `X/Y (Z%)` fragment; the mode by its ⏵⏵/⏸ marker.
 */
export async function readPaneStatusline(paneId: string, capture?: string): Promise<PaneStatusline> {
  const cap = capture ?? (await capturePane(paneId));
  const tail = cap.split("\n").map((l) => l.trimEnd()).slice(-12);
  const res: PaneStatusline = {};
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = tail[i]!.trim();
    if (!res.mode && /(⏵⏵|⏸|⏵).*(mode|accept edits|permissions)/i.test(l)) {
      res.mode = l.replace(/\s*\(shift\+tab[^)]*\)/i, "").replace(/\s*·.*$/, "").trim();
    }
    if (!res.statusline && /\d[\d.]*k?\s*\/\s*\d[\d.]*k?\s*\(\d+%\)/i.test(l)) {
      res.statusline = l;
    }
  }
  if (res.statusline) Object.assign(res, parseStatusline(res.statusline));
  return res;
}

/** Outcome of a send; `reason` is set only on rejection (nothing was sent). */
export type SendResult = {
  ok: boolean;
  reason?: "no-pane" | "no-question" | "stale-question" | "not-presented" | "not-held" | "no-prompt" | "no-session" | "rewind-unavailable" | "rewind-mismatch" | "rewind-mode" | "bad-image" | "bad-selection" | "no-confirm" | "no-repo" | "no-transcript" | "resume-failed" | "not-found" | "shell-draft" | "shell-clear-failed" | "draft-stash-failed" | "clear-failed" | "notification-clear-failed";
  /** Fresh session id, set by createSession to the dictated id. */
  sessionId?: string;
};

/**
 * Launch a new Claude session in `repoPath` as a new tmux window (TUI parity with the
 * `n` wizard's simple case — current branch, no worktree). Rejects when no main tmux
 * session is resolvable (e.g. the bridge is running outside tmux).
 *
 * Mints the session id up front (`crypto.randomUUID()`) and dictates it via
 * `claude --session-id <uuid>`, returning it directly — no waiting on the SessionStart
 * hook. This is deterministic (the caller opens exactly this session) and sidesteps the
 * discovery heuristics that, during the boot window, can mis-map the not-yet-registered
 * pane to a recently-modified existing session (the mtime fallback in
 * enrichUnmatchedSessions). We still wait for the statusline to render so an instant
 * phone message doesn't drop into the boot window.
 */
// Claude Code's one-time "Is this a project you trust?" gate for an untrusted
// folder (`hasTrustDialogAccepted:false` in ~/.claude.json). It blocks boot and
// suppresses the SessionStart hook, so the pane→session id never registers and the
// launch silently hangs — most commonly for the `~` home dir. The caller explicitly
// chose this folder, so we accept it: option 1 ("Yes, I trust this folder") is the
// default cursor, so a single Enter confirms.
const TRUST_PROMPT = "Is this a project you created or one you trust";

export async function createSession(repoPath: string, name: string): Promise<SendResult> {
  const target = await getMainSession();
  if (!target) return { ok: false, reason: "no-session" };
  const sessionId = crypto.randomUUID();
  const paneId = await launchClaudeWindow(target, repoPath, name, sessionId);
  // We minted the id, so the pane→session map is known now — write it ourselves so a phone
  // send resolves the pane immediately, without waiting on the SessionStart hook's write.
  await savePaneSessions({ [paneId]: sessionId });
  await waitForPromptLive(paneId);
  return { ok: true, sessionId };
}

/**
 * Poll a freshly-launched pane until its statusline renders — the prompt is then live and
 * sendable, so an instant phone message doesn't drop into the boot window. Clears the
 * one-time "trust this folder?" gate once if it appears. ~12s cap; on timeout the session
 * is still launched (statusline just slow to render), so callers that minted the id
 * themselves return `ok` regardless. Used after `createSession`/`forkSession` write the
 * pane→session map, where registration is a given and only the prompt's readiness gates.
 */
async function waitForPromptLive(paneId: string): Promise<void> {
  let trusted = false;
  for (let i = 0; i < 24; i++) {
    await Bun.sleep(500); // up to ~12s for claude to boot and render its prompt
    if ((await readPaneStatusline(paneId)).statusline) return;
    if (!trusted && (await capturePane(paneId)).includes(TRUST_PROMPT)) {
      await sendKey(paneId, "Enter");
      trusted = true;
    }
  }
}

/**
 * Fork a session from the phone: mint a new id, launch `claude --session-id <forkId>
 * --resume=<sessionId> --fork-session` in a new (unfocused) tmux window, and BLOCK until
 * the fork's prompt is live so the phone can open straight into it. The fork copies the
 * parent's history up to the fork point and diverges from there; the parent is untouched.
 * `repoPath`/`baseRepoPath`/`name` come from the caller (server discovery), mirroring
 * `restoreSession`. Relocates to the base repo if the session's worktree was deleted so the
 * resume lands. Returns the NEW fork's id (never the parent's).
 */
export async function forkSession(
  sessionId: string,
  repoPath: string,
  baseRepoPath: string,
  name?: string,
): Promise<SendResult> {
  const target = await getMainSession();
  if (!target) return { ok: false, reason: "no-session" };
  // While a live parked job (kind:"bg") owns this session's pane, the conversation the
  // user sees — and means to fork — is the JOB's; this id's own transcript is frozen for
  // the duration. Fork from the job's session so the fork resumes the on-screen history.
  const sourceId = (await parkedJobSessions()).get(sessionId) ?? sessionId;
  if ((await resolveTranscriptPath(sourceId)) === null) return { ok: false, reason: "no-transcript" };
  const effectivePath = await recoverWorktreeTranscript(sourceId, repoPath, baseRepoPath);
  const repoName = effectivePath.split("/").filter(Boolean).pop() ?? "claude";
  const forkName = buildBaseName(repoName, name ? slugify(name) || undefined : undefined, true);
  const forkId = crypto.randomUUID();
  const paneId = await launchForkWindow(target, effectivePath, forkName, forkId, sourceId);
  // We minted forkId and passed it via --session-id, so the fork's transcript lands under it;
  // write the pane→session map ourselves (like createSession) rather than wait on the hook,
  // which for a --fork-session pane records the PARENT id instead.
  await savePaneSessions({ [paneId]: forkId });
  await waitForPromptLive(paneId);
  // Claude writes the fork's transcript LAZILY — nothing lands on disk until the fork's
  // first turn. Until then the phone can neither read the conversation (empty) nor even see
  // the session (discovery blanks a pane's id when no JSONL backs it — buildActiveSession).
  // So seed the fork's file with a copy of the parent's transcript NOW (after boot, before any
  // turn — Claude has not created the file yet). Claude then treats the existing file as the
  // session history and APPENDS the first turn to it (verified: no duplication), which is
  // exactly fork semantics. Best-effort: a failed seed just falls back to empty-until-first-turn.
  await seedForkTranscript(sourceId, forkId, effectivePath);
  return { ok: true, sessionId: forkId };
}

/**
 * Copy the parent session's transcript to the fork's transcript path so the fork is readable
 * and discoverable before it takes its first turn (see `forkSession`). The destination is the
 * project dir for the fork's cwd (`effectivePath`) — where Claude, launched there, will append
 * — keyed the same way Claude keys it (`/` → `-`). Never throws.
 */
async function seedForkTranscript(parentId: string, forkId: string, effectivePath: string): Promise<void> {
  try {
    const parentPath = await resolveTranscriptPath(parentId);
    if (!parentPath) return;
    const dest = `${homedir()}/.claude/projects/${effectivePath.replace(/\//g, "-")}/${forkId}.jsonl`;
    await Bun.write(dest, Bun.file(parentPath));
  } catch {
    // Parent transcript unreadable / dest dir missing — leave the fork empty-until-first-turn.
  }
}

/**
 * Whether — and where — an archived session can be resumed from the phone. "yes": its
 * original dir still exists, resume lands in place. "relocated": the original dir (a
 * worktree) is gone but the base repo survives — the restore route already relocates
 * there via recoverWorktreeTranscript, so the phone shows "restore in <repo>" instead
 * of hiding the button. "no": base repo gone too (or the transcript is), so there is
 * nowhere to resume; the thread stays readable. Cheap disk checks (one `stat` via
 * Bun.file — NOT `Bun.file().exists()`, which is false for directories). Never throws.
 */
export async function restoreState(
  sessionId: string,
  repoPath: string,
  baseRepoPath: string,
): Promise<RestoreState> {
  if ((await resolveTranscriptPath(sessionId)) === null) return "no";
  if (await isDirectory(repoPath)) return "yes";
  if (baseRepoPath && baseRepoPath !== repoPath && (await isDirectory(baseRepoPath))) return "relocated";
  return "no";
}

/** True iff `path` exists and is a directory. Bun-native stat, guarded (mirrors tailRecords). */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Bun.file(path).stat()).isDirectory();
  } catch {
    return false; // missing path / stat failure
  }
}

/**
 * Resume an archived session from the phone: launch `claude --resume=<id>` in its original
 * repo dir as a new tmux window and BLOCK until it's ready to drive. Registration (the
 * SessionStart hook writing paneId→sessionId) is the SUCCESS signal — a resume that never
 * registers within the cap failed (bad id / boot error) and returns `resume-failed` rather
 * than a false `ok`. Once registered, we keep polling until the pane's statusline renders
 * (prompt live / sendable) so a message the phone sends the instant it opens the session
 * lands instead of dropping into the boot window (verified: a send at registration-time,
 * before the prompt, is silently swallowed). `repoPath` comes from the caller (server
 * discovery), mirroring `createSession`.
 */
export async function restoreSession(sessionId: string, repoPath: string): Promise<SendResult> {
  if (!(await isDirectory(repoPath))) return { ok: false, reason: "no-repo" };
  if ((await resolveTranscriptPath(sessionId)) === null) return { ok: false, reason: "no-transcript" };
  const target = await getMainSession();
  if (!target) return { ok: false, reason: "no-session" };
  const name = repoPath.split("/").filter(Boolean).pop() ?? "claude";
  const paneId = await launchResumeWindow(target, repoPath, name, sessionId);

  let registered = false;
  let trusted = false;
  for (let i = 0; i < 24; i++) {
    await Bun.sleep(500); // up to ~12s for claude to boot, fire SessionStart, and reach the prompt
    if (!registered && (await loadPaneSessions())[paneId] === sessionId) registered = true;
    if (registered && (await readPaneStatusline(paneId)).statusline) return { ok: true, sessionId };
    // Clear the one-time "trust this folder?" gate. On RESUME (unlike a new session) the
    // SessionStart hook can fire — registering the pane — while the trust prompt is still up
    // and blocking the statusline/input, so this is NOT gated on `!registered`: check every
    // cycle until the statusline confirms the prompt is live. Option 1 ("Yes, I trust this
    // folder") is the default cursor → one Enter confirms.
    if (!trusted && (await capturePane(paneId)).includes(TRUST_PROMPT)) {
      await sendKey(paneId, "Enter");
      trusted = true;
    }
  }
  // Registered but the prompt never rendered in time → launched, just slow (small residual
  // send-drop risk, matches createSession). Never registered → the resume itself failed.
  return registered ? { ok: true, sessionId } : { ok: false, reason: "resume-failed" };
}

// --- Rewind: drive Claude's interactive /rewind picker via tmux --------------
// Claude exposes no rewind-by-message API; the picker is a two-stage Ink overlay.
// We drive it by KEYS but READ the screen at each step and abort (Esc) on any
// mismatch — never blind-pressing the destructive option. Calibrated live against
// claude 2.1.x: stage 1 lists user prompts oldest→newest with the cursor on
// "(current)"; `Up` walks toward older entries. Stage 2 is a numbered menu whose
// "Restore code …" options appear only when that checkpoint changed files.

const PICKER_DONE = "Enter to continue";
const PICKER_HEAD = "Restore the code and/or conversation";
const KEY_GAP = 250; // ms — the verified floor for Claude's TUI to register arrow keys

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** The selected entry's text within the picker block (the line carrying `❯`). */
export function pickerCursorText(screen: string): string | null {
  const start = screen.indexOf(PICKER_HEAD);
  if (start === -1) return null;
  for (const line of screen.slice(start).split("\n")) {
    const m = line.match(/^\s*❯\s+(.+?)\s*$/);
    if (m && !line.includes(PICKER_DONE)) return norm(m[1]!);
  }
  return null;
}

/** True when the cursor text (possibly truncated with …) is a prefix of expected. */
export function cursorMatches(cursorText: string, expected: string): boolean {
  const c = cursorText.replace(/[…]+$/, "").replace(/\.\.\.$/, "").trim();
  if (c.length < 3) return false;
  return norm(expected).startsWith(c.slice(0, Math.min(c.length, 40)));
}

/** Parse the stage-2 numbered menu into {num,label} entries. */
export function parseModeMenu(screen: string): Array<{ num: number; label: string }> {
  const out: Array<{ num: number; label: string }> = [];
  for (const line of screen.split("\n")) {
    const m = line.match(/^\s*❯?\s*(\d+)\.\s+(.+?)\s*$/);
    if (m) out.push({ num: Number(m[1]), label: norm(m[2]!) });
  }
  return out;
}

/** Down-presses from the default (option 1) to the requested restore mode, or -1. */
export function modeDowns(menu: Array<{ num: number; label: string }>, mode: "conversation" | "both"): number {
  const want = mode === "both" ? "Restore code and conversation" : "Restore conversation";
  const exact = menu.find((o) => o.label === want);
  if (exact) return exact.num - 1;
  // "both" requested but no code changed → "Restore conversation" is the equivalent action
  if (mode === "both") {
    const conv = menu.find((o) => o.label === "Restore conversation");
    if (conv) return conv.num - 1;
  }
  return -1;
}

async function captureAfter(paneId: string, ms: number): Promise<string> {
  await Bun.sleep(ms);
  return capturePane(paneId);
}

/**
 * Rewind a session to the point BEFORE a specific user message. `upCount` is how many
 * `Up` presses from "(current)" reach that checkpoint (the caller computes it from the
 * message's position); `expectedText` is that message's text, used to VERIFY the cursor
 * landed correctly before committing. `mode`: "conversation" (safe) or "both" (also
 * restores files — destructive). Aborts cleanly on any mismatch.
 */
export async function rewindSession(
  sessionId: string,
  upCount: number,
  expectedText: string,
  mode: "conversation" | "both",
): Promise<SendResult> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  return rewindByPane(paneId, upCount, expectedText, mode);
}

/** The pane-level rewind driver (no session resolution) — the testable seam. */
export async function rewindByPane(
  paneId: string,
  upCount: number,
  expectedText: string,
  mode: "conversation" | "both",
): Promise<SendResult> {
  if (!Number.isInteger(upCount) || upCount < 1 || upCount > 500) {
    return { ok: false, reason: "rewind-unavailable" };
  }

  // Open the picker: clear any input, type /rewind, submit.
  await sendKey(paneId, "C-u");
  await Bun.sleep(120);
  await sendLiteral(paneId, "/rewind");
  await Bun.sleep(KEY_GAP);
  await sendKey(paneId, "Enter");

  let screen = "";
  for (let i = 0; i < 16; i++) {
    screen = await captureAfter(paneId, 200);
    if (screen.includes(PICKER_DONE) && screen.includes(PICKER_HEAD)) break;
  }
  if (!screen.includes(PICKER_DONE)) {
    await sendKey(paneId, "Escape");
    return { ok: false, reason: "rewind-unavailable" }; // not at prompt / picker didn't open
  }

  // Stage 1: walk up to the target checkpoint, then VERIFY before selecting.
  for (let n = 0; n < upCount; n++) {
    await sendKey(paneId, "Up");
    await Bun.sleep(KEY_GAP);
  }
  screen = await capturePane(paneId);
  const cursor = pickerCursorText(screen);
  if (!cursor || !cursorMatches(cursor, expectedText)) {
    await sendKey(paneId, "Escape");
    return { ok: false, reason: "rewind-mismatch" };
  }
  await sendKey(paneId, "Enter");

  // Stage 2: pick the restore mode by reading the numbered menu.
  screen = await captureAfter(paneId, 400);
  const downs = modeDowns(parseModeMenu(screen), mode);
  if (downs < 0) {
    await sendKey(paneId, "Escape");
    return { ok: false, reason: "rewind-mode" };
  }
  for (let n = 0; n < downs; n++) {
    await sendKey(paneId, "Down");
    await Bun.sleep(KEY_GAP);
  }
  await sendKey(paneId, "Enter");
  await Bun.sleep(400);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Subagents — drill-in conversations for `Agent`/`Task` fan-out. Read-only over the
// `<sessionId>/subagents/` directory that sits beside the main transcript JSONL.
// The directory is the only 100%-coverage source: Workflow-/nested-spawned agents
// have no main-transcript chip, so we list from disk, never from the active branch.
// ---------------------------------------------------------------------------

/** The `subagents/` directory beside a session's transcript (`…/<id>.jsonl` → `…/<id>/subagents`). */
export function subagentsDir(transcriptPath: string): string {
  const base = transcriptPath.endsWith(".jsonl") ? transcriptPath.slice(0, -6) : transcriptPath;
  return `${base}/subagents`;
}

// agentIds are hex filename stems today; the charset rejects `/`,`.`,`_` so a decoded
// path segment can never traverse out of the subagents dir (the only `_`-bearing files,
// `aside_question-*`, have no meta and are never listed).
const AGENT_ID_RE = /^[a-z0-9-]+$/;

/** Guard for a path-segment agentId — blocks traversal (`/`,`.`,`_`); see AGENT_ID_RE. */
export function isValidAgentId(agentId: string): boolean {
  return AGENT_ID_RE.test(agentId);
}

interface TailRecord {
  type?: string;
  message?: { content?: unknown };
}

const TAIL_START = 65536; // 64KB initial window
const TAIL_CAP = 4 * 1024 * 1024; // 4MB ceiling — final records reach ~99KB; this is slack

/**
 * Backward chunked tail-read of a JSONL file: parse the complete records at its END
 * without reading the whole thing. Starts at the last 64KB and doubles the window (up
 * to 4MB) until ≥1 complete record is recovered — a subagent's final record can reach
 * ~99KB, so a fixed window would truncate it and misclassify a done agent as running.
 * When we didn't read from byte 0 the first line is a partial record (dropped); a
 * half-written trailing line is skipped by the per-line try/parse. Returns [] on a
 * missing/unreadable file or when the final record exceeds the 4MB cap.
 */
async function tailRecords(path: string): Promise<TailRecord[]> {
  try {
    const file = Bun.file(path);
    const size = file.size;
    if (!size) return [];
    for (let window = TAIL_START; ; window *= 2) {
      const start = Math.max(0, size - window);
      const text = await file.slice(start, size).text();
      const lines = text.split("\n");
      if (start > 0) lines.shift(); // first line is a partial record — drop it
      const records: TailRecord[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line) as TailRecord);
        } catch {
          // torn trailing fragment (file mid-write) — skip
        }
      }
      if (records.length > 0 || start === 0 || window >= TAIL_CAP) return records;
    }
  } catch {
    return []; // missing/unreadable
  }
}

// A done agent's jsonl is terminal/immutable, so its (size, mtime) never changes again —
// cache that verdict to bound re-reads to still-running agents. `running` is never cached
// (the file is still growing).
const subagentDoneCache = new Map<string, { size: number; mtimeMs: number }>();

/**
 * A subagent's status from its OWN jsonl — `done` iff the last conversational record is an
 * `assistant` turn whose last content block is `text`; else `running`. Validated against
 * ≈680 agents (0 false positives): this rescues the 22% of done agents whose `stop_reason`
 * is `null`, while a running tail is always a `thinking`-only assistant turn or a
 * `tool_result` user record (a tool-calling turn ends in `tool_use`, never `[…text]`). A
 * killed agent that never wrote a terminal turn reads `running` (accepted in v1).
 */
export async function subagentStatus(jsonlPath: string): Promise<"done" | "running"> {
  let stat: { size: number; mtimeMs: number } | null;
  try {
    stat = await Bun.file(jsonlPath).stat();
  } catch {
    return "running"; // missing/unreadable → not yet terminal
  }
  if (!stat) return "running";
  const cached = subagentDoneCache.get(jsonlPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return "done";

  const records = await tailRecords(jsonlPath);
  let last: TailRecord | undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r && (r.type === "user" || r.type === "assistant")) {
      last = r;
      break;
    }
  }
  const content = last?.type === "assistant" ? last.message?.content : undefined;
  const blocks = Array.isArray(content) ? (content as Array<{ type?: string }>) : [];
  const done = blocks.length > 0 && blocks[blocks.length - 1]?.type === "text";
  if (done) subagentDoneCache.set(jsonlPath, { size: stat.size, mtimeMs: stat.mtimeMs });
  return done ? "done" : "running";
}

interface SubagentMeta {
  agentType?: unknown;
  description?: unknown;
  spawnDepth?: unknown;
}

/**
 * List a session's subagents from its `subagents/` directories: one entry per
 * `agent-<id>.meta.json`, with `status` read from the agent's own jsonl. A session that
 * moved project dirs (see `resolveTranscriptPaths`) has one such dir per transcript file
 * — agents spawned before the move live under the old dir — so pass every path and the
 * union is returned. Sorted by `(spawnDepth ?? 1, description)` for a stable order.
 * Never throws — a missing dir or unreadable meta yields [] / a skipped row.
 */
export async function listSubagents(transcriptPaths: string[]): Promise<SubagentSummary[]> {
  const out: SubagentSummary[] = [];
  for (const path of transcriptPaths) out.push(...(await listSubagentsIn(subagentsDir(path))));
  out.sort(
    (a, b) => (a.spawnDepth ?? 1) - (b.spawnDepth ?? 1) || a.description.localeCompare(b.description),
  );
  return out;
}

async function listSubagentsIn(dir: string): Promise<SubagentSummary[]> {
  const out: SubagentSummary[] = [];
  try {
    for await (const name of new Glob("agent-*.meta.json").scan({ cwd: dir })) {
      const agentId = name.slice("agent-".length, -".meta.json".length);
      if (!agentId) continue;
      let meta: SubagentMeta;
      try {
        meta = JSON.parse(await Bun.file(`${dir}/${name}`).text()) as SubagentMeta;
      } catch {
        continue; // corrupt/unreadable meta — skip this row
      }
      const jsonlPath = `${dir}/agent-${agentId}.jsonl`;
      const status = await subagentStatus(jsonlPath);
      const summary: SubagentSummary = {
        agentId,
        agentType: typeof meta.agentType === "string" ? meta.agentType : "agent",
        description: typeof meta.description === "string" ? meta.description : "",
        status,
      };
      if (typeof meta.spawnDepth === "number") summary.spawnDepth = meta.spawnDepth;
      if (status === "done") {
        // A done agent's jsonl is immutable, so its mtime IS the completion instant —
        // the phone groups "finished since your last prompt" vs older with it.
        try {
          const stat = await Bun.file(jsonlPath).stat();
          if (stat) summary.finishedAt = new Date(stat.mtimeMs).toISOString();
        } catch {}
      }
      out.push(summary);
    }
  } catch {
    return []; // missing dir / scan failure
  }
  return out;
}

// The opening user turn of a subagent is the (often huge) task brief; cap it so the
// drill-in payload stays small — the body (the agent's actual work) is what matters.
const OPENING_TURN_CAP = 2048;

export function capOpeningTurn(turns: TranscriptTurn[]): void {
  const first = turns[0];
  if (!first || first.role !== "user") return;
  first.content = first.content.map((b) =>
    b.type === "text" && b.text.length > OPENING_TURN_CAP
      ? { type: "text", text: `${b.text.slice(0, OPENING_TURN_CAP)}… (truncated)` }
      : b,
  );
}

/**
 * A subagent's full conversation for the drill-in view: `slimTurns(parseTranscript(...))`
 * over `subagents/agent-<agentId>.jsonl`. Linear parse (every subagent record is
 * `isSidechain`, so `parseActiveBranch` falls back to linear anyway). The agent's file
 * lives under whichever project dir was live when it spawned, so every transcript file's
 * dir is tried (newest first — the common case). Returns null on a bad agentId
 * (traversal guard), an unresolvable session, or a missing/unreadable file.
 */
export async function getSubagentTranscript(
  sessionId: string,
  agentId: string,
): Promise<SessionTranscript | null> {
  if (!isValidAgentId(agentId)) return null;
  const paths = await resolveTranscriptPaths(sessionId);
  for (let i = paths.length - 1; i >= 0; i--) {
    const agentPath = `${subagentsDir(paths[i]!)}/agent-${agentId}.jsonl`;
    const lines: string[] = [];
    try {
      for await (const line of jsonlLines(agentPath)) lines.push(line);
    } catch {
      continue; // not under this dir — try the next-older one
    }
    const turns = slimTurns(parseTranscript(lines));
    capOpeningTurn(turns);
    return { turns };
  }
  return null;
}

// The tool_use chip shows a one-line label plus, when tapped open, the other short
// string fields that describe the call. Ship only these, capped — never the full `input`
// (Write contents, Edit strings, Agent prompts), which is never rendered and is ~half
// the payload.
const TOOL_ARG_CAP = 200;
const TOOL_ARG_FIELDS = [
  "command",
  "file_path",
  "notebook_path",
  "pattern",
  "description",
  "subagent_type",
  "url",
  "query",
  "skill",
  "args",
] as const;
// A path is the chip's tap TARGET, not just its label — the client sends it straight back to
// `/diff`. A truncated one resolves to nothing and the diff view reports "no changes", which
// reads exactly like a reverted edit. Absolute worktree paths in a monorepo do reach the cap.
// Paths are tens of bytes; the cap exists to stop Write contents and long Bash command lines.
const UNCAPPED_FIELDS: ReadonlySet<string> = new Set(["file_path", "notebook_path"]);
const RESULT_HEAD_CAP = 120;

function slimToolUse(
  b: Extract<TranscriptBlock, { type: "tool_use" }>,
  result: ToolResultSummary | undefined,
): TranscriptBlock {
  const raw = (b.input ?? {}) as Record<string, unknown>;
  const input: Record<string, string> = {};
  for (const k of TOOL_ARG_FIELDS) {
    const v = raw[k];
    if (typeof v === "string" && v) {
      input[k] =
        UNCAPPED_FIELDS.has(k) || v.length <= TOOL_ARG_CAP ? v : v.slice(0, TOOL_ARG_CAP) + "…";
    }
  }
  const slim: TranscriptBlock = { type: "tool_use", id: b.id, name: b.name, input };
  if (result) slim.result = result;
  return slim;
}

/** The text of a tool_result's content: a string, or the text parts of a block array. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Outcome + capped first line + line count — what a chip can show of a tool's result. */
export function summarizeToolResult(b: Extract<TranscriptBlock, { type: "tool_result" }>): ToolResultSummary {
  const lines = toolResultText(b.content)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines[0] ?? "";
  return {
    ok: !b.is_error,
    head: first.length > RESULT_HEAD_CAP ? first.slice(0, RESULT_HEAD_CAP) + "…" : first,
    lines: lines.length,
  };
}

/**
 * Keep only what the bridge UI renders — text bubbles and tool_use chips — and shrink
 * each to its displayed form. `thinking` is hidden and `tool_result` content is
 * frequently enormous (file reads, command output); both are dropped, but each result is
 * first reduced to a summary attached to its tool_use (paired by id across turns — Claude
 * records results as the NEXT user turn). tool_use inputs are trimmed to the capped
 * string fields the chip shows. A turn left empty purely by stripping is dropped; a
 * genuinely empty turn is preserved (mirrors `parseTranscript`).
 */
export function slimTurns(turns: TranscriptTurn[]): TranscriptTurn[] {
  const results = new Map<string, ToolResultSummary>();
  for (const t of turns) {
    for (const b of t.content) {
      if (b.type === "tool_result" && b.tool_use_id) results.set(b.tool_use_id, summarizeToolResult(b));
    }
  }
  const out: TranscriptTurn[] = [];
  for (const t of turns) {
    const content: TranscriptBlock[] = [];
    for (const b of t.content) {
      if (b.type === "text" || b.type === "image") content.push(b);
      else if (b.type === "tool_use") content.push(slimToolUse(b, results.get(b.id)));
    }
    if (content.length === 0 && t.content.length > 0) continue;
    // Rebuild with only the fields the client uses — the per-turn flags must ride along
    // (the compact-summary divider, the queued/rewind-skip handling, and the command
    // and bash turns all key on them).
    const slim: TranscriptTurn = { role: t.role, content };
    if (t.at) slim.at = t.at;
    if (t.compactSummary) slim.compactSummary = true;
    if (t.queued) slim.queued = true;
    if (t.command) slim.command = t.command;
    if (t.bash) slim.bash = t.bash;
    if (t.teammate) slim.teammate = t.teammate;
    out.push(slim);
  }
  return out;
}

/**
 * Pure assembly of the transcript view from its already-read inputs (extracted as
 * the testable seam — the I/O path resolution uses `homedir()`, which tests can't
 * redirect). `openQuestion` is the pending tool's question when it is an
 * `AskUserQuestion`; otherwise only `pendingTool` is set.
 */
export function buildSessionTranscript(
  turns: TranscriptTurn[],
  pendingTool: PendingToolCall | null,
): SessionTranscript {
  const result: SessionTranscript = { turns };
  const lastAssistant = lastAssistantMessage(turns);
  if (lastAssistant !== undefined) result.lastAssistant = lastAssistant;
  Object.assign(result, pendingToolFields(pendingTool));
  return result;
}

/**
 * Shape a pending tool call into the transcript payload's pendingTool/openQuestion(s)
 * fields — shared by the full response (buildSessionTranscript) and the `?rev=`
 * unchanged fast path, which must keep shipping these: they come from the hook events
 * log and change while the transcript file doesn't.
 */
export function pendingToolFields(
  pendingTool: PendingToolCall | null,
): Pick<SessionTranscript, "pendingTool" | "openQuestion" | "openQuestions"> {
  const out: Pick<SessionTranscript, "pendingTool" | "openQuestion" | "openQuestions"> = {};
  if (pendingTool) out.pendingTool = pendingTool;
  if (pendingTool?.question) out.openQuestion = pendingTool.question;
  if (pendingTool?.questions) out.openQuestions = pendingTool.questions;
  return out;
}

/**
 * One revision string over EVERY file of a session's transcript (a cwd move re-homes the
 * JSONL, so one session can span several — see `resolveTranscriptPaths`). Only the live
 * (newest) file ever grows, so `count:totalSize:maxMtime` moves on any append, rewind, or
 * file flip; the count term covers the flip instant itself, when a brand-new file could
 * otherwise leave size+mtime looking unchanged.
 */
function combinedRev(stats: { size: number; mtimeMs: number }[]): string {
  let size = 0;
  let mtime = 0;
  for (const s of stats) {
    size += s.size;
    if (s.mtimeMs > mtime) mtime = s.mtimeMs;
  }
  return `${stats.length}:${size}:${mtime}`;
}

/**
 * Stat each path, dropping the ones that vanished between the glob and the stat
 * (retention cleanup of an old project dir). Order is preserved — oldest→newest in,
 * oldest→newest out — so the live file stays last.
 */
async function statSurvivors(
  paths: string[],
): Promise<{ path: string; stat: { size: number; mtimeMs: number } }[]> {
  const stats = await Promise.all(paths.map((p) => Bun.file(p).stat().catch(() => null)));
  return paths.flatMap((path, i) => {
    const stat = stats[i];
    return stat ? [{ path, stat }] : [];
  });
}

/**
 * The transcript's current disk revision (matching the `rev` a full response carries),
 * or null when no transcript exists. The `/transcript?rev=` fast path compares this
 * against the client's held rev — one memoized path lookup + one stat per file.
 */
export async function transcriptRevAt(
  sessionId: string,
): Promise<{ paths: string[]; rev: string } | null> {
  const files = await statSurvivors(await resolveTranscriptPaths(sessionId));
  if (files.length === 0) return null;
  return { paths: files.map((f) => f.path), rev: combinedRev(files.map((f) => f.stat)) };
}

/**
 * Replay a transcript's `queue-operation` records into the messages still queued at EOF.
 * These are op-log lines, not tree nodes (no `uuid`), so this cannot be derived from the
 * active-branch turns — it mirrors `parseBackgroundTasks`'s linear scan instead. Observed
 * ops (validated against real history): `enqueue` carries the text, `dequeue` carries
 * null (a FIFO shift), `remove` carries the text of the entry Claude consumed mid-turn,
 * `popAll` drains everything (one record per drained entry — clearing is idempotent).
 * Task-notification payloads ride the same queue and must be replayed (a dequeue shifts
 * whatever is at the head) but are filtered from the returned survivors — they are
 * harness plumbing, not something the phone should show as a queued message.
 *
 * The op log is NOT self-contained: `dequeue` carries null, so when the queue holds more
 * than one entry the replay cannot know which one Claude actually took (observed in real
 * history: enqueue A, enqueue B, dequeue, then `remove A` — proving the dequeue consumed
 * B, not the head). One such mismatch desyncs the model permanently and a long-delivered
 * message survives as a phantom "queued" bubble. So each survivor is reconciled against
 * delivery evidence: if its text later appears as a real conversational record (`user`
 * turn at turn-end, or `queued_command` attachment mid-turn), it was consumed — drop it.
 * A genuinely queued message has landed nowhere yet, so it always survives this check.
 */
export function parseQueuedPending(jsonl: string | string[]): string[] {
  const lines = typeof jsonl === "string" ? jsonl.split("\n") : jsonl;
  const queue: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('"queue-operation"')) continue;
    let rec: { type?: string; operation?: string; content?: unknown };
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // torn/partial line
    }
    if (rec.type !== "queue-operation") continue;
    switch (rec.operation) {
      case "enqueue":
        if (typeof rec.content === "string") queue.push({ line: i, text: rec.content });
        break;
      case "dequeue":
        queue.shift();
        break;
      case "remove": {
        const i2 = queue.findIndex((e) => e.text === rec.content);
        if (i2 >= 0) queue.splice(i2, 1);
        break;
      }
      case "popAll":
        queue.length = 0;
        break;
    }
  }
  return queue
    .filter(({ text }) => !text.trimStart().startsWith("<task-notification>"))
    // Teams deliveries are enqueued by the harness, not the user — never render them
    // as the user's queued message (delivery makes them a teammate turn instead).
    .filter(({ text }) => !TEAMMATE_PREFIX.test(text))
    .filter(({ line, text }) => !deliveredAfter(lines, line, text))
    .map(({ text }) => text);
}

/**
 * Did the enqueued text land as a real record after its enqueue line? Fast substring
 * check with the JSON-escaped text first; only matching lines are parsed, and only
 * conversational carriers count — a later queue-operation on identical re-sent text
 * (or the torn tail of one) is not delivery.
 */
function deliveredAfter(lines: string[], afterLine: number, text: string): boolean {
  const needle = JSON.stringify(text).slice(1, -1);
  for (let i = afterLine + 1; i < lines.length; i++) {
    if (!lines[i].includes(needle)) continue;
    try {
      const rec = JSON.parse(lines[i]) as { type?: string };
      if (rec.type === "user" || rec.type === "attachment") return true;
    } catch {
      // torn/partial line
    }
  }
  return false;
}

// Per-session cache of the parsed active branch, keyed by the joined file paths and
// validated by every file's size+mtime. Any change — append OR rewind (which still
// appends a new branch), or a cwd move opening a new file — grows a file, bumps an
// mtime, or changes the path set, so an unchanged stat vector means unchanged content:
// re-use the parse instead of re-reading and re-parsing multi-MB logs on every refresh.
const branchCache = new Map<
  string,
  {
    statKey: string;
    rev: string;
    turns: TranscriptTurn[];
    backgroundTasks: BackgroundTask[];
    queuedPending: string[];
    usage: ContextUsage | null;
  }
>();

interface BranchRead {
  turns: TranscriptTurn[];
  pendingScripts: BackgroundTask[];
  queuedPending: string[];
  usage: ContextUsage | null;
  rev: string | null;
}

// Fresh object per call — callers hold and slim these arrays, so no shared singleton.
function emptyBranch(): BranchRead {
  return { turns: [], pendingScripts: [], queuedPending: [], usage: null, rev: null };
}

/**
 * Read + parse a session's transcript across EVERY file it spans (oldest→newest —
 * a cwd move re-homes the JSONL to another project dir, chaining `parentUuid` across
 * files; see `resolveTranscriptPaths`). One merged line array feeds all four parsers:
 * the branch walk needs the cross-file uuid index, and the linear parsers (queue replay,
 * background tasks, usage) see the records in true write order because only the newest
 * file was ever appended to. Frozen older files are re-streamed when the live file
 * changes — bounded by what a single large live file already costs.
 */
async function readActiveBranchCached(allPaths: string[]): Promise<BranchRead> {
  try {
    // An older (frozen) file can vanish between the glob and the stat — retention
    // cleanup, a deleted project dir. Read the survivors rather than blanking the
    // whole session; the 3s resolve TTL heals the path list right after.
    const files = await statSurvivors(allPaths);
    if (files.length === 0) return emptyBranch();
    const statKey = files.map((f) => `${f.path}:${f.stat.size}:${f.stat.mtimeMs}`).join(";");
    const cacheKey = files.map((f) => f.path).join(";");
    const hit = branchCache.get(cacheKey);
    // pendingScripts is derived per READ, not cached: the runner-liveness probe must
    // keep running while the files — and thus the cache entry — sit still, or a wait
    // whose runner died would stay visible until the transcript next changes.
    if (hit && hit.statKey === statKey)
      return {
        turns: hit.turns,
        pendingScripts: await liveScripts(hit.backgroundTasks),
        queuedPending: hit.queuedPending,
        usage: hit.usage,
        rev: hit.rev,
      };
    // One streamed pass builds the line array all four parsers share: no contiguous
    // multi-MB string, and no re-splitting per parser (each split re-copies every line —
    // on macOS the freed copies ratchet the process RSS permanently).
    const lines: string[] = [];
    for (const f of files) for await (const line of jsonlLines(f.path)) lines.push(line);
    const entry = {
      statKey,
      rev: combinedRev(files.map((f) => f.stat)),
      turns: parseActiveBranch(lines),
      // Piggybacked on the same read: background tasks, the queued-message replay, and
      // context usage change only when the files do (all are transcript records), so
      // one cache covers all of them.
      backgroundTasks: parseBackgroundTasks(lines),
      queuedPending: parseQueuedPending(lines),
      usage: contextUsageFromLines(lines),
    };
    branchCache.set(cacheKey, entry);
    return {
      turns: entry.turns,
      pendingScripts: await liveScripts(entry.backgroundTasks),
      queuedPending: entry.queuedPending,
      usage: entry.usage,
      rev: entry.rev,
    };
  } catch {
    return emptyBranch(); // missing/unreadable transcript
  }
}

/**
 * Aggregate a live session's transcript view: ordered turns + last assistant text +
 * the pending tool/question (sourced from the hook log, A3 — pending interactions
 * are not in the transcript before they resolve).
 */
export async function getTranscript(sessionId: string): Promise<SessionTranscript> {
  const paths = await resolveTranscriptPaths(sessionId);
  // Reconstruct the ACTIVE conversation branch (see `parseActiveBranch`): the JSONL is a
  // tree, and a rewind/edit can SHRINK the logical conversation, so an append-only
  // byte-delta would leak abandoned-branch turns. We read every file the session spans
  // and rebuild the leaf→root path each time, always returning a full replacement (no
  // cursor). The full re-parse is gated behind a per-file size+mtime cache (any change
  // grows the live file), so an idle session re-uses the prior parse instead of
  // re-reading multi-MB logs every refresh. Subagent listing and the last-prompt
  // boundary only need the paths — overlap them with the branch read.
  const [branch, subagents, lastPromptAt] = await Promise.all([
    readActiveBranchCached(paths),
    listSubagents(paths),
    lastPromptAtAcross(paths),
  ]);
  const result = buildSessionTranscript(slimTurns(branch.turns), pendingToolCall(sessionId));
  if (branch.pendingScripts.length > 0) result.pendingScripts = branch.pendingScripts;
  if (branch.queuedPending.length > 0) result.queuedPending = branch.queuedPending;
  if (branch.rev) result.rev = branch.rev;
  // Usage rides the same cached read — no separate tail read of the file.
  if (branch.usage) result.usage = branch.usage;
  // Omitted entirely when the session fanned out to no subagents.
  if (subagents.length > 0) result.subagents = subagents;
  if (lastPromptAt !== null) result.lastPromptAt = new Date(lastPromptAt).toISOString();
  return result;
}

/**
 * The newest real prompt across the session's files: almost always in the live (last)
 * file; older files are only consulted when the live one holds no prompt yet — i.e.
 * right after a cwd move, before the user types again in the new file.
 */
async function lastPromptAtAcross(paths: string[]): Promise<number | null> {
  for (let i = paths.length - 1; i >= 0; i--) {
    const at = await readLastPromptAt(paths[i]!);
    if (at !== null) return at;
  }
  return null;
}

/**
 * Context-window usage, mirroring the user's Mac statusline: input +
 * cache_creation + cache_read from the LAST assistant message's `usage` (the full
 * context resent each turn), over the window size. The size isn't recorded in the
 * transcript — default to 200k, inferring the 1M beta when usage exceeds 200k.
 * Tail-reads the JSONL (last 64KB) so it stays cheap on multi-MB logs.
 */
export async function readContextUsage(transcriptPath: string): Promise<ContextUsage | null> {
  try {
    const file = Bun.file(transcriptPath);
    const bytes = file.size;
    if (!bytes) return null;
    const text = await file.slice(Math.max(0, bytes - 65536)).text();
    return contextUsageFromLines(text.split("\n"));
  } catch {
    // missing/unreadable transcript — no usage
  }
  return null;
}

/** Newest `usage` record among `lines`, scanned back-to-front (the newest is last). */
function contextUsageFromLines(lines: string[]): ContextUsage | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.includes('"usage"')) continue;
    let u: Record<string, unknown> | undefined;
    try {
      u = (JSON.parse(line) as { message?: { usage?: Record<string, unknown> } })?.message?.usage;
    } catch {
      continue; // partial line at the chunk's leading edge — skip it
    }
    if (u && typeof u.input_tokens === "number") {
      const tokens =
        (u.input_tokens as number) +
        ((u.cache_creation_input_tokens as number) || 0) +
        ((u.cache_read_input_tokens as number) || 0);
      const size = tokens > 200_000 ? 1_000_000 : 200_000;
      return { tokens, size, percent: Math.round((tokens * 100) / size) };
    }
  }
  return null;
}

/**
 * Among live panes mapping to `sessionId`, return the LAST matching entry in
 * `paneMap` iteration order (last-written wins — handles resume-into-a-new-pane
 * before the stale entry is evicted); null if none. A plain object walk on purpose:
 * tmux paneIds are `%`-prefixed, so `JSON.parse` preserves insertion order.
 */
export function pickPane(
  sessionId: string,
  paneMap: Record<string, string>,
  livePaneIds: Set<string>,
): string | null {
  let pick: string | null = null;
  for (const [paneId, sid] of Object.entries(paneMap)) {
    if (sid === sessionId && livePaneIds.has(paneId)) pick = paneId;
  }
  return pick;
}

/**
 * Pure command-line fallback for pane resolution (testable). Matches the live
 * `claude --resume <id>` process whose id equals `sessionId`, maps its TTY to a pane,
 * and returns that pane — UNLESS the hook map already assigns that pane to a DIFFERENT
 * session. That guard is the stale-id defense: after a /clear the process command line
 * still carries the launch id, so without it we'd mis-resolve the old id onto a live pane
 * that now hosts a new conversation. `--fork-session` is already excluded upstream by
 * `sessionIdFromCommand` (its `sessionId` is undefined), so a fork can't match here.
 */
export function paneFromCommandLine(
  sessionId: string,
  procs: Array<{ sessionId?: string; tty: string }>,
  panes: Array<{ paneId: string; tty: string }>,
  paneMap: Record<string, string>,
): string | null {
  const norm = (tty: string) => tty.replace(/^\/dev\//, ""); // ps: "ttys013"; tmux: "/dev/ttys013"
  const proc = procs.find((p) => p.sessionId === sessionId);
  if (!proc) return null;
  const pane = panes.find((p) => norm(p.tty) === norm(proc.tty));
  if (!pane) return null;
  if (paneMap[pane.paneId] && paneMap[pane.paneId] !== sessionId) return null; // stale-id guard
  return pane.paneId;
}

/**
 * Resolve a session's live tmux pane. Primary source is the SessionStart-hook map
 * (per-pane files under `panes/`), reverse-looked-up against live panes. Fallback is the live
 * `claude --resume <id>` process command line — the SAME authoritative path
 * `discoverSessions` uses — for sessions the hook never recorded (e.g. resumed before
 * `claude0 setup`, or whose hook event was consumed without persisting). Without the
 * fallback, such a session shows in the list (discovery resolves it) but the bridge's
 * statusline scrape / mark-read / send can't find its pane. Hook map wins, and the
 * fallback is guarded against stale launch ids (see `paneFromCommandLine`).
 */
export async function resolveSessionPane(sessionId: string): Promise<string | null> {
  const [paneMap, panes] = await Promise.all([loadPaneSessions(), listPanes()]);
  const livePaneIds = new Set(panes.map((p) => p.paneId));
  const fromHook = pickPane(sessionId, paneMap, livePaneIds);
  if (fromHook) return fromHook;

  const fromCommand = paneFromCommandLine(sessionId, await findClaudeProcesses(), panes, paneMap);
  if (fromCommand) return fromCommand;

  // A parked job (kind:"bg") renders into its PARENT's pane and never gets a pane of
  // its own — no hook fires for it and its process carries no --resume id. Resolve
  // through the parent so job-addressed actions (a held question's answer, sends
  // retiring against the job transcript) land on the pane actually showing them.
  for (const [parent, job] of await parkedJobSessions()) {
    if (job === sessionId && parent !== sessionId) {
      const parentPane = pickPane(parent, paneMap, livePaneIds);
      if (parentPane) return parentPane;
    }
  }
  return null;
}

/**
 * Archive a session from the phone: kill its live tmux pane (ending the Claude
 * process and closing the window), mirroring the TUI's `x` action. The conversation
 * JSONL is untouched, so the session stays resumable from the Mac (`claude -r`).
 *
 * Fails on no-pane (not silently idempotent): a session that shows as active but whose
 * pane can't be resolved is a discovery mismatch, not a done deal — swallowing it as
 * success made the row look archived while it kept reappearing. Surface it so the phone
 * flashes the failure instead of pretending it worked.
 */
export async function archiveSession(sessionId: string): Promise<SendResult> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  await killPane(paneId);
  return { ok: true };
}

/**
 * Interrupt a running turn by sending `Escape` to the pane — the TUI's own stop key
 * (also used by `rewindByPane`). Fails on no-pane (like `sendMessage`/`answerSessionQuestion`,
 * not idempotent like `archiveSession`): this is a send-keys-to-a-live-pane op.
 *
 * Note: an interrupt fires NO `Stop` hook, so the event-sourced status latches at
 * "running". Claude's native status file (`nativeStatus`, the primary source) de-latches
 * it to "ready" ~1.5s later; the bridge's `/interrupt` route pushes that flip via SSE.
 */
export async function interruptSession(sessionId: string): Promise<SendResult> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  await sendKey(paneId, "Escape");
  return { ok: true };
}

/**
 * Clear the pane's input box — called by the phone after a confirmed interrupt-revert.
 * A pre-stream interrupt on an empty input makes Claude Code move the prompt text back
 * into its own input box (ADR 9). Once the phone composer has restored that text, the
 * copy left in the pane is a trap: an occupied input flips every FUTURE pre-stream
 * interrupt from revert to keep, and feeds the next send's draft guard a phantom draft.
 * Killed, not erased — the text lands in Claude's kill-ring, so C-y at the Mac still
 * recovers it. Fails on no-pane like the other send-keys ops.
 */
export async function clearPaneInput(sessionId: string): Promise<SendResult> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  return (await killInput(paneId)) ? { ok: true } : { ok: false, reason: "clear-failed" };
}

/** True when an AskUserQuestion is open (vs. a permission prompt or no pending tool). */
export function hasOpenQuestion(pending: PendingToolCall | null): boolean {
  return pending?.name === "AskUserQuestion" && !!pending.question;
}

/** One keystroke action in a composed message — image paste, caption text, or submit. */
export type MessageStep =
  | { kind: "paste"; text: string } // bracketed-paste an image path → becomes [Image #N]
  | { kind: "literal"; text: string } // type caption text literally
  | { kind: "enter" }; // submit

/**
 * Pure builder for the keystroke sequence of a message (extracted for testability,
 * mirroring `questionAnswerKeys`). Images are pasted FIRST — each becomes its own
 * `[Image #N]` in the prompt — then the caption (with a leading space to separate it from
 * the trailing marker), then a single terminal Enter to submit. Empty caption / no images
 * are both fine: text-only → `[literal, enter]`; image-only → `[paste…, enter]`.
 */
export function composeMessageSteps(text: string, imagePaths: string[] = []): MessageStep[] {
  const steps: MessageStep[] = imagePaths.map((p) => ({ kind: "paste", text: p }));
  const caption = text.trim() ? (imagePaths.length > 0 ? ` ${text}` : text) : "";
  if (caption) steps.push({ kind: "literal", text: caption });
  steps.push({ kind: "enter" });
  return steps;
}

/** One step in the full send plan — the message steps plus the draft stash/restore guard. */
export type SendStep =
  | { kind: "stash" } // cut a Mac-side draft into Claude's kill-ring (killInput) before sending
  | { kind: "text"; text: string } // text-only: the proven coalescing-safe literal+Enter
  | { kind: "paste"; text: string } // bracketed-paste an image path → [Image #N]
  | { kind: "literal"; text: string } // type caption text literally
  | { kind: "submit" } // verify-retry Enter after image paste(s)
  | { kind: "restore" }; // after the prompt clears, paste the stashed draft back (C-y)

/**
 * Pure builder for the complete tmux interaction of a send (extracted for testability,
 * mirroring `composeMessageSteps` / `questionAnswerKeys`). This is where the keystroke
 * ORDER and the draft-guard GATING live — the part worth locking down — leaving
 * `runSendStep` a thin map from step → tmux call.
 *
 * Body: text-only stays the single coalescing-safe `text` step (NOT the image submit-loop,
 * whose paste-ingestion retry is unnecessary for plain text and would change proven
 * behavior). With images, `composeMessageSteps`' paste/literal steps pass through and its
 * terminal `enter` becomes the verify-retry `submit`.
 *
 * Draft guard: the Mac may be attached with a half-typed draft in the prompt. A bare send
 * types our message onto the END of that draft and submits BOTH as one turn. So when a
 * draft is present we wrap the body in `stash` (kill the whole draft into Claude's
 * kill-ring — see `killInput`) … `restore` (once our message clears the prompt, yank it
 * back with C-y) —
 * leaving it waiting, unsubmitted, for when the user returns to the Mac. Gated on a real
 * draft so we never yank stale kill-ring content into an otherwise-empty prompt.
 */
export function buildSendPlan(
  text: string,
  imagePaths: string[],
  hadDraft: boolean,
): SendStep[] {
  const body: SendStep[] =
    imagePaths.length === 0
      ? [{ kind: "text", text }]
      : composeMessageSteps(text, imagePaths).map((s): SendStep =>
          s.kind === "enter" ? { kind: "submit" } : s,
        );
  return [
    ...(hadDraft ? [{ kind: "stash" } as const] : []),
    ...body,
    ...(hadDraft ? [{ kind: "restore" } as const] : []),
  ];
}

/**
 * Kill the pane's ENTIRE input into Claude's kill-ring, from any cursor position.
 * Claude's input editor is display-row scoped: one C-u kills only from the cursor to the
 * start of its row, and repeated C-u walks upward — rows BELOW the cursor and wrapped
 * continuation rows survive a single C-u. A reverted prompt (see `clearPaneInput`) leaves
 * the cursor mid-text, which is how sends used to splice the message into leftover draft
 * rows. So: walk to the bottom first — Down is history-next, a no-op at the newest entry
 * (Up must NEVER be sent here: at the top row it RECALLS history and replaces the input)
 * — then C-e to the row end, then kill row by row until the input reads empty.
 * Consecutive kills accumulate into ONE kill-ring chain, so a later single C-y restores
 * the whole draft, newlines included — but ANY motion (or typing) between kills RESETS
 * the chain (verified: the earlier chunk drops out of the yank). Hence the strict shape
 * here: all motions first, then only kills — never retry with a second walk. The Downs
 * are gapped (100ms — the input editor registered arrows reliably at 60-80ms in the same
 * lab; the picker's 250ms KEY_GAP floor is a different widget) so a dropped Down can't
 * strand rows below the cursor. Returns whether the input actually read empty; callers
 * fail loud on false — proceeding would splice the message into the remnant.
 * All verified against a live pane (ADR 9).
 */
async function killInput(paneId: string): Promise<boolean> {
  for (let i = 0; i < 12; i++) {
    await sendKey(paneId, "Down");
    await Bun.sleep(100);
  }
  await sendKey(paneId, "C-e");
  await Bun.sleep(KEY_GAP);
  for (let i = 0; i < 12 && inputPending(await captureTyped(paneId)); i++) {
    await sendKey(paneId, "C-u");
    await Bun.sleep(KEY_GAP);
  }
  return !inputPending(await captureTyped(paneId));
}

/**
 * Execute one `SendStep` against the pane — the thin, effectful tmux wrapper.
 * Returns false to ABORT the remaining steps (only `stash` does, when the draft
 * wouldn't fully clear — typing into the remnant would splice the message into it).
 */
async function runSendStep(paneId: string, step: SendStep): Promise<boolean> {
  switch (step.kind) {
    case "stash":
      // Whole draft into the kill-ring; C-y (restore) yanks it back.
      return killInput(paneId);
    case "text":
      await sendTextAndEnter(paneId, step.text);
      return true;
    case "paste":
      await sendBracketedPaste(paneId, step.text);
      await Bun.sleep(KEY_GAP);
      return true;
    case "literal":
      await sendLiteral(paneId, step.text);
      await Bun.sleep(KEY_GAP);
      return true;
    case "submit":
      // The Enter after an image paste is dropped if the TUI is still ingesting the pasted
      // image (base64-embedded at paste time) — reliably so on a session's first message
      // right after boot. Settle, press Enter, confirm the input cleared; resend if pending.
      await Bun.sleep(KEY_GAP);
      for (let i = 0; i < 4; i++) {
        await sendKey(paneId, "Enter");
        await Bun.sleep(450);
        if (!inputPending(await captureTyped(paneId))) break;
      }
      return true;
    case "restore":
      // Yank ONLY after our message clears the prompt — a premature C-y would paste the
      // draft into the not-yet-submitted input and ride along with our message.
      for (let i = 0; i < 8; i++) {
        if (!inputPending(await captureTyped(paneId))) break;
        await Bun.sleep(KEY_GAP);
      }
      await sendKey(paneId, "C-y"); // Claude's yank: re-adds the draft cut by the stash kills
      return true;
  }
}

/**
 * Send a message (optional images + optional text) to a session's pane — TUI parity: the
 * TUI sends keys unconditionally, so the bridge does too (Claude Code queues input while
 * running, accepts it at the prompt). The ONLY gate is a live pane. Blocked-on-question/
 * permission states are steered to the structured answer/approval UI client-side.
 *
 * Thin executor over `buildSendPlan` (where the ordering + draft-guard logic is tested):
 * resolve the pane, snapshot whether a draft is present, then run each planned step.
 */
export async function sendMessage(
  sessionId: string,
  text: string,
  imagePaths: string[] = [],
): Promise<SendResult> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  // Notification rows eat every key below — dismiss them before any input choreography.
  if (!(await clearNotificationRows(paneId))) return { ok: false, reason: "notification-clear-failed" };
  // One styled capture, two views: shell detection needs the dim "! for shell mode"
  // hint kept; draft detection needs dim ghost text dropped (see flattenStyled).
  let styled = await capturePane(paneId, { escapes: true });
  // Shell-mode guard, BEFORE the `❯` draft guard (mutually exclusive prompts — shell mode
  // has no live `❯` line, so killInput can neither see nor clear it). The case this
  // catches: after a QUEUED `!cmd` executes, the pane's prompt STAYS in shell mode, and a
  // plain send typed into it would execute as bash.
  const shell = shellModeInput(flattenStyled(styled, false));
  if (shell) {
    // Text on the shell prompt is a Mac-side command mid-composition. The kill-ring
    // choreography is unverified in shell mode and its failure mode is silent draft
    // loss — abort loudly and leave the draft untouched.
    if (shell.text) return { ok: false, reason: "shell-draft" };
    // Empty shell prompt: Backspace exits shell mode (lab-verified). Require the shell
    // prompt to actually be gone before typing — never send into an unknown state.
    await sendKey(paneId, "BSpace");
    await Bun.sleep(KEY_GAP);
    styled = await capturePane(paneId, { escapes: true });
    if (shellModeInput(flattenStyled(styled, false))) return { ok: false, reason: "shell-clear-failed" };
  }
  const hadDraft = inputPending(flattenStyled(styled, true));
  for (const step of buildSendPlan(text, imagePaths, hadDraft)) {
    // A failed stash aborts BEFORE the message is typed: proceeding would splice it into
    // the remnant draft and submit both as one turn. The phone surfaces the failure and
    // the partially-killed draft stays recoverable at the Mac (C-y).
    if (!(await runSendStep(paneId, step))) return { ok: false, reason: "draft-stash-failed" };
  }
  return { ok: true };
}

/**
 * Pull Claude's `Set model to …` / `Set effort level to …` confirmation out of a pane
 * capture, JOINING wrapped continuation lines first (a long confirmation wraps on a narrow
 * pane — see the width caveat in tmux.ts — and would otherwise truncate the toast). A
 * continuation is an indented, non-empty line that doesn't open a new block (`⎿`/`❯`) or a
 * glyph/status line. Returns the whitespace-collapsed sentence, or null if none is present.
 */
export function extractConfirmation(capture: string): string | null {
  const lines = capture.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/Set (?:model|effort level) to .+/);
    if (!m) continue;
    let text = m[0]!;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (!next.trim()) break; // blank line ends the block
      if (/^\s*[❯⎿│•·>]/.test(next)) break; // new block / statusline / hint glyph
      if (!/^\s{2,}/.test(next)) break; // continuations stay indented under the ⎿
      text += " " + next.trim();
    }
    return text.replace(/\s+/g, " ").trim();
  }
  return null;
}

/**
 * Switch a live session's model or reasoning effort from the phone. Sends the arg-form
 * slash command (`/model <x>`, `/effort <x>`) through the same draft-safe send path as
 * `sendMessage`, then POLLS the pane for Claude's confirmation line (variable latency,
 * mirroring `rewindByPane`) and returns it verbatim for the caller to surface. Scope is
 * Claude's to decide — global default for model + normal effort, session-only for
 * `ultracode` — so we report its exact wording rather than asserting a scope ourselves.
 * Callers validate `value` against MODEL_ARGS/EFFORT_ARGS before calling.
 */
export async function setSessionModelEffort(
  sessionId: string,
  kind: "model" | "effort",
  value: string,
): Promise<SendResult & { line?: string }> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  // Same key-eating hazard as sendMessage: a visible notification row swallows the send.
  if (!(await clearNotificationRows(paneId))) return { ok: false, reason: "notification-clear-failed" };
  const hadDraft = inputPending(await captureTyped(paneId));
  for (const step of buildSendPlan(`/${kind} ${value}`, [], hadDraft)) {
    // Same abort-on-failed-stash as sendMessage: never type into a remnant draft.
    if (!(await runSendStep(paneId, step))) return { ok: false, reason: "draft-stash-failed" };
  }
  for (let i = 0; i < 12; i++) {
    const line = extractConfirmation(await captureAfter(paneId, 200));
    if (line) return { ok: true, line };
  }
  return { ok: false, reason: "no-confirm" };
}

/**
 * Whether the pane's prompt still holds unsubmitted input — used to confirm an image
 * message actually submitted. The live input is the LAST `❯` line in the capture; any
 * non-whitespace after the glyph means the Enter hasn't landed yet. (Submitted messages
 * also echo as `❯ …` lines higher up, hence "last".)
 *
 * While a message sits in Claude's input queue the empty prompt renders a placeholder
 * ("Press up to edit queued messages") — hint text, not a draft. Reading it as a draft
 * made every send after a queued one wrap in stash/restore, and the restore C-y yanked
 * whatever the kill-ring last held into the prompt. If a future Claude release rewords
 * the placeholder, the exact-match miss just restores the old (false-draft) behavior.
 */
const QUEUED_PLACEHOLDER = "Press up to edit queued messages";

/**
 * Flatten a styled (`escapes: true`) pane capture to text, optionally dropping every
 * DIM (SGR 2) span. Claude Code renders ghost text dim inside the EMPTY input box —
 * placeholder hints, and a held/queued message shown verbatim where the old
 * "Press up to edit queued messages" placeholder used to be (lab capture:
 * `❯ ESC[2mcommit that batchESC[0m` with the box genuinely empty — typing replaced
 * it, backspace brought it back). A plain capture flattens that into something
 * indistinguishable from a real draft, which made `killInput` "fail" to clear an
 * already-empty box and every send abort with draft-stash-failed. Real typed input
 * never renders dim, so dim-vs-not is the discriminator. Dim state carries across
 * newlines (a wrapped span doesn't re-emit its SGR on the continuation row).
 */
export function flattenStyled(styled: string, dropDim: boolean): string {
  let out = "";
  let dim = false;
  for (let i = 0; i < styled.length; i++) {
    const ch = styled[i]!;
    if (ch === "\x1b") {
      const rest = styled.slice(i);
      const sgr = rest.match(/^\x1b\[([0-9;]*)m/);
      if (sgr) {
        const params = sgr[1]!.split(";");
        for (let j = 0; j < params.length; j++) {
          const p = params[j]!;
          if (p === "" || p === "0") dim = false;
          else if (p === "2") dim = true;
          else if (p === "22") dim = false; // "normal intensity" — ends dim without a full reset
          // Extended color: 38/48 consume sub-params (5;n or 2;r;g;b). Without
          // skipping them, the "2" in a truecolor sequence reads as SGR dim.
          else if (p === "38" || p === "48") j += params[j + 1] === "2" ? 4 : params[j + 1] === "5" ? 2 : 0;
        }
        i += sgr[0].length - 1;
        continue;
      }
      // OSC (hyperlinks etc.), then any other CSI/short escape — skip whole sequence.
      const other = rest.match(/^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/) ?? rest.match(/^\x1b\[[0-9;?]*[A-Za-z]/) ?? rest.match(/^\x1b./);
      if (other) i += other[0].length - 1;
      continue;
    }
    if (ch === "\n" || !dropDim || !dim) out += ch;
  }
  return out;
}

/** The pane's typed-input view: styled capture with ghost (dim) text dropped. */
async function captureTyped(paneId: string): Promise<string> {
  return flattenStyled(await capturePane(paneId, { escapes: true }), true);
}

/**
 * Claude Code renders background-task notification rows BELOW the statusline —
 * `❯ ⧉  <task-name> · Enter to open · x to dismiss` — the one place a `❯` line sits
 * UNDER the live input. It's colored (not dim), so the ghost-text drop keeps it, and
 * reading it as a draft made killInput "fail" forever and every send abort with
 * draft-stash-failed. Worse, while a row is visible it CAPTURES plain keystrokes —
 * lab-verified: `x` dismissed the row without touching a draft in the input box, and
 * a dozen C-u kill attempts left the draft intact — so any send choreography must
 * dismiss the rows first (`clearNotificationRows`). The `⧉` right after the prompt
 * glyph is the discriminator; the `❯`-keyed scans skip these rows. The `m` flag lets
 * the same regex probe a whole capture.
 */
const NOTIFICATION_ROW = /^❯\s?⧉/m;

/**
 * Dismiss any visible notification rows with their own `x` key before typing into the
 * pane — while one shows, the input box never sees our keys. Gated on detection (a bare
 * `x` with no row present would type into the input) and re-captured each round so
 * stacked rows drain one by one. Returns whether the pane is actually clear of rows;
 * callers fail loud on false rather than typing into a key-eating widget.
 */
async function clearNotificationRows(paneId: string): Promise<boolean> {
  let cap = flattenStyled(await capturePane(paneId, { escapes: true }), false);
  for (let i = 0; i < 4 && NOTIFICATION_ROW.test(cap); i++) {
    await sendKey(paneId, "x");
    await Bun.sleep(KEY_GAP);
    cap = flattenStyled(await capturePane(paneId, { escapes: true }), false);
  }
  return !NOTIFICATION_ROW.test(cap);
}

export function inputPending(capture: string): boolean {
  const lines = capture.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (NOTIFICATION_ROW.test(lines[i]!)) continue;
    const m = lines[i]!.match(/^❯\s?(.*)$/);
    if (m) {
      const input = m[1]!.trim();
      return input.length > 0 && input !== QUEUED_PLACEHOLDER;
    }
  }
  return false;
}

/**
 * Whether the pane's input is in SHELL MODE (a `!` bash command being composed), and the
 * text it holds. In shell mode the live input line renders `! …` where the `❯` line would
 * be, with a "! for shell mode" hint under the input box (both lab-verified). The hint
 * requirement disambiguates from ordinary output lines that happen to start with `!`;
 * a `❯` found first (scanning bottom-up) means the normal prompt is live — echoed
 * `❯ message` lines only ever sit ABOVE the live input.
 *
 * This exists because `inputPending`/`killInput` are `❯`-keyed and blind to a shell
 * prompt: killInput's C-u loop would no-op yet report the input empty, and the send
 * would type a plain message into a prompt that executes it as bash.
 */
export function shellModeInput(capture: string): { text: string } | null {
  const lines = capture.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (NOTIFICATION_ROW.test(line)) continue;
    if (/^❯/.test(line)) return null;
    const m = line.match(/^!\s?(.*)$/);
    if (m && lines.slice(i + 1).some((l) => l.includes("! for shell mode"))) {
      return { text: m[1]!.trim() };
    }
  }
  return null;
}

/**
 * Answer an open AskUserQuestion by option index (0-based). Gates on an open question
 * being present — NOT bare `waiting`, which also covers permission prompts (those
 * route to `decideApproval`, never here). The decision-file channel is tried FIRST:
 * when the focus-aware PreToolUse hook is holding this question, `decideQuestion`
 * resolves it via `updatedInput.answers` (no live pane needed). Only the un-intercepted
 * (native-widget) case — not tracked, no live phone, or focused — falls through to
 * send-keys, which does need a pane. Rejects when no question is open or the length is off.
 *
 * `toolUseId` (when the client sends it) pins the answer to the question the client
 * actually rendered: a card can go stale on the phone (the question was answered
 * elsewhere and a NEW one is pending), and without the pin the selections would
 * silently answer a question the user never saw.
 */
export async function answerSessionQuestion(
  sessionId: string,
  selections: (number | number[])[],
  toolUseId?: string,
): Promise<SendResult> {
  const pending = pendingToolCall(sessionId);
  if (!hasOpenQuestion(pending)) return { ok: false, reason: "no-question" };
  if (toolUseId && toolUseId !== pending!.toolUseId) return { ok: false, reason: "stale-question" };
  // One selection per question — a length mismatch means the client is out of sync
  // with the live prompt; reject before sending any keystroke to a wrong tab.
  const questions = pending!.questions ?? [pending!.question!];
  if (selections.length !== questions.length) return { ok: false, reason: "bad-selection" };
  // Intercepted by the hook → answer via the decision file, no pane required.
  if (decideQuestion(sessionId, pending!.toolUseId, buildAnswersMap(questions, selections))) {
    return { ok: true };
  }
  // Un-intercepted (native widget) → drive the live pane, but only when the picker is
  // actually on-screen: keystrokes fired at a spinner or bare composer are silently
  // swallowed, and reporting ok for them is exactly the accepted-but-inert answer the
  // phone experienced as "tapping does nothing".
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  if (!(await isQuestionPickerOpen(paneId))) return { ok: false, reason: "not-presented" };
  await answerQuestion(paneId, selections);
  return { ok: true };
}

/**
 * Decline an open AskUserQuestion (the phone's "Chat about this") so the agent yields
 * the turn and waits for the user's next message. Hook-held → the clarify decision
 * file (the hook denies the tool). Un-intercepted (native picker on screen, e.g. the
 * question fired at the desk or the hold released/expired) → drive the picker's own
 * "Chat about this" row via `clarifyQuestion`, which pre-flights the capture and
 * refuses (`not-presented`) rather than fire a key at a permission prompt, a focused
 * free-text row, or a pane that isn't showing the picker.
 */
export async function clarifySessionQuestion(sessionId: string): Promise<SendResult> {
  const pending = pendingToolCall(sessionId);
  if (!hasOpenQuestion(pending)) return { ok: false, reason: "no-question" };
  if (declineQuestion(sessionId, pending!.toolUseId)) return { ok: true };
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  if (!(await clarifyQuestion(paneId))) return { ok: false, reason: "not-presented" };
  return { ok: true };
}

/**
 * Approve/deny an ATTACHED session's on-screen tool permission prompt by driving the pane
 * directly — the detached decision-file channel doesn't exist for attached sessions (the
 * PreToolUse hook exits neutral so the instant desk prompt shows). Mirrors the TUI's own
 * handling: allow presses Enter (option 1 "Yes" is pre-selected), deny presses Escape.
 * Guards on the prompt still being up so a resolved/absent prompt no-ops instead of
 * injecting a stray key into the composer (the caller routes here only when no file-pending
 * approval exists, so a race where the desk already answered lands on `no-prompt`).
 */
export async function decideAttachedApproval(
  sessionId: string,
  decision: "allow" | "deny",
): Promise<SendResult> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  if (!isPermissionPrompt(await capturePane(paneId))) return { ok: false, reason: "no-prompt" };
  await sendKey(paneId, decision === "allow" ? "Enter" : "Escape");
  return { ok: true };
}
