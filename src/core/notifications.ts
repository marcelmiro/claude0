import { statSync, readFileSync, writeFileSync } from "node:fs";
import type { NotificationConfig, Session, TransitionEvent } from "../types";
import type { SessionStatus } from "./status";
import { getAbovePrompt } from "./status";
import { renameWindow, getWindowName } from "./tmux";
import { clientActivityPresence } from "./presence";
import { configCache, DEFAULT_CONFIG } from "./config";
import { sourceForSession } from "./input-source";
import { pendingToolCall } from "./hook-events";
import { listPendingApprovals, PENDING_DIR } from "./approval";
import { CONSUMERS_DIR, sendWebPush } from "./web-push";
import { getSessionName, type NameCache } from "./names";
import type { PushPayload } from "../types";

export const ATTENTION_PREFIX = "⚡";
export const RUNNING_PREFIX = "🔄";
export const SCRIPT_PREFIX = "⏳";
export const NAME_SEPARATOR = "/";

/** Strip every leading ⚡/🔄/⏳ prefix from a window name (loops, so a racily
 *  double-prefixed name can never keep a stale marker). */
export function stripAllPrefixes(name: string): string {
  let out = name;
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const p of [ATTENTION_PREFIX, RUNNING_PREFIX, SCRIPT_PREFIX]) {
      if (out.startsWith(p)) {
        out = out.slice(p.length);
        stripped = true;
      }
    }
  }
  return out;
}

/**
 * Determine the desired prefix: ⚡ > 🔄 > ⏳ > "".
 * ⏳ = the turn is over but the session still waits on a live background script
 * (run_in_background). Visibility only — it never feeds notifications, attention,
 * or the status-right counts.
 */
export function desiredPrefix(hasAttention: boolean, isRunning: boolean, hasScriptWait = false): string {
  if (hasAttention) return ATTENTION_PREFIX;
  if (isRunning) return RUNNING_PREFIX;
  if (hasScriptWait) return SCRIPT_PREFIX;
  return "";
}

/** Display abbreviations for long repo names on tmux windows (ui.repoAbbreviations).
 *  Window names/sidebar only — the TUI list, grouping, and push labels keep the real
 *  repo name. Reads the config cache: callers rename windows on hot sync paths, so
 *  the entry point's startup loadConfig() populates what this consumes. */
export function abbreviateRepo(repo: string): string {
  return configCache().ui.repoAbbreviations?.[repo] ?? repo;
}

/** Build the base window name: {repo}[/{ai-name}][+] */
export function buildBaseName(repo: string, aiName?: string, isFork?: boolean): string {
  let name = abbreviateRepo(repo);
  if (aiName) name += `${NAME_SEPARATOR}${aiName}`;
  if (isFork) name += "+";
  return name;
}

/** Extract AI name from a window name like "{repo}/{ai-name}" or "{repo}/{ai-name}+" */
export function extractAIName(windowName: string): string | null {
  const stripped = stripAllPrefixes(windowName);
  const sepIdx = stripped.indexOf(NAME_SEPARATOR);
  if (sepIdx === -1) return null;
  let aiName = stripped.slice(sepIdx + NAME_SEPARATOR.length);
  if (aiName.endsWith("+")) aiName = aiName.slice(0, -1);
  return aiName || null;
}

/** Extract repo name from a window name like "{repo}" or "{repo}/{ai-name}" */
export function extractRepoFromWindowName(windowName: string): string {
  const stripped = stripAllPrefixes(windowName);
  const sepIdx = stripped.indexOf(NAME_SEPARATOR);
  return sepIdx === -1 ? stripped : stripped.slice(0, sepIdx);
}

/**
 * Detect status transitions between refresh cycles.
 * Pure function — compares previous status map with current sessions.
 */
export function detectTransitions(
  previousStatuses: Map<string, SessionStatus>,
  sessions: Session[],
): TransitionEvent[] {
  const events: TransitionEvent[] = [];

  for (const session of sessions) {
    if (!session.tmuxPane) continue;
    const key = session.tmuxPane.paneId;
    const prev = previousStatuses.get(key);

    if (!prev || prev === session.status) continue;

    const classification = classifyTransition(prev, session.status);
    events.push({
      sessionKey: key,
      previousStatus: prev,
      currentStatus: session.status,
      classification,
      session,
    });
  }

  return events;
}

/**
 * Classify a status transition.
 * running → waiting = blocked (Claude needs tool approval)
 * running → ready = turnComplete (Claude finished its turn)
 * anything else = none
 */
export function classifyTransition(
  prev: string,
  current: string,
): "blocked" | "turnComplete" | "none" {
  if (prev === "running" && current === "waiting") return "blocked";
  if (prev === "ready" && current === "waiting") return "blocked";
  if (prev === "running" && current === "ready") return "turnComplete";
  return "none";
}

/** Extract the waiting prompt text from a pane capture for notification body */
function extractBlockedBody(lastCapture?: string): string {
  if (!lastCapture) return "Waiting for input";
  const lines = lastCapture.split("\n");
  const { nearbyLines } = getAbovePrompt(lines);
  if (!nearbyLines) return "Waiting for input";
  const trimmed = nearbyLines.replace(/\s+/g, " ").trim();
  return trimmed.length > 100 ? trimmed.slice(0, 97) + "..." : trimmed;
}

/** Extract the last meaningful output line from a pane capture for "done" notification body */
function extractDoneBody(lastCapture?: string): string {
  if (!lastCapture) return "";
  const lines = lastCapture.split("\n");
  const { nearbyLines } = getAbovePrompt(lines);
  if (!nearbyLines) return "";
  const trimmed = nearbyLines.replace(/\s+/g, " ").trim();
  return trimmed.length > 100 ? trimmed.slice(0, 97) + "..." : trimmed;
}

/** Cached result of `which terminal-notifier` check */
let _hasTerminalNotifier: boolean | undefined;

function hasTerminalNotifier(): boolean {
  if (_hasTerminalNotifier !== undefined) return _hasTerminalNotifier;
  try {
    const result = Bun.spawnSync(["which", "terminal-notifier"]);
    _hasTerminalNotifier = result.exitCode === 0;
  } catch {
    _hasTerminalNotifier = false;
  }
  return _hasTerminalNotifier;
}

/** Send a macOS native notification (fire-and-forget).
 *  Uses terminal-notifier when available for clickable notifications that raise the
 *  terminal app (`terminalBundleId`) and switch to the correct tmux window/pane.
 *  Falls back to osascript (no click action).
 *  When the user is present (a tmux client keystroke inside the presence window),
 *  plays sound only (no visual notification). */
export function sendNativeNotification(
  title: string,
  body: string,
  pane?: { sessionName: string; windowIndex: number; paneId: string },
  terminalBundleId?: string,
): void {
  // macOS-only by decision (ADR 14): on other hosts the desk surfaces are tmux-side
  // (⚡ prefix, status-right) and the phone has web push — a VM-local notifier would
  // notify the VM, not the human. Without this gate the spawns below no-op silently.
  if (process.platform !== "darwin") return;
  // Fire-and-forget stays: the presence probe forces an async hop, and its rejections
  // never reach a sync caller — the chain carries its own catch.
  (async () => {
    // Present ⇒ the user is at the terminal: play sound only, skip the visual
    // notification. absent/unknown ⇒ full notification — a broken probe must not
    // silence a real alert.
    if ((await clientActivityPresence(pane?.sessionName)) === "present") {
      Bun.spawn(["afplay", "/System/Library/Sounds/Ping.aiff"], { stdout: "ignore", stderr: "ignore" });
      return;
    }

    if (hasTerminalNotifier() && pane) {
      // Absent key ⇒ the shipped default; an explicit "" means "no -activate" — the
      // click still runs the tmux switch, but the terminal app isn't raised.
      const bundleId = terminalBundleId ?? DEFAULT_CONFIG.notifications.terminalBundleId;
      const switchCmd = `tmux select-window -t '${pane.sessionName}:${pane.windowIndex}' && tmux select-pane -t '${pane.paneId}'`;
      const activate = bundleId ? ` -activate "$CLAUDE0_BUNDLE"` : "";
      Bun.spawn(["bash", "-c",
        `terminal-notifier -title "$CLAUDE0_TITLE" -message "$CLAUDE0_BODY" -sound Ping${activate} -execute "$CLAUDE0_SWITCH"`,
      ], {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, CLAUDE0_TITLE: title, CLAUDE0_BODY: body, CLAUDE0_SWITCH: switchCmd, CLAUDE0_BUNDLE: bundleId },
      });
    } else {
      const escaped = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      Bun.spawn(["bash", "-c",
        `osascript -e 'display notification "${escaped(body)}" with title "${escaped(title)}" sound name "Ping"'`,
      ], { stdout: "ignore", stderr: "ignore" });
    }
  })().catch(() => {
    // Non-fatal
  });
}

/**
 * Dispatch notifications for transition events.
 * Tier 1 (status monitor) is handled externally via state.
 * Tier 2 (window ⚡ prefix) is dispatched here.
 * Tier 3 (macOS native notification) is dispatched here.
 */
export async function dispatchNotifications(
  events: TransitionEvent[],
  config: NotificationConfig,
  nameCache?: NameCache,
): Promise<void> {
  for (const event of events) {
    if (event.classification === "none") continue;

    const { session } = event;
    if (!session.tmuxPane) continue;

    // Tier 2: Window name ⚡ prefix
    if (config.windowPrefix) {
      const currentName = session.name || session.tmuxPane.windowName;
      if (!currentName.startsWith(ATTENTION_PREFIX)) {
        const baseName = stripAllPrefixes(currentName);
        await renameWindow(
          session.tmuxPane.sessionName,
          session.tmuxPane.windowIndex,
          `${ATTENTION_PREFIX}${baseName}`,
        );
      }
    }

    // Tier 3: macOS native notification. Same label as push: cache-resolved title
    // form, falling back to the stripped window name for unresolved sessions.
    if (config.nativeNotification) {
      const nativeTitle = nameCache && session.id ? getSessionName(session.id, nameCache) : "";
      const name = nativeTitle
        ? `${session.repo} · ${nativeTitle}`
        : stripAllPrefixes(session.name || session.tmuxPane.windowName);
      const pane = {
        sessionName: session.tmuxPane.sessionName,
        windowIndex: session.tmuxPane.windowIndex,
        paneId: session.tmuxPane.paneId,
      };
      if (event.classification === "blocked") {
        const title = `⚡ Blocked — ${name}`;
        const body = extractBlockedBody(session.lastCapture);
        sendNativeNotification(title, body, pane, config.terminalBundleId);
      } else if (event.classification === "turnComplete") {
        const title = `✅ Done — ${name}`;
        const body = extractDoneBody(session.lastCapture);
        sendNativeNotification(title, body, pane, config.terminalBundleId);
      }
    }

    // Tier 4: Web Push — only to the device that drove the most recent input, and
    // only when that device isn't watching live via SSE (an open portkey already
    // shows the change; a push would just duplicate it). Skip unresolved sessions
    // (no id ⇒ can't attribute) and markers without a device (pre-web-push format —
    // self-heals on the next portkey action). No subscription ⇒ sendWebPush no-ops.
    if (session.id) {
      const src = sourceForSession(session.id);
      if (src.source === "portkey" && src.deviceId && !deviceConnected(src.deviceId)) {
        await sendWebPush(src.deviceId, pushPayloadFor(event, session, nameCache));
      }
    }
  }
}

/**
 * Push for approvals the PreToolUse hook is HOLDING for the phone. A held approval
 * never renders the pane picker, so the status stays `running` and the transition
 * dispatch above can never fire for it — the phone was the intended approval surface
 * yet nothing told it. Runs every monitor tick over the live `pending/*.json` markers:
 * push once per hold (sidecar remembers the hold's tool_use_id + ts), only to the device that
 * drove the turn, and only while that device isn't watching via SSE. The
 * watching-then-backgrounded case heals itself: the sidecar is only written when a
 * push is actually sent, so backgrounding mid-hold pushes on the next tick.
 */
export async function dispatchHeldApprovalPushes(sessions: Session[], nameCache?: NameCache): Promise<void> {
  for (const hold of listPendingApprovals()) {
    const session = sessions.find((s) => s.id === hold.sessionId);
    if (!session) continue;
    const src = sourceForSession(hold.sessionId);
    if (src.source !== "portkey" || !src.deviceId || deviceConnected(src.deviceId)) continue;
    const sidecar = `${PENDING_DIR}/${hold.sessionId}.pushed`;
    // Key on tool_use_id + ts: the shell-side tool_use_id extraction can come up
    // empty, and an id-only key would then match every later hold on the session
    // and mute it permanently. The ts is stamped once per hold, so the pair is
    // stable for one hold and distinct across holds.
    const holdKey = `${hold.tool_use_id}:${hold.ts}`;
    try {
      if (readFileSync(sidecar, "utf8") === holdKey) continue; // this hold already pushed
    } catch {
      /* no sidecar — not pushed yet */
    }
    const event: TransitionEvent = {
      sessionKey: session.tmuxPane?.paneId ?? hold.sessionId,
      previousStatus: "running",
      currentStatus: "waiting",
      classification: "blocked",
      session,
    };
    await sendWebPush(src.deviceId, pushPayloadFor(event, session, nameCache));
    try {
      writeFileSync(sidecar, holdKey);
    } catch {
      /* worst case: a duplicate push next tick */
    }
  }
}

/** Title-case a space-delimited string ("fix auth" → "Fix Auth"). */
function titleCase(s: string): string {
  return s
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Human-facing, non-sensitive label for a push: `${repo} · ${Name}`. The name is
 * resolved title-form from the name cache — never round-tripped through the tmux
 * slug, whose abbreviations ("Notif Cfg") and 24-char cut are lossy. Falls back to
 * un-slugging the window name (unresolved session or no cache), then repo alone.
 * Repo stays verbatim (raw dir name).
 */
export function pushLabel(session: Session, cache?: NameCache): string {
  const title = cache && session.id ? getSessionName(session.id, cache) : "";
  if (title) return `${session.repo} · ${title}`;
  const aiName = extractAIName(session.name);
  if (!aiName) return session.repo;
  return `${session.repo} · ${titleCase(aiName.replace(/-/g, " "))}`;
}

/**
 * Non-sensitive category derived from the pending tool's NAME only (never its
 * input) — safe to cross ntfy.sh + APNs.
 */
export function pushAction(sessionId: string): string {
  const name = pendingToolCall(sessionId)?.name;
  if (name === "Bash") return "run a command";
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
    return "make an edit";
  }
  if (name === "AskUserQuestion") return "answer a question";
  return "needs permission";
}

/**
 * True when `deviceId` is watching live: the bridge touches `consumers/<deviceId>`
 * on SSE connect + every 15s heartbeat and unlinks it on the goodbye beacon (sent
 * when portkey is backgrounded). ≤40s tolerates one missed heartbeat — the crash/
 * network fallback when the beacon never arrived.
 */
export function deviceConnected(deviceId: string): boolean {
  try {
    return Date.now() - statSync(`${CONSUMERS_DIR}/${deviceId}`).mtimeMs < 40_000;
  } catch {
    return false; // marker missing — device not connected
  }
}

/**
 * Tier-4 payload. The service worker renders it verbatim and deep-links via the
 * sessionId. NEVER includes `lastCapture` or any tool input/diff/command/question
 * text — only the non-sensitive label + tool-name category (same policy as the
 * ntfy era, even though Web Push is end-to-end encrypted).
 */
export function pushPayloadFor(event: TransitionEvent, session: Session, cache?: NameCache): PushPayload {
  // Compact on purpose: iOS appends its own "from portkey" attribution line, so the
  // title (state emoji + session label) is the whole message. Only blocked adds a
  // body — the pending-tool category is the one detail worth a second line.
  const label = pushLabel(session, cache);
  if (event.classification === "blocked") {
    const action = pushAction(session.id);
    return {
      title: `⚡ ${label}`,
      body: action === "needs permission" ? action : `${action}?`,
      sessionId: session.id,
    };
  }
  return { title: `✅ ${label}`, body: "", sessionId: session.id };
}

/**
 * Sync the prefix (⚡/🔄/⏳/none) on a tmux window to match the desired state.
 * Callers pass the window's computed attention/running flags. Only the monitor
 * computes script-wait; other callers leave `hasScriptWait` undefined and a ⏳
 * already on the window is preserved rather than stripped-then-restored next tick.
 */
export async function syncWindowPrefix(
  sessionName: string,
  windowIndex: number,
  hasAttention: boolean,
  hasRunning: boolean,
  hasScriptWait?: boolean,
): Promise<void> {
  const currentName = await getWindowName(sessionName, windowIndex);
  if (!currentName) return;
  const baseName = stripAllPrefixes(currentName);
  const prefix = desiredPrefix(hasAttention, hasRunning, hasScriptWait ?? currentName.startsWith(SCRIPT_PREFIX));
  const desired = `${prefix}${baseName}`;
  if (currentName !== desired) {
    await renameWindow(sessionName, windowIndex, desired);
  }
}
