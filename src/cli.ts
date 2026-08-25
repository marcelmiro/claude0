/**
 * Claude0 CLI subcommands — lightweight commands that don't require the full TUI.
 *
 * claude0 next              — switch to the next session needing attention
 * claude0 reset             — reset all window names back to repo names
 * claude0 list              — print a text-only session list
 * claude0 switch <name>     — fuzzy-match a session by name and switch to it
 * claude0 save-sessions     — snapshot pane→session mappings for tmux-resurrect
 * claude0 restore-sessions  — restore Claude sessions after tmux-resurrect restore
 * claude0 resurrect         — run tmux-resurrect's own save/restore script
 */

import { homedir } from "os";
import { loadState, saveState, loadPaneSessions } from "./core/state";
import { switchToPane, listPanes, renameWindow, capturePane, displayMessage, atDeskFocus, SHELL_NAMES, sendBracketedPaste } from "./core/tmux";
import { shellModeInput, flattenStyled } from "./core/session-api";
import { isPng, saveUploadedBytes } from "./core/uploads";
import { imagePasteManifest, imagePasteKey, terminalBundleId, readServiceTemplates, pbsServiceKey, pbsServiceValue, receiveRefusal, describeKey, IMAGE_MAX_BYTES, SERVICE_NAME, type FocusedPane } from "./core/image-paste";
import { syncWindowPrefix, stripAllPrefixes, abbreviateRepo, ATTENTION_PREFIX } from "./core/notifications";
import { findClaudeProcesses } from "./core/process";
import { detectStatus } from "./core/status";
import { eventSourcedStatus } from "./core/hook-events";
import { nativeStatus, resolveStatus } from "./core/session-state";
import { loadNameCache, slugify } from "./core/names";
import { PATHS, DEFAULT_CONFIG, loadConfig, saveConfig, ensureUserConfig, tmuxKeys, resolveRole } from "./core/config";
import { renderTmuxFragment, renderTerminalLauncher, importAccepted, installedHookVersion, runDoctor, envValue, REQUIRED_TOOLS, CLIENT_TOOLS } from "./core/doctor";
import type { Config, DeploymentRole } from "./types";
import { PRESENCE_WINDOW_S } from "./core/presence";
import { pickSavedCwd, resolveRestoreTarget, resolveResurrect, resurrectOptionSet, resurrectRenderDir, resurrectCommand, cloneResurrectCommands, RESURRECT_COMMIT, daemonSaveCommand, RESURRECT_SAVE_INTERVAL_MS } from "./core/resurrect";
import { pickRepoPath } from "./core/sessions";
import { resolveTranscriptPath, latestTranscriptCwd } from "./core/last-turn";
import { shellQuote } from "./core/launch-command";
import { PENDING_DIR, DECISIONS_DIR, HOLD_WINDOW_MS, QUESTION_HOLD_MS, HOOK_KILL_GRACE_MS } from "./core/approval";
import { mkdirSync, writeFileSync, readFileSync, readlinkSync, rmSync, symlinkSync, existsSync } from "node:fs";

const home = homedir();

// ---------------------------------------------------------------------------
// claude0 next
// ---------------------------------------------------------------------------

/**
 * Switch to the next session needing attention.
 * Picks the session that has been waiting the longest (oldest lastTransition).
 * Validates each candidate is still alive and genuinely needs attention before switching.
 */
export async function next(): Promise<void> {
  const state = await loadState();

  // Clear attention for the pane the user is currently viewing.
  // Without this, claude0-next ping-pongs: switches away from pane A (still flagged)
  // to pane B, then next call picks A again because its flag was never cleared.
  let activePaneId: string | undefined;
  try {
    const client = (await Bun.$`tmux list-clients -F '#{client_name}'`.quiet().text()).trim().split("\n")[0];
    if (client) {
      activePaneId = (await Bun.$`tmux display-message -c ${client} -p '#{pane_id}'`.quiet().text()).trim();
      const activeSession = state.sessions[activePaneId];
      if (activePaneId && activeSession?.needsAttention) {
        activeSession.needsAttention = false;
        activeSession.attentionType = undefined;
        // Sync prefix on source window — may restore 🔄 if other panes are running
        if (activeSession.tmuxSession !== undefined && activeSession.tmuxWindow !== undefined) {
          const othersInSourceWindow = Object.values(state.sessions).filter(
            (s) =>
              s.tmuxPane !== activePaneId &&
              s.tmuxSession === activeSession.tmuxSession &&
              String(s.tmuxWindow) === String(activeSession.tmuxWindow),
          );
          const hasAttention = othersInSourceWindow.some(s => s.needsAttention);
          const hasRunning = activeSession.status === "running" ||
            othersInSourceWindow.some(s => s.status === "running");
          await syncWindowPrefix(activeSession.tmuxSession!, activeSession.tmuxWindow!, hasAttention, hasRunning);
        }
      }
    }
  } catch {
    // Not in tmux context
  }

  const attentionSessions = Object.entries(state.sessions)
    .filter(([_, s]) => s.needsAttention)
    .sort(
      (a, b) => (a[1].lastTransition ?? Infinity) - (b[1].lastTransition ?? Infinity),
    );

  // Validate candidates from state: check pane still exists and session still needs attention
  let target: { paneId: string; tmuxSession: string; tmuxWindow: number } | null = null;
  for (const candidate of attentionSessions) {
    const [_, s] = candidate;
    if (!s.tmuxSession || s.tmuxWindow === undefined || !s.tmuxPane) continue;

    // Capture pane to verify it exists and check current status
    const captured = await capturePane(s.tmuxPane);
    if (!captured) {
      // Pane is dead — clear stale attention
      s.needsAttention = false;
      s.attentionType = undefined;
      continue;
    }

    const plain = captured
      .replace(/\x1b\[[0-9;?]*[\x40-\x7e]/g, "")
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    const result = detectStatus(plain, true);

    if (result.status === "running" || result.status === "idle") {
      // Session no longer needs attention — clear stale flag, sync prefix
      s.needsAttention = false;
      s.attentionType = undefined;
      if (s.tmuxSession !== undefined && s.tmuxWindow !== undefined) {
        const others = Object.values(state.sessions).filter(
          (o) => o.tmuxPane !== s.tmuxPane &&
            o.tmuxSession === s.tmuxSession && String(o.tmuxWindow) === String(s.tmuxWindow),
        );
        await syncWindowPrefix(s.tmuxSession!, s.tmuxWindow!,
          others.some(o => o.needsAttention),
          result.status === "running" || others.some(o => o.status === "running"));
      }
      continue;
    }

    target = { paneId: s.tmuxPane, tmuxSession: s.tmuxSession, tmuxWindow: s.tmuxWindow };
    break;
  }

  // Fallback: if state had no valid candidates, scan tmux windows for ⚡ prefixes.
  // This handles desync where the window shows ⚡ but state.json doesn't know about it.
  if (!target) {
    const panes = await listPanes();
    const attentionPanes = panes.filter((p) =>
      p.windowName.startsWith(ATTENTION_PREFIX) && p.paneId !== activePaneId);

    for (const pane of attentionPanes) {
      const captured = await capturePane(pane.paneId);
      if (!captured) continue;

      const plain = captured
        .replace(/\x1b\[[0-9;?]*[\x40-\x7e]/g, "")
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      const result = detectStatus(plain, true);

      if (result.status === "running" || result.status === "idle") {
        // Not actually needing attention — sync prefix (may restore 🔄)
        await syncWindowPrefix(pane.sessionName, pane.windowIndex, false, result.status === "running");
        continue;
      }

      target = { paneId: pane.paneId, tmuxSession: pane.sessionName, tmuxWindow: pane.windowIndex };
      break;
    }
  }

  if (!target) {
    // Neither state nor window scan found anything
    state.lastUpdatedBy = "tui";
    state.lastUpdatedAt = Date.now();
    await saveState(state);
    await displayMessage("No sessions need attention");
    return;
  }

  // Clear attention flag in state (if it exists) and save
  // Use lastUpdatedBy="tui" so the monitor defers to our state
  // and doesn't overwrite our changes on its next poll
  const stateEntry = state.sessions[target.paneId];
  if (stateEntry) {
    stateEntry.needsAttention = false;
    stateEntry.attentionType = undefined;
  }
  state.lastUpdatedBy = "tui";
  state.lastUpdatedAt = Date.now();
  await saveState(state);

  // Sync prefix on target window — may restore 🔄 if other panes are running
  const othersInWindow = Object.values(state.sessions).filter(
    (s) =>
      s.tmuxPane !== target!.paneId &&
      s.tmuxSession === target!.tmuxSession &&
      String(s.tmuxWindow) === String(target!.tmuxWindow),
  );
  await syncWindowPrefix(target.tmuxSession, target.tmuxWindow,
    othersInWindow.some(s => s.needsAttention),
    othersInWindow.some(s => s.status === "running"));

  // Switch to the pane
  await switchToPane(target.paneId, target.tmuxSession, target.tmuxWindow);

  // Jump itself is the confirmation — no toast needed.
}

// ---------------------------------------------------------------------------
// claude0 reset
// ---------------------------------------------------------------------------

/** Standard shell/tool names that shouldn't be renamed. */
const KEEP_NAMES = new Set([...SHELL_NAMES, "dev"]);

/**
 * Reset all tmux window names back to repo name.
 * Strips ⚡/🔄 prefixes and AI-generated names. Also clears attention state.
 */
export async function reset(): Promise<void> {
  try {
    // Populate the config cache so abbreviateRepo sees ui.repoAbbreviations.
    await loadConfig().catch(() => null);
    // Get all panes to map windows to repo paths
    const panes = await listPanes();
    const windowRepos = new Map<string, string>();
    for (const pane of panes) {
      const wKey = `${pane.sessionName}:${pane.windowIndex}`;
      if (!windowRepos.has(wKey)) {
        const repo = pane.currentPath === home
          ? "~"
          : (pane.currentPath.split("/").pop() || "claude");
        windowRepos.set(wKey, abbreviateRepo(repo));
      }
    }

    const output = await Bun.$`tmux list-windows -a -F '#{session_name}:#{window_index} #{window_name}'`
      .quiet()
      .text();
    const lines = output.trim().split("\n").filter(Boolean);
    let count = 0;

    for (const line of lines) {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) continue;
      const target = line.slice(0, spaceIdx);
      const name = line.slice(spaceIdx + 1);
      const [sessionName, windowIndex] = target.split(":");

      const cleanName = stripAllPrefixes(name);
      const wKey = `${sessionName}:${windowIndex}`;
      const repoName = windowRepos.get(wKey) ?? "claude";

      if (KEEP_NAMES.has(cleanName)) {
        // Shell/tool name — only strip prefix if present
        if (name !== cleanName) {
          await renameWindow(sessionName, parseInt(windowIndex, 10), cleanName);
          count++;
        }
      } else if (cleanName !== repoName) {
        // AI-generated, tmux-auto "claude", or prefixed name → reset to repo name
        await renameWindow(sessionName, parseInt(windowIndex, 10), repoName);
        count++;
      } else if (name !== cleanName) {
        // Already repo name but has prefix → strip it
        await renameWindow(sessionName, parseInt(windowIndex, 10), cleanName);
        count++;
      }
    }

    // Clear all attention flags in state
    const state = await loadState();
    let cleared = false;
    for (const s of Object.values(state.sessions)) {
      if (s.needsAttention) {
        s.needsAttention = false;
        s.attentionType = undefined;
        cleared = true;
      }
    }
    if (cleared) {
      state.lastUpdatedAt = Date.now();
      await saveState(state);
    }

    console.log(`Reset ${count} window${count !== 1 ? "s" : ""}`);
  } catch {
    console.error("Failed to list tmux windows");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// claude0 list
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<string, string> = {
  waiting: "⏸",
  running: "⦿",
  ready: "●",
  idle: "○",
};

/**
 * Print a text-only list of active Claude sessions.
 */
export async function list(): Promise<void> {
  const [panes, processes, paneSessions] = await Promise.all([
    listPanes(),
    findClaudeProcesses(),
    loadPaneSessions(),
  ]);

  // Map each tty to its claude process (prefer one with a resolved sessionId) so a
  // fork pane can use its real, native-resolved id instead of the parent id the hook
  // recorded (see resolvePaneSessionId / nativeSessionIdByPid).
  const procByTty = new Map<string, typeof processes[0]>();
  for (const proc of processes) {
    const existing = procByTty.get(proc.tty);
    if (!existing || proc.sessionId) procByTty.set(proc.tty, proc);
  }
  const claudeTtys = new Set(processes.map((p) => p.tty));
  const claudePanes = panes.filter((pane) => {
    const normalizedTty = pane.tty.replace(/^\/dev\//, "");
    return claudeTtys.has(normalizedTty);
  });

  if (claudePanes.length === 0) {
    console.log("No active sessions");
    return;
  }

  // Capture and detect status for each pane. Prefer event-sourced status when a
  // hook log exists (correct on scroll-up); else fall back to the viewport scraper.
  const sessions = await Promise.all(
    claudePanes.map(async (pane) => {
      const captured = await capturePane(pane.paneId);
      const plain = captured
        .replace(/\x1b\[[0-9;?]*[\x40-\x7e]/g, "")
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      const scraper = detectStatus(plain, true);

      // A fork's hook-owned map entry is the PARENT id; its native-resolved id
      // (proc.sessionId) wins so it doesn't render the parent's running status.
      const proc = procByTty.get(pane.tty.replace(/^\/dev\//, ""));
      const sessionId = proc?.isFork
        ? (proc.sessionId ?? paneSessions[pane.paneId])
        : paneSessions[pane.paneId];
      const native = sessionId ? await nativeStatus(sessionId) : null;
      const eventStatus = sessionId ? await eventSourcedStatus(sessionId) : null;
      const resolved = resolveStatus(native, eventStatus, scraper.status);

      const name = stripAllPrefixes(pane.windowName);
      // A pane restored by tmux-resurrect comes back in $HOME, so its cwd would render every
      // such session as "~". Claude's own last-recorded cwd is the authority there — same
      // rule the TUI applies (pickRepoPath).
      const transcript = sessionId && pane.currentPath === home
        ? await resolveTranscriptPath(sessionId)
        : null;
      const repoPath = pickRepoPath(
        pane.currentPath,
        transcript ? await latestTranscriptCwd(transcript) : null,
      );
      const repo = repoPath === home
        ? "~"
        : (repoPath.split("/").pop() || repoPath);

      return {
        name,
        status: resolved.status,
        statusSource: resolved.source,
        contextPercent: scraper.contextPercent,
        repo,
        needsAttention: pane.windowName.startsWith(ATTENTION_PREFIX),
      };
    }),
  );

  // Sort: attention first, then by status priority
  const statusOrder: Record<string, number> = { waiting: 0, running: 1, ready: 2, idle: 3 };
  sessions.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    return (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
  });

  for (const s of sessions) {
    const icon = STATUS_ICONS[s.status] || "?";
    const attention = s.needsAttention ? " ⚡" : "";
    const ctx = s.contextPercent ? ` ${s.contextPercent}%` : "";
    console.log(
      `${icon} ${s.name.padEnd(24)} ${s.status.padEnd(8)} statusSource=${s.statusSource.padEnd(7)} ${s.repo}${ctx}${attention}`,
    );
  }
}

// ---------------------------------------------------------------------------
// claude0 switch <name>
// ---------------------------------------------------------------------------

/** Score a candidate name against a search needle */
function fuzzyScore(candidate: string, needle: string): number {
  if (candidate === needle) return 100;
  if (candidate.startsWith(needle)) return 80;
  if (candidate.includes(needle)) return 60;
  const words = candidate.split(/[-_\s]+/);
  if (words.some((w) => w.startsWith(needle))) return 40;
  if (isSubsequence(needle, candidate)) return 20;
  return 0;
}

/**
 * Fuzzy-match a session by name and switch to it.
 * Matches against both tmux window names and AI-generated names from the cache.
 */
export async function switchTo(name?: string): Promise<void> {
  if (!name) {
    console.error("Usage: claude0 switch <name>");
    process.exit(1);
  }

  const [panes, processes, nameCache, state] = await Promise.all([
    listPanes(),
    findClaudeProcesses(),
    loadNameCache(),
    loadState(),
  ]);

  // Build TTY→sessionId map for cached name lookup
  const ttyToSessionId = new Map<string, string>();
  for (const proc of processes) {
    if (proc.sessionId) ttyToSessionId.set(proc.tty, proc.sessionId);
  }

  const needle = name.toLowerCase();

  // Score each pane by best match across window name and cached name
  const scored = panes
    .map((pane) => {
      const windowName = stripAllPrefixes(pane.windowName).toLowerCase();
      let score = fuzzyScore(windowName, needle);

      // Also try matching against the AI-generated name from the cache
      const normalizedTty = pane.tty.replace(/^\/dev\//, "");
      const sessionId = ttyToSessionId.get(normalizedTty);
      if (sessionId) {
        const cachedName = nameCache.names[sessionId];
        if (cachedName) {
          // Match against both the normalized name ("fix auth") and its tmux slug
          // ("fix-auth") — the user likely types the slug shown on the tab.
          score = Math.max(score, fuzzyScore(cachedName.toLowerCase(), needle), fuzzyScore(slugify(cachedName), needle));
        }
      }

      return { pane, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    console.error(`No session matching "${name}"`);
    process.exit(1);
  }

  const best = scored[0].pane;

  // Sync prefix: clear ⚡ for this pane, but preserve 🔄 if other panes are running
  const windowPanes = Object.values(state.sessions).filter(
    (s) => s.tmuxSession === best.sessionName && String(s.tmuxWindow) === String(best.windowIndex),
  );
  await syncWindowPrefix(best.sessionName, best.windowIndex,
    windowPanes.some(s => s.needsAttention && s.tmuxPane !== best.paneId),
    windowPanes.some(s => s.status === "running"));

  await switchToPane(best.paneId, best.sessionName, best.windowIndex);
}

function isSubsequence(sub: string, str: string): boolean {
  let j = 0;
  for (let i = 0; i < str.length && j < sub.length; i++) {
    if (str[i] === sub[j]) j++;
  }
  return j === sub.length;
}

// ---------------------------------------------------------------------------
// claude0 setup
// ---------------------------------------------------------------------------

export const HOOK_VERSION = 20;

// A bridge-consumer marker older than this is a dead phone connection: the bridge
// touches it on SSE connect and every 15s heartbeat, so 40s tolerates one missed
// heartbeat. Shared by both PreToolUse holds (approval + question) — the gates must
// agree on what "a phone is watching" means.
const CONSUMER_FRESH_S = 40;

// SessionStart pane→session mapper. Writes one file per pane (panes/<paneId> → sessionId)
// atomically (temp+rename) — the hook OWNS the map, so there's no shared-file write race and
// no consume-once log for readers to fight over (v6 appended to a truncate-once hook-events
// file that only the monitor persisted, leaving sessions listed-but-unsendable).
const HOOK_SCRIPT = `#!/bin/bash
# HOOK_VERSION=${HOOK_VERSION}
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
# Only use $TMUX_PANE — never fall back to tmux display-message which returns
# the active pane, not the pane running this Claude session.
PANE_ID="$TMUX_PANE"
if [ -n "$SESSION_ID" ] && [ -n "$PANE_ID" ]; then
  D=~/.config/claude0/panes
  mkdir -p "$D"
  printf '%s' "$SESSION_ID" > "$D/$PANE_ID.tmp" && mv "$D/$PANE_ID.tmp" "$D/$PANE_ID"
fi
`;

// Shared event logger (Inc3). Appends the raw hook payload, one JSON object per
// line, to events/<session_id>.jsonl. Newlines in the stdin payload are collapsed
// to spaces so each event is exactly one line — JSON escapes real newlines inside
// strings (\\n), so this only flattens pretty-print formatting, never string
// contents. Trim to the last 200 lines ONLY when over budget, via atomic rename
// (.tmp + mv -f) so the ~3s concurrent readers never see a torn file; the common
// path stays a bare append (~5ms, A7).
const LOG_EVENT_SNIPPET = `INPUT=$(cat)
# Whitespace-tolerant (handles compact AND pretty-printed payloads); cut -f4 yields
# the value either way. session-start.sh keeps its proven compact-only pattern.
SESSION_ID=$(printf '%s' "$INPUT" | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$SESSION_ID" ]; then
  DIR=~/.config/claude0/events
  mkdir -p "$DIR"
  F="$DIR/$SESSION_ID.jsonl"
  LINE=$(printf '%s' "$INPUT" | tr '\\n' ' ')
  printf '%s\\n' "$LINE" >> "$F"
  LINES=$(wc -l < "$F")
  if [ "$LINES" -gt 200 ]; then
    tail -200 "$F" > "$F.tmp" && mv -f "$F.tmp" "$F"
  fi
fi`;

// Shared presence probe for both PreToolUse gates (LOG_EVENT_SNIPPET precedent):
// newest client keystroke within the window ⇒ exit 0, each gate's safe direction
// (desk prompt / native widget). One fragment interpolated into both scripts so the
// probe can't drift between them; each site's surrounding comment explains why
// ambiguity fails toward exit 0 there.
const PRESENCE_CHECK_SNIPPET = `ACT=$(tmux list-clients -t "$SESS" -F '#{client_activity}' 2>/dev/null | sort -rn | head -1)
  # Empty OR non-numeric activity is unreadable, not stale — arithmetic on a
  # non-number would read as a huge age and flip the polarity to "away".
  case "$ACT" in ''|*[!0-9]*) exit 0 ;; esac
  if [ $(( $(date +%s) - ACT )) -le ${PRESENCE_WINDOW_S} ]; then
    exit 0
  fi`;

// Non-blocking events (UserPromptSubmit/PostToolUse/Notification/Stop/SubagentStop).
const EVENT_HOOK_SCRIPT = `#!/bin/bash
# HOOK_VERSION=${HOOK_VERSION}
# Claude0 event logger — see LOG_EVENT_SNIPPET.
${LOG_EVENT_SNIPPET}
`;

// PreToolUse handler. Logs the event (ADR-3b: always before the decision), then
// attach-aware approval (Inc6, A6): user present at the desk → exit neutral so the
// desk TUI prompt appears instantly (no added lag); away AND a phone watching →
// write pending/<id>.json and block-poll decisions/<id>.json every 500ms up to the
// 600s hook timeout, emitting the permission decision (or neutral fallthrough on
// timeout — the desk prompt is always the floor). Pure shell, no jq/new deps; the
// full tool_input is recovered by listPendingApprovals from the logged event.
const PRETOOLUSE_HOOK_SCRIPT = `#!/bin/bash
# HOOK_VERSION=${HOOK_VERSION}
# Claude0 PreToolUse handler — log, then attach-aware blocking approval
# (AskUserQuestion is delegated to question-pretooluse.sh).
${LOG_EVENT_SNIPPET}

# Derive the session from \$TMUX_PANE (A6). Outside tmux → neutral, never block.
[ -z "\$TMUX_PANE" ] && exit 0
SESS=$(tmux display-message -p -t "\$TMUX_PANE" '#{session_name}' 2>/dev/null)
[ -z "\$SESS" ] && exit 0
[ -z "\$SESSION_ID" ] && exit 0

# Tool + tool_use_id, derived once for the approval block-poll below.
TOOL=$(printf '%s' "\$INPUT" | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
TUID=$(printf '%s' "\$INPUT" | grep -oE '"tool_use_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)

# Subagents share their parent session_id and can execute concurrently. The approval IPC
# has one pending/decision slot per session, so holding subagent calls here lets them
# overwrite one another and strand pollers until the 600s deadline. Exit neutral — this
# does not approve the tool; Claude's own permission handling remains authoritative.
AGENT_ID=$(printf '%s' "\$INPUT" | grep -oE '"agent_id"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | cut -d'"' -f4)
[ -n "\$AGENT_ID" ] && exit 0

# AskUserQuestion is handled by question-pretooluse.sh — a separate, matcher-scoped
# registration whose kill timeout matches the hours-long question hold. This script's
# short timeout must keep applying to every ordinary tool call (a hung approval hook
# blocks the whole session), so the question path exits here — AFTER the log above,
# which is the event line portkey mirrors, written exactly once.
[ "\$TOOL" = "AskUserQuestion" ] && exit 0

# Presence → fall through to the instant desk TUI prompt (no lag). An attached
# client alone is NOT presence — on a remote host a persistent SSH attach is the
# steady state even with the user away — so presence = a client keystroke within
# the window; attached-but-idle falls through to the phone hold. Unreadable
# activity fails toward the desk prompt — a wrong "away" strands every tool call
# in the block-poll below.
CL=$(tmux list-clients -t "\$SESS" 2>/dev/null)
if [ -n "\$CL" ]; then
  ${PRESENCE_CHECK_SNIPPET}
fi

# Away from the desk — but a hold only helps if a phone is actually watching.
# bridge-consumer mtime <=${CONSUMER_FRESH_S}s (touched on SSE connect + 15s heartbeats, cleared by
# the goodbye beacon — same signal/threshold as the question intercept) means
# portkey is open: hold for it. Stale/absent → nobody can answer a hold; fall
# through so the desk prompt renders and flips status to waiting, which is what
# fires the Web Push to the phone (a held call reads as running and never pushes).
M="\$HOME/.config/claude0/bridge-consumer"
MT=$(stat -c %Y "\$M" 2>/dev/null || stat -f %m "\$M" 2>/dev/null || echo 0)
case "\$MT" in ''|*[!0-9]*) MT=0 ;; esac
if [ "\$MT" = 0 ] || [ \$(( \$(date +%s) - MT )) -ge ${CONSUMER_FRESH_S} ]; then exit 0; fi

# Phone watching → register the pending approval and block-poll for a decision.
# ADR-3 fix: don't block on calls Claude would auto-approve anyway, or a detached
# (autonomous/subagent-heavy) session stalls up to 600s per call. bypassPermissions
# never prompts; auto mode's classifier approves on its own (and a remote deny just
# terminates the turn, so a phone hold buys nothing); read-only tools never prompt
# in any mode. Only tools that could actually raise a prompt reach the block-poll below.
PERM=$(printf '%s' "\$INPUT" | grep -oE '"permission_mode"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
case "\$PERM" in bypassPermissions|auto) exit 0 ;; esac
case "\$TOOL" in
  Read|Glob|Grep|NotebookRead|TodoWrite|Task) exit 0 ;;
esac

TS=$(( $(date +%s) * 1000 ))
PDIR=~/.config/claude0/pending
DFILE=~/.config/claude0/decisions/"\$SESSION_ID".json
mkdir -p "\$PDIR"
# \$\$ stamps the poller's pid: readers treat a marker whose process is gone as abandoned
# (killed hook) and drive the on-screen prompt instead of writing a decision nobody reads.
printf '{"sessionId":"%s","ts":%s,"pid":%s,"tool":"%s","tool_use_id":"%s"}\\n' "\$SESSION_ID" "\$TS" "\$\$" "\$TOOL" "\$TUID" > "\$PDIR/\$SESSION_ID".json

# Poll to a DEADLINE, not an iteration count: each pass forks several greps, so a counted
# loop runs well past the window and gets killed by the hook timeout before it can reach
# the cleanup below — which is what strands a marker and makes readers see a phantom hold.
END=\$(( \$(date +%s) + ${HOLD_WINDOW_MS / 1000} ))
while [ "\$(date +%s)" -lt "\$END" ]; do
  if [ -f "\$DFILE" ]; then
    KIND=$(grep -oE '"kind"[[:space:]]*:[[:space:]]*"[^"]*"' "\$DFILE" | head -1 | cut -d'"' -f4)
    DTUID=$(grep -oE '"tool_use_id"[[:space:]]*:[[:space:]]*"[^"]*"' "\$DFILE" | head -1 | cut -d'"' -f4)
    # Consume only our OWN approval decision: skip a stale question decision, and skip
    # an approval whose tool_use_id (when present) belongs to a different call.
    if [ "\$KIND" != "question" ] && { [ -z "\$DTUID" ] || [ "\$DTUID" = "\$TUID" ]; }; then
      DECISION=$(grep -oE '"decision"[[:space:]]*:[[:space:]]*"[^"]*"' "\$DFILE" | head -1 | cut -d'"' -f4)
      REASON=$(grep -oE '"reason"[[:space:]]*:[[:space:]]*"[^"]*"' "\$DFILE" | head -1 | cut -d'"' -f4)
      rm -f "\$DFILE" "\$PDIR/\$SESSION_ID".json
      if [ "\$DECISION" = "allow" ]; then
        printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\\n'
        exit 0
      elif [ "\$DECISION" = "deny" ]; then
        printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n' "\$REASON"
        exit 0
      fi
    fi
  fi
  sleep 0.5
done

# Timeout → neutral fallthrough to the desk TUI prompt (nothing stranded).
rm -f "\$PDIR/\$SESSION_ID".json
exit 0
`;

// AskUserQuestion intercept, split from pretooluse.sh so its registration can carry the
// hours-long question-hold timeout without also letting a hung approval hook block a
// session for hours. Registered with matcher "AskUserQuestion" (pretooluse.sh logs the
// event and exits for this tool, so the gates below run exactly once per question).
// Checks run cheap→expensive; ANY miss or ambiguity exits 0 (native widget) — never hold
// a session hostage when unsure. No claude-version gate: updatedInput.answers is assumed
// forward-compatible; if a future claude breaks it the phone-answer just won't take
// (visibly degraded) rather than silently reverting the feature on every patch bump.
const QUESTION_PRETOOLUSE_HOOK_SCRIPT = `#!/bin/bash
# HOOK_VERSION=${HOOK_VERSION}
# Claude0 AskUserQuestion handler — focus-aware intercept (event logging stays in pretooluse.sh).
INPUT=$(cat)
[ -z "\$TMUX_PANE" ] && exit 0
SESS=$(tmux display-message -p -t "\$TMUX_PANE" '#{session_name}' 2>/dev/null)
[ -z "\$SESS" ] && exit 0

# 1. Claude0-tracked pane (rules out an ad-hoc bare-terminal claude).
[ -f "\$HOME/.config/claude0/panes/\$TMUX_PANE" ] || exit 0
# 2. Live bridge consumer: marker mtime <=${CONSUMER_FRESH_S}s (tolerates one missed 15s heartbeat).
#    Stale/absent → nobody can answer → native widget, no long stall.
M="\$HOME/.config/claude0/bridge-consumer"
MT=$(stat -c %Y "\$M" 2>/dev/null || stat -f %m "\$M" 2>/dev/null || echo 0)
if [ "\$MT" = 0 ] || [ $(( $(date +%s) - MT )) -ge ${CONSUMER_FRESH_S} ]; then exit 0; fi
# 3. Focus (three-part): active window + attached client (cheap tmux), and only then
#    the presence probe. Same probes as atDeskFocus() in core/tmux.ts (the hold's
#    release check) — keep the two in sync, but note the OPPOSITE failure polarity:
#    here ambiguity means "don't intercept". An attached client alone is not presence
#    (a remote host's persistent attach is the steady state), so presence = a client
#    keystroke within the window (attached-but-idle ⇒ user away ⇒ intercept for the
#    phone).
WA=$(tmux display-message -p -t "\$TMUX_PANE" '#{window_active}' 2>/dev/null)
CL=$(tmux list-clients -t "\$SESS" 2>/dev/null)
if [ "\$WA" = "1" ] && [ -n "\$CL" ]; then
  ${PRESENCE_CHECK_SNIPPET}
fi
# All gates passed → hold and answer via the file channel (releases early on refocus).
printf '%s' "\$INPUT" | claude0 question-hook
exit \$?
`;

/** Hook scripts Claude0 installs under ~/.config/claude0/hooks. */
export const HOOK_SCRIPTS = [
  { name: "session-start.sh", content: HOOK_SCRIPT },
  { name: "event.sh", content: EVENT_HOOK_SCRIPT },
  { name: "pretooluse.sh", content: PRETOOLUSE_HOOK_SCRIPT },
  { name: "question-pretooluse.sh", content: QUESTION_PRETOOLUSE_HOOK_SCRIPT },
] as const;

const FILE_HOOK_SCRIPTS = [] as const;

/** Which hook script handles each Claude Code event. PreToolUse blocks (Inc6). */
const HOOK_REGISTRATIONS: { event: string; script: string; matcher?: string; timeout?: number }[] = [
  { event: "SessionStart", script: "session-start.sh" },
  { event: "UserPromptSubmit", script: "event.sh" },
  { event: "PostToolUse", script: "event.sh" },
  { event: "Notification", script: "event.sh" },
  { event: "Stop", script: "event.sh" },
  { event: "SubagentStop", script: "event.sh" },
  // Claude Code's own timeout — the SIGKILL each hook poll loop races. Deliberately the
  // poll window PLUS a grace: Claude counts from spawn and a loop can't start its clock
  // until the process is up, so registering the bare window would make the kill land first
  // and strand the marker the loop's cleanup would have removed. Two entries on purpose:
  // the matcher-scoped question hold may run for hours, while every other tool call must
  // stay killable at ~10 min.
  {
    event: "PreToolUse",
    script: "pretooluse.sh",
    timeout: (HOLD_WINDOW_MS + HOOK_KILL_GRACE_MS) / 1000,
  },
  {
    event: "PreToolUse",
    script: "question-pretooluse.sh",
    matcher: "AskUserQuestion",
    timeout: (QUESTION_HOLD_MS + HOOK_KILL_GRACE_MS) / 1000,
  },
];

/**
 * Resurrection is claude0-essential (no dotfiles required), but a user-managed
 * TPM copy keeps winning byte-identically. Returns the plugin dir the tmux
 * fragment should load via run-shell, or null when it must emit no run-shell
 * line (user-managed copy, client role, or a failed clone).
 */
async function ensureResurrect(home: string, role: DeploymentRole): Promise<string | null> {
  const resolved = await resolveResurrect(home, await resurrectOptionSet());
  const dir = resurrectRenderDir(resolved, role, home);
  if (dir === null) return null; // user-managed copy loads itself, or client role
  if (resolved.source === "claude0") return dir;
  if (process.env.CLAUDE0_HOME) return dir; // tests exercise the rendering, never the network
  try {
    for (const argv of cloneResurrectCommands(dir)) {
      const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
      if ((await proc.exited) !== 0) throw new Error(`${argv.join(" ")} failed`);
    }
    console.log(`tmux-resurrect installed: ${dir} (pinned ${RESURRECT_COMMIT.slice(0, 12)})`);
    return dir;
  } catch {
    // Offline or git absent — a run-shell line pointing at nothing would error on
    // every tmux start, so degrade to no line; the next setup run retries.
    rmSync(dir, { recursive: true, force: true });
    console.error("tmux-resurrect clone failed — resurrection disabled until `claude0 setup` reruns.");
    return null;
  }
}

const TMUX_SOURCE_LINE = "if-shell 'test -f ~/.config/claude0/tmux.conf' 'source-file ~/.config/claude0/tmux.conf' ''";
const ZSH_SOURCE_LINE = '[[ -r "$HOME/.config/claude0/shell.zsh" ]] && source "$HOME/.config/claude0/shell.zsh"';

/**
 * Install the Claude0-owned terminal profile and add one import to the user's base
 * tmux/zsh files. Personal config stays personal; setup can update its fragment
 * without rewriting or templating somebody else's dotfiles.
 */
async function installTerminalIntegration(home: string, resurrectDir: string | null): Promise<string[]> {
  const configDir = `${import.meta.dir}/../config`;
  const files = [
    { source: `${configDir}/tmux.conf`, target: `${home}/.config/claude0/tmux.conf`, executable: false },
    { source: `${configDir}/shell.zsh`, target: `${home}/.config/claude0/shell.zsh`, executable: false },
    { source: `${configDir}/terminal-launcher`, target: `${home}/.config/claude0/terminal-launcher`, executable: true },
  ];
  const changed: string[] = [];

  // Render tmux.keys into the fragment's {{BIND_*}} tokens and terminal.* into
  // the launcher's (both shared with doctor's freshness check so the two can't
  // diverge). A config change lands on the next setup run (the tmux fragment is
  // re-sourced below when it differs).
  const config = await loadConfig().catch(() => null);
  const keys = tmuxKeys(config);
  const staleBinds: string[][] = [];

  for (const file of files) {
    let wanted = await Bun.file(file.source).text();
    if (file.source.endsWith("tmux.conf")) {
      wanted = renderTmuxFragment(wanted, keys, resurrectDir);
    }
    if (file.source.endsWith("terminal-launcher")) {
      wanted = renderTerminalLauncher(wanted, (config ?? DEFAULT_CONFIG).terminal);
    }
    let existing = "";
    try { existing = await Bun.file(file.target).text(); } catch {}
    if (file.source.endsWith("tmux.conf") && existing && existing !== wanted) {
      // A re-source binds the new keys but never unbinds the old — collect the
      // previously installed binds so the live server can drop any that changed.
      // (sidebarFocus/sidebarToggle stale binds are handled by the renderer's
      // sidebar-keys.json marker instead — those binds have no template to diff.)
      for (const marker of ["tmux set-environment CLAUDE0_FOCUS_PANE", "claude0 next"]) {
        const old = existing.match(new RegExp(`^bind-key (?:(-n) )?(\\S+) run-shell '${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
        if (old && !wanted.includes(old[0])) staleBinds.push(old[1] ? ["-n", old[2]!] : [old[2]!]);
      }
    }
    if (existing !== wanted) {
      const slash = file.target.lastIndexOf("/");
      await Bun.$`mkdir -p ${file.target.slice(0, slash)}`.quiet();
      await Bun.write(file.target, wanted);
      changed.push(file.target);
    }
    if (file.executable) await Bun.$`chmod +x ${file.target}`.quiet();
  }

  // `claude0` is the canonical command; `c0` is the typing shorthand. Both are
  // symlinks (not shell aliases) so tmux run-shell, units, and scripts resolve them.
  const commandSource = `${import.meta.dir}/../bin/claude0.ts`;
  for (const name of ["claude0", "c0"]) {
    const commandTarget = `${home}/.local/bin/${name}`;
    let installedCommand = "";
    try { installedCommand = readlinkSync(commandTarget); } catch {}
    if (installedCommand !== commandSource) {
      await Bun.$`mkdir -p ${home}/.local/bin`.quiet();
      rmSync(commandTarget, { force: true });
      symlinkSync(commandSource, commandTarget);
      changed.push(commandTarget);
    }
  }

  // A dotfiles layer may already source the fragment from a file the entry
  // point includes (e.g. ~/.config/zsh/common.zsh) — appending the import to
  // the entry point too would source it twice. Acceptance rule shared with
  // doctor (importAccepted): fragment path, entry file plus aux config dir.
  const imports = [
    { path: `${home}/.tmux.conf`, line: TMUX_SOURCE_LINE, fragment: ".config/claude0/tmux.conf", aux: `${home}/.config/tmux`, label: "tmux import" },
    { path: `${home}/.zshrc`, line: ZSH_SOURCE_LINE, fragment: ".config/claude0/shell.zsh", aux: `${home}/.config/zsh`, label: "zsh import" },
  ];
  for (const entry of imports) {
    let existing = "";
    try { existing = await Bun.file(entry.path).text(); } catch {}
    if (!(await importAccepted(entry.path, entry.aux, entry.fragment))) {
      const prefix = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
      await Bun.write(entry.path, `${existing}${prefix}# Claude0 integration (managed by claude0 setup)\n${entry.line}\n`);
      changed.push(entry.label);
    }
  }

  // Apply updates to an existing server without creating one. CLAUDE0_HOME is the
  // test seam and must never touch the developer's real tmux server.
  if (!process.env.CLAUDE0_HOME && Bun.which("tmux")) {
    await Bun.$`tmux has-session`.quiet().nothrow().then(async (result) => {
      if (result.exitCode !== 0) return;
      for (const args of staleBinds) await Bun.$`tmux unbind-key ${args}`.quiet().nothrow();
      await Bun.$`tmux source-file ${home}/.config/claude0/tmux.conf`.quiet();
    });
  }

  return changed;
}

/**
 * Install the Claude0 hooks into ~/.claude/settings.json and create the hook scripts.
 *
 * Registers Claude0's tracking and approval hooks. Safe to run multiple
 * times — rewrites outdated scripts and adds only missing registrations, so a
 * second run is a no-op and user hooks are preserved.
 */
const ROLES: readonly DeploymentRole[] = ["local", "host", "client"];

async function promptLine(question: string): Promise<string> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Interactive prompts are for real runs only: tests (CLAUDE0_HOME) may run under a pty. */
function canPrompt(): boolean {
  return !process.env.CLAUDE0_HOME && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/**
 * Resolve this machine's deployment role: flag > configured value > inference.
 * An inferred host/client is confirmed at a TTY before anything installs — a
 * wrong guess installs (or retires) daemons; inferred "local" is the silent
 * zero-question default. Explicit and non-local resolutions are written to
 * config to pin them; an inferred "local" is deliberately NOT written, so a
 * machine later pointed at a remote host re-infers client and retires its
 * daemon instead of trusting a frozen default. dryRun answers the same question
 * with zero side effects: no confirm prompt, nothing persisted.
 */
export async function resolveSetupRole(
  flag: string | undefined,
  platform: NodeJS.Platform = process.platform,
  dryRun = false,
): Promise<DeploymentRole> {
  const config = await loadConfig();
  let role: DeploymentRole;
  if (flag !== undefined) {
    if (!ROLES.includes(flag as DeploymentRole)) {
      throw new Error(`--role must be local, host or client (received "${flag}")`);
    }
    role = flag as DeploymentRole;
  } else {
    role = resolveRole(config, platform);
    if (!dryRun && config.deployment?.role === undefined && role !== "local" && canPrompt()) {
      const what =
        role === "host"
          ? "the host (owns tmux, sessions, daemon, bridge, inbox)"
          : "a client of a remote host (terminal + alerts only)";
      const answer = (await promptLine(`Set up this machine as ${what}? [Y/n] `)).toLowerCase();
      if (answer !== "" && answer !== "y" && answer !== "yes") {
        throw new Error("setup aborted — re-run with --role local|host|client to choose explicitly");
      }
    }
  }
  if (role === "host" && platform === "darwin") {
    throw new Error('role "host" requires a linux/systemd machine — a Mac holding host duties is role "local"');
  }
  const pin = !dryRun && (flag !== undefined || role !== "local");
  if (pin && config.deployment?.role !== role) {
    await saveConfig({ ...config, deployment: { role } });
  }
  return role;
}

export interface SetupOptions {
  tz?: string;
  swapGb?: string;
  dryRun?: boolean;
}

/** The host-provisioning context for this machine (flags win over defaults). */
async function provisionContext(home: string, opts: SetupOptions) {
  const { userInfo, totalmem } = await import("node:os");
  // Default swap to the machine's RAM size (the no-hibernation server rule):
  // enough to degrade instead of livelock under pressure, no tuning needed.
  const swapGb = opts.swapGb === undefined ? Math.max(1, Math.ceil(totalmem() / 2 ** 30)) : Number(opts.swapGb);
  if (!Number.isInteger(swapGb) || swapGb <= 0) {
    throw new Error(`--swap-gb must be a positive integer (received "${opts.swapGb}")`);
  }
  if (opts.tz !== undefined && opts.tz === "") {
    throw new Error("--tz needs an IANA zone value (e.g. Europe/London)");
  }
  return {
    home,
    unitsDir: `${import.meta.dir}/../config/units`,
    user: process.env.USER ?? userInfo().username,
    tz: opts.tz ?? "Europe/London",
    swapGb,
    bridgePort: process.env.CLAUDE0_BRIDGE_PORT ?? "8473",
  };
}

export async function setup(roleFlag?: string, opts: SetupOptions = {}): Promise<void> {
  const { homedir } = await import("os");
  const home = process.env.CLAUDE0_HOME ?? homedir(); // CLAUDE0_HOME: test seam (see config.ts)
  const settingsPath = `${home}/.claude/settings.json`;
  const hookDir = `${home}/.config/claude0/hooks`;
  const scriptPath = (name: string) => `${hookDir}/${name}`;

  // --dry-run previews host provisioning and exits — no side effects at all,
  // no sudo prompt, nothing persisted (role resolution included).
  if (opts.dryRun) {
    const role = await resolveSetupRole(roleFlag, process.platform, true);
    if (role !== "host" || process.platform !== "linux") {
      throw new Error(`--dry-run previews host provisioning, but this machine's role is "${role}" (${process.platform})`);
    }
    const { probeSystemState, planProvision, renderDryRun } = await import("./core/provision");
    const ctx = await provisionContext(home, opts);
    const state = await probeSystemState(ctx);
    for (const line of renderDryRun(planProvision(state, ctx), state, ctx)) console.log(line);
    return;
  }

  const configCreated = await ensureUserConfig();
  const role = await resolveSetupRole(roleFlag);

  // Missing tools warn but never abort: everything setup writes is inert
  // config that goes live once the tool exists. Host provisioning installs
  // these itself, so the pre-flight would only report what it's about to fix.
  const roleTools = role === "client" ? CLIENT_TOOLS : REQUIRED_TOOLS;
  const missingTools = role === "host" ? [] : roleTools.filter((tool) => !Bun.which(tool));
  const warnMissingTools = () => {
    if (missingTools.length === 0) return;
    console.log(`⚠ Missing required tools: ${missingTools.join(", ")}`);
    console.log("  Install them with your package manager (macOS: brew — see README), then re-run `claude0 doctor`.");
  };
  warnMissingTools();

  // A client is nothing without its host: ask once, or say where to set it.
  if (role === "client") {
    const config = await loadConfig();
    let terminal = config.terminal;
    if (!terminal.remoteHost) {
      if (canPrompt()) {
        const host = await promptLine("Remote host to attach to (tailscale/ssh name): ");
        if (host) terminal = { ...terminal, remoteHost: host };
        else console.log(`No host set — set terminal.remoteHost in ${PATHS.config} before using \`claude0 terminal\`.`);
      } else {
        console.log(`Set terminal.remoteHost in ${PATHS.config} to finish client setup.`);
      }
    }
    // A client's terminal is the host: bare `claude0 terminal` should attach remotely.
    if (terminal.remoteHost && terminal.defaultTarget !== "remote") {
      terminal = { ...terminal, defaultTarget: "remote" };
    }
    if (terminal !== config.terminal) await saveConfig({ ...config, terminal });
  }

  const integrationChanged = await installTerminalIntegration(home, await ensureResurrect(home, role));

  // Load existing settings (or start fresh)
  let settings: Record<string, any> = {};
  try {
    settings = JSON.parse(await Bun.file(settingsPath).text());
  } catch {
    // No settings file or malformed — start fresh
  }
  if (!settings.hooks) settings.hooks = {};
  let settingsChanged = false;

  // Rewrite any missing/outdated script (version gate is per-script).
  await Bun.$`mkdir -p ${hookDir}`.quiet();
  const fileHookScripts = await Promise.all(FILE_HOOK_SCRIPTS.map(async (name) => ({
    name,
    content: (await Bun.file(`${import.meta.dir}/../config/hooks/${name}`).text())
      .replace("__HOOK_VERSION__", String(HOOK_VERSION)),
  })));
  // Scripts an existing registration points at must stay real even on a client:
  // a registered hook whose script vanished would exit 127 on every Claude event,
  // and a client's never-install-fresh rule would otherwise leave it that way.
  // Matching reuses the registration loop's home-independent path suffix so the
  // two sites can't drift apart on the command format.
  const registeredCommands: string[] = [];
  for (const entries of Object.values(settings.hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const hooks = (entry as { hooks?: unknown }).hooks;
      if (!Array.isArray(hooks)) continue;
      for (const hook of hooks) {
        const command = (hook as { command?: unknown }).command;
        if (typeof command === "string") registeredCommands.push(command);
      }
    }
  }
  const scriptRegistered = (name: string) => registeredCommands.some((c) => c.includes(`/.config/claude0/hooks/${name}`));

  let scriptsWritten = 0;
  let scriptsUpdated = false;
  for (const { name, content } of [...HOOK_SCRIPTS, ...fileHookScripts]) {
    const path = scriptPath(name);
    const installed = await installedHookVersion(path);
    // A client never installs hooks fresh — sessions live on the host. But hooks
    // already present or still registered (a host-era install, or occasional
    // local sessions) are kept current: a stale hook is worse than an absent one.
    if (role === "client" && installed === 0 && !scriptRegistered(name)) continue;
    if (installed < HOOK_VERSION) {
      await Bun.write(path, content);
      await Bun.$`chmod +x ${path}`.quiet();
      scriptsWritten++;
      if (installed > 0) scriptsUpdated = true;
    }
  }

  // Ensure each event has exactly one Claude0 registration. Match on the
  // home-independent suffix of the script path, not the absolute path: a
  // dotfiles-managed settings.json registers hooks as `$HOME/...`, and the
  // same file travels between machines whose homes differ — an absolute-path
  // match misses those and appends a duplicate that fires every hook twice.
  for (const { event, script, matcher, timeout } of HOOK_REGISTRATIONS) {
    const path = scriptPath(script);
    const pathSuffix = `/.config/claude0/hooks/${script}`;
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    const existing = settings.hooks[event]
      .flatMap((entry: any) => (Array.isArray(entry.hooks) ? entry.hooks : []))
      .find((h: any) => typeof h.command === "string" && h.command.includes(pathSuffix));
    // Explicit `bash` + quoted path: Claude runs hook commands via `/bin/sh -c`, which is
    // dash on Debian-family hosts — the scripts are bash, and a bare shebang-reliant path
    // has been seen to fail there. Quoting keeps a path with spaces from silently exiting 127.
    const desiredCommand = `bash "${path}"`;
    // Any `bash "…/.config/claude0/hooks/<script>"` command is already correct in
    // either home spelling ($HOME or absolute) — rewriting it to this machine's
    // absolute path would break the portable form a shared settings.json uses.
    const commandOk = (cmd: string) => cmd.startsWith('bash "') && cmd.endsWith(`${pathSuffix}"`);
    if (!existing) {
      if (role === "client") continue; // never register fresh on a client — reconcile existing only
      const hook: Record<string, unknown> = { type: "command", command: desiredCommand };
      if (timeout !== undefined) hook.timeout = timeout;
      const entry: Record<string, unknown> = { hooks: [hook] };
      if (matcher !== undefined) entry.matcher = matcher; // omit matcher → all events/tools
      settings.hooks[event].push(entry);
      settingsChanged = true;
    } else {
      // Reconcile, don't just add: the registration is matched on command path, so an
      // install from an older version keeps its stale command form / timeout forever
      // otherwise — and that timeout is the kill deadline the hook's own poll window
      // has to stay inside.
      if (!commandOk(existing.command)) {
        existing.command = desiredCommand;
        settingsChanged = true;
      }
      if (timeout !== undefined && existing.timeout !== timeout) {
        existing.timeout = timeout;
        settingsChanged = true;
      }
    }
  }

  if (settingsChanged) {
    await Bun.$`mkdir -p ${home}/.claude`.quiet();
    await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }

  const daemonResult = await installDaemonAgent(home, role);
  const imagePasteResult = await installImagePasteService(home, role);

  // Sidebar default-on: the renderer stands up only while this marker exists,
  // and nothing else creates it — a
  // fresh machine would run an invisible inbox engine, with no M-S binding
  // installed to turn it on. M-S visibility rides its own hidden marker.
  // Client machines run no daemon, so the marker would be inert — skip it.
  if (role !== "client") {
    try {
      const autostart = `${PATHS.dir}/inbox-sidebar-autostart-default`;
      if (!(await Bun.file(autostart).exists())) {
        await Bun.$`mkdir -p ${PATHS.dir}`.quiet();
        await Bun.write(autostart, "");
      }
    } catch {}
  }

  // Host provisioning runs last on both exit paths so the guided auth
  // checklist is setup's final output — doctor's TODO list. CLAUDE0_HOME is
  // the test seam: tests must never spawn sudo/apt/curl.
  const provisionHost = async () => {
    if (role !== "host" || process.platform !== "linux" || process.env.CLAUDE0_HOME) return;
    const { runHostProvisioning } = await import("./core/provision");
    await runHostProvisioning(await provisionContext(home, opts));
  };

  if (!scriptsWritten && !settingsChanged && daemonResult === "unchanged" && imagePasteResult === "unchanged" && integrationChanged.length === 0 && !configCreated) {
    console.log("Claude0 hooks and terminal integration already configured.");
    await provisionHost();
    warnMissingTools();
    return;
  }

  if (integrationChanged.length > 0) {
    console.log("Claude0 terminal integration installed.");
    console.log(`  Profile: ${home}/.config/claude0/{tmux.conf,shell.zsh}`);
    console.log(`  Command: ${home}/.local/bin/c0`);
    console.log(`  Launcher: ${home}/.config/claude0/terminal-launcher`);
    if (integrationChanged.some((path) => path.endsWith("/terminal-launcher"))) {
      console.log(`  Note: terminal.* values are baked into the launcher — after editing ${PATHS.config}, re-run claude0 setup.`);
    }
  }

  if (configCreated) console.log(`Claude0 config created: ${PATHS.config}`);

  if (scriptsWritten || settingsChanged) {
    console.log(scriptsUpdated ? "Claude0 hooks updated." : "Claude0 hooks installed.");
    console.log(`  Hook scripts: ${hookDir} (tracking and approvals)`);
    console.log(`  Settings: ${settingsPath}`);
  }
  if (daemonResult !== "unchanged") {
    console.log(`Inbox daemon ${daemonResult} (launchd: com.claude0.daemon — snooze wakes fire without a terminal open).`);
  }
  if (imagePasteResult !== "unchanged") {
    const config = await loadConfig().catch(() => null); // same file the installer rendered from
    console.log(`Image paste service ${imagePasteResult}: ${describeKey(imagePasteKey(config))} in ${terminalBundleId(config)} pastes the clipboard image into the focused Claude session.`);
    console.log("  The terminal must leave that chord unbound (Ghostty: keybind = super+shift+v=unbind).");
  }
  console.log(
    role === "client"
      ? "\nClient setup complete — `claude0 terminal` attaches to the remote host."
      : "\nNew Claude Code sessions will now emit status/transcript events.",
  );
  if (role === "client" && process.platform === "darwin") {
    console.log("Point your terminal's startup command at claude0 so a failed connection falls back to a local shell, e.g. Ghostty:");
    console.log(`  /bin/zsh -lc '"$HOME/.local/bin/c0" terminal; exec /bin/zsh -l'`);
  }
  await provisionHost();
  warnMissingTools();
}

/**
 * Install/refresh the launchd agent that keeps `claude0 daemon` alive. launchd
 * (KeepAlive + RunAtLoad) is what makes a snooze survive reboots: the wake
 * pass must run with no tmux client attached and no terminal open. The plist
 * pins the bun binary and the claude0 entry script that ran this setup, plus a
 * PATH that reaches tmux — launchd's default PATH doesn't include homebrew.
 */
async function installDaemonAgent(home: string, role: DeploymentRole): Promise<"installed" | "updated" | "unchanged"> {
  // launchd is darwin-only. On the Linux VM host the daemon runs as the
  // claude0-daemon.service user unit, installed by host provisioning like the
  // other units — setup must not scatter launchd artifacts there.
  if (process.platform !== "darwin") return "unchanged";
  // One host owns the inbox. A darwin machine runs the launchd daemon only
  // when it holds both roles (local); a client's host runs the daemon, and a
  // local one would produce a second, divergent inbox (and its own snooze
  // wakes). Skip the install, and retire any agent a pre-role setup left.
  if (role !== "local") {
    const plistPath = `${home}/Library/LaunchAgents/com.claude0.daemon.plist`;
    const hadAgent = await Bun.file(plistPath).exists();
    if (!process.env.CLAUDE0_HOME) {
      const uid = process.getuid?.() ?? 501;
      await Bun.$`launchctl bootout gui/${uid}/com.claude0.daemon`.quiet().nothrow();
    }
    rmSync(plistPath, { force: true });
    if (hadAgent) console.log(`Inbox daemon retired: this machine's role is "${role}" — the host owns the inbox.`);
    return "unchanged";
  }
  const { resolve } = await import("node:path");
  const agentDir = `${home}/Library/LaunchAgents`;
  const plistPath = `${agentDir}/com.claude0.daemon.plist`;
  const entry = resolve(process.argv[1] ?? "");
  // The PATH symlink, not process.execPath: execPath resolves to the
  // versioned Cellar binary, which a brew upgrade deletes — silently killing
  // the daemon that snoozes depend on.
  const bunBin = Bun.which("bun") ?? process.execPath;
  const logPath = `${home}/.config/claude0/daemon.log`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claude0.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunBin}</string>
    <string>--env-file=/dev/null</string>
    <string>${entry}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;

  let existing = "";
  try {
    existing = await Bun.file(plistPath).text();
  } catch {}
  const changed = existing !== plist;
  if (changed) {
    await Bun.$`mkdir -p ${agentDir}`.quiet();
    await Bun.write(plistPath, plist);
  }

  // CLAUDE0_HOME is the test seam — never touch the real launchd from tests.
  if (!process.env.CLAUDE0_HOME) {
    const uid = process.getuid?.() ?? 501;
    const target = `gui/${uid}/com.claude0.daemon`;
    if (changed) {
      await Bun.$`launchctl bootout ${target}`.quiet().nothrow();
      // bootstrap right after bootout races the old service's teardown and
      // fails with I/O error — verify and retry until the daemon is actually
      // loaded (a silently-unloaded agent means snoozes never wake).
      for (let i = 0; i < 5; i++) {
        await Bun.$`launchctl bootstrap gui/${uid} ${plistPath}`.quiet().nothrow();
        if ((await Bun.$`launchctl print ${target}`.quiet().nothrow()).exitCode === 0) break;
        await Bun.sleep(1000);
      }
    } else {
      // plist unchanged but the agent may not be loaded (fresh boot of an old
      // install, manual bootout) — bootstrap is a cheap no-op when it is.
      const loaded = (await Bun.$`launchctl print ${target}`.quiet().nothrow()).exitCode === 0;
      if (!loaded) await Bun.$`launchctl bootstrap gui/${uid} ${plistPath}`.quiet().nothrow();
    }
  }

  return changed ? (existing ? "updated" : "installed") : "unchanged";
}

/**
 * Install/refresh the macOS Service whose hotkey runs `claude0 paste-image`
 * (see core/image-paste.ts). Client Macs only: a local Mac's Claude Code pastes
 * natively, and the host has no pasteboard. The hotkey lives in the `pbs`
 * defaults domain and needs a pbs flush to apply.
 */
async function installImagePasteService(home: string, role: DeploymentRole): Promise<"installed" | "updated" | "unchanged"> {
  if (process.platform !== "darwin") return "unchanged";
  // Read after the client prompt above may have saved terminal.remoteHost.
  const config = await loadConfig().catch(() => null);
  const install = imagePasteManifest(home, config, await readServiceTemplates(`${import.meta.dir}/../config`));
  const wanted = role === "client" && Boolean(config?.terminal.remoteHost);
  if (!wanted) {
    const hadBundle = existsSync(install.dir);
    rmSync(install.dir, { recursive: true, force: true });
    if (hadBundle && !process.env.CLAUDE0_HOME) {
      await Bun.$`defaults write pbs NSServicesStatus -dict-remove ${pbsServiceKey(SERVICE_NAME)}`.quiet().nothrow();
    }
    if (hadBundle) console.log(`Image paste service retired: ${role === "client" ? "terminal.remoteHost is unset" : `this machine's role is "${role}"`}.`);
    else if (role === "client") console.log("Image paste service skipped: set terminal.remoteHost, then re-run claude0 setup.");
    return "unchanged";
  }

  let existed = false;
  let changed = false;
  for (const file of install.files) {
    let existing = "";
    try {
      existing = await Bun.file(file.path).text();
      existed = true;
    } catch {}
    if (existing === file.content) continue;
    await Bun.write(file.path, file.content); // creates Contents/
    changed = true;
  }

  // CLAUDE0_HOME is the test seam — never touch the real pbs domain from tests.
  // The hotkey is re-registered on every run: it's idempotent, and a user who
  // removed it in System Settings gets it back with the next setup.
  if (!process.env.CLAUDE0_HOME) {
    await Bun.$`defaults write pbs NSServicesStatus -dict-add ${pbsServiceKey(SERVICE_NAME)} ${pbsServiceValue(install.keyEquivalent)}`.quiet().nothrow();
    await Bun.$`/System/Library/CoreServices/pbs -flush`.quiet().nothrow();
    await Bun.$`/System/Library/CoreServices/pbs -update`.quiet().nothrow();
  }
  return changed ? (existed ? "updated" : "installed") : "unchanged";
}

// ---------------------------------------------------------------------------
// claude0 receive-image (host side of the client's image paste)
// ---------------------------------------------------------------------------

/**
 * Read a PNG from stdin (shipped by `claude0 paste-image` over ssh), store it as
 * an upload, and bracketed-paste its path into the Claude pane the attached
 * client is looking at — Claude Code renders that as `[Image #N]`, the same
 * path portkey attachments take. Refusals print one line and exit 2; the Mac
 * shows that line as a notification. Path only, no Enter: like a local paste,
 * the user captions and submits.
 */
export async function receiveImage(): Promise<void> {
  const refuse = (reason: string) => {
    console.log(reason);
    process.exitCode = 2;
  };
  // Cap while reading: the Mac pre-checks the size, but anything with ssh access
  // could pipe an unbounded stream — never buffer past the limit.
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of Bun.stdin.stream()) {
      total += chunk.byteLength;
      if (total > IMAGE_MAX_BYTES) return refuse(`image exceeds ${IMAGE_MAX_BYTES / 1024 / 1024} MB`);
      chunks.push(chunk);
    }
  } catch {
    return refuse("could not read the image");
  }
  const bytes = Buffer.concat(chunks);

  let pane: FocusedPane | null = null;
  try {
    // The most recently active client — a second attached terminal (rare, single
    // operator) shouldn't capture a paste meant for the one being typed in.
    const clients = (await Bun.$`tmux list-clients -F '#{client_activity} #{client_name}'`.quiet().text())
      .trim().split("\n").filter(Boolean)
      .map((line) => line.split(" "))
      .sort((a, b) => Number(b[0]) - Number(a[0]));
    const client = clients[0]?.[1];
    if (client) {
      const [id, currentCommand] = (await Bun.$`tmux display-message -c ${client} -p '#{pane_id} #{pane_current_command}'`.quiet().text()).trim().split(" ");
      if (id) {
        const capture = await capturePane(id, { escapes: true });
        pane = { id, currentCommand: currentCommand ?? "", shellMode: shellModeInput(flattenStyled(capture, false)) !== null };
      }
    }
  } catch {
    // no tmux server — reads as no client attached
  }

  const refusal = receiveRefusal({ png: isPng(bytes), pane });
  if (refusal) return refuse(refusal);
  let path: string | null = null;
  try {
    path = await saveUploadedBytes(bytes, "image/png");
  } catch {}
  if (!path) return refuse("could not store the image");
  await sendBracketedPaste(pane!.id, path);
}

// ---------------------------------------------------------------------------
// claude0 doctor
// ---------------------------------------------------------------------------

/**
 * Read-only role-aware health check (check logic in core/doctor.ts).
 * Exit 0 iff no failures; warnings never affect the exit code.
 */
export async function doctor(): Promise<void> {
  // An unloadable config is the config check's finding, not a crash — the role
  // then falls back to pure inference. Loaded once here; checks read it off ctx.
  let config: Config | null = null;
  let configError: string | null = null;
  try {
    config = await loadConfig();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
  process.exitCode = await runDoctor({
    home: process.env.CLAUDE0_HOME ?? home,
    role: resolveRole(config),
    platform: process.platform,
    templateDir: `${import.meta.dir}/../config`,
    configPath: PATHS.config,
    config,
    configError,
    hookVersion: HOOK_VERSION,
    hookScripts: HOOK_SCRIPTS.map((script) => script.name),
  });
}

// ---------------------------------------------------------------------------
// claude0 save-sessions  (tmux-resurrect post-save hook)
// ---------------------------------------------------------------------------

const RESURRECT_SESSIONS_PATH = `${PATHS.dir}/resurrect-sessions.json`;

interface ResurrectSessionEntry {
  sessionId: string;
  cwd: string;
}

interface ResurrectSessionMap {
  savedAt: string;
  sessions: Record<string, ResurrectSessionEntry>;
}


/**
 * Resurrect save/restore must only ever run against the DEFAULT tmux server.
 * The resurrect/continuum hooks live in global tmux.conf, so they fire on ANY
 * server start — a scratch server (`tmux -L whatever`) would restore the real
 * layout and resume every mapped Claude session a second time (two processes
 * appending to one transcript), or overwrite the coordinate map with scratch
 * coordinates.
 */
async function onDefaultTmuxServer(): Promise<boolean> {
  try {
    const path = (await Bun.$`tmux display-message -p '#{socket_path}'`.quiet().text()).trim();
    return path.split("/").pop() === "default";
  } catch {
    return false; // no server reachable — nothing to save/restore anyway
  }
}

/**
 * Snapshot current pane→Claude session mappings using tmux coordinates
 * (session:window.pane_index) that survive a tmux server restart.
 *
 * Designed to be called by tmux-resurrect's @resurrect-hook-post-save-all.
 * Can also be run manually before a planned restart.
 */
export async function saveSessions(): Promise<void> {
  if (!(await onDefaultTmuxServer())) return; // scratch server — see onDefaultTmuxServer
  const paneSessions = await loadPaneSessions();
  if (Object.keys(paneSessions).length === 0) {
    // Nothing tracked — skip silently (hook context)
    return;
  }

  // Get all panes with their stable coordinates + pane_id
  let paneCoords: Array<{ paneId: string; coord: string; cwd: string }>;
  try {
    const output = await Bun.$`tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index} #{pane_current_path}'`
      .quiet()
      .text();
    paneCoords = output.trim().split("\n").filter(Boolean).map((line) => {
      const [paneId, coord, ...cwdParts] = line.split(" ");
      return { paneId, coord, cwd: cwdParts.join(" ") };
    });
  } catch {
    return;
  }

  // Whatever the previous snapshot recorded, so a pane that came back in $HOME can't
  // overwrite a real repo path with it (see pickSavedCwd).
  const previousCwdBySession = new Map<string, string>();
  try {
    const prior = JSON.parse(await Bun.file(RESURRECT_SESSIONS_PATH).text()) as ResurrectSessionMap;
    for (const entry of Object.values(prior.sessions ?? {})) {
      previousCwdBySession.set(entry.sessionId, entry.cwd);
    }
  } catch {
    // no prior map (first save) or unreadable — every pane cwd is taken as-is
  }

  // Build coordinate→sessionId map from paneSessions (keyed by pane ID)
  const sessions: Record<string, ResurrectSessionEntry> = {};
  for (const { paneId, coord, cwd } of paneCoords) {
    const sessionId = paneSessions[paneId];
    if (sessionId) {
      sessions[coord] = { sessionId, cwd: pickSavedCwd(cwd, previousCwdBySession.get(sessionId)) };
    }
  }

  if (Object.keys(sessions).length === 0) return;

  const map: ResurrectSessionMap = {
    savedAt: new Date().toISOString(),
    sessions,
  };

  try {
    await Bun.$`mkdir -p ${PATHS.dir}`.quiet();
    await Bun.write(RESURRECT_SESSIONS_PATH, JSON.stringify(map, null, 2));
  } catch {
    // Non-fatal — running in hook context
  }
}

// ---------------------------------------------------------------------------
// claude0 restore-sessions  (tmux-resurrect post-restore hook)
// ---------------------------------------------------------------------------

/**
 * Restore Claude Code sessions after tmux-resurrect restores panes.
 *
 * Reads the coordinate→sessionId mapping saved by `claude0 save-sessions`,
 * matches coordinates to newly created panes, and launches
 * `claude --resume=<id>` in each via tmux send-keys.
 *
 * Designed to be called by tmux-resurrect's @resurrect-hook-post-restore-all.
 * Can also be run manually after a restore.
 */
export async function restoreSessions(): Promise<void> {
  if (!(await onDefaultTmuxServer())) return; // scratch server — see onDefaultTmuxServer
  // Read saved mapping
  let map: ResurrectSessionMap;
  try {
    const raw = await Bun.file(RESURRECT_SESSIONS_PATH).text();
    map = JSON.parse(raw);
  } catch {
    console.log("No saved session map found. Run 'claude0 save-sessions' first or configure the tmux-resurrect hook.");
    return;
  }

  if (!map.sessions || Object.keys(map.sessions).length === 0) {
    console.log("No Claude sessions to restore.");
    return;
  }

  // Get current panes with their coordinates
  let paneCoords: Array<{ paneId: string; coord: string; cwd: string }>;
  try {
    const output = await Bun.$`tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index} #{pane_current_path}'`
      .quiet()
      .text();
    paneCoords = output.trim().split("\n").filter(Boolean).map((line) => {
      const [paneId, coord, ...cwdParts] = line.split(" ");
      return { paneId, coord, cwd: cwdParts.join(" ") };
    });
  } catch {
    console.error("Failed to list tmux panes.");
    return;
  }

  // Match coordinates and launch claude in matching panes
  let restored = 0;
  let skipped = 0;
  // A session id can sit at two coordinates (e.g. it was resumed into a second pane before
  // the last save). Resuming it twice leaves two processes fighting over one transcript.
  const launched = new Set<string>();

  for (const { paneId, coord } of paneCoords) {
    const entry = map.sessions[coord];
    if (!entry) continue;
    if (launched.has(entry.sessionId)) {
      skipped++;
      continue;
    }

    // Verify the pane is a shell (not already running something).
    // Check if there's a foreground process other than the shell.
    try {
      const cmd = (await Bun.$`tmux display-message -t ${paneId} -p '#{pane_current_command}'`.quiet().text()).trim();
      if (cmd && !SHELL_NAMES.includes(cmd)) {
        skipped++;
        continue;
      }
    } catch {
      skipped++;
      continue;
    }

    // Launch claude --resume in this pane, in the session's own directory. A restored pane
    // starts wherever the shell drops it (often $HOME), and resuming there roots Claude at
    // $HOME. `;` rather than `&&` so a `cd` that somehow fails still leaves the session
    // resumed — degraded, not missing.
    // Resolving the directory touches the filesystem (and may consolidate a moved transcript).
    // A throw here must cost this one pane its cwd, not abort the loop and leave every later
    // pane unrestored — so it degrades to the bare resume this command has always done.
    const dir = await resolveRestoreTarget(entry.sessionId, entry.cwd).catch(() => null);
    const cmd = dir
      ? `cd ${shellQuote(dir)}; claude --resume=${entry.sessionId}`
      : `claude --resume=${entry.sessionId}`;
    try {
      await Bun.$`tmux send-keys -t ${paneId} ${cmd} Enter`.quiet();
      launched.add(entry.sessionId);
      restored++;
    } catch {
      skipped++;
    }
  }

  if (restored > 0) {
    console.log(`Restored ${restored} Claude session${restored !== 1 ? "s" : ""}.`);
  }
  if (skipped > 0) {
    console.log(`Skipped ${skipped} pane${skipped !== 1 ? "s" : ""} (already running or inaccessible).`);
  }
  if (restored === 0 && skipped === 0) {
    console.log("No matching panes found for saved sessions.");
  }
}

// ---------------------------------------------------------------------------
// claude0 resurrect save|restore  (tmux.service ExecStartPost / monitor unit save)
// ---------------------------------------------------------------------------

/**
 * Run tmux-resurrect's own save/restore script from whichever install this
 * machine has — user-managed (TPM) first, claude0-owned clone as fallback — so
 * the systemd units don't hardcode a plugin path. The script fires resurrect's
 * @resurrect-hook-* options itself, which is how `claude0 save-sessions` /
 * `restore-sessions` (the Claude session map — a separate concern) keep firing.
 * Exit code passes through.
 */
export async function resurrect(action?: string): Promise<void> {
  if (action !== "save" && action !== "restore") {
    console.error("usage: claude0 resurrect save|restore");
    process.exit(2);
  }
  const resurrectHome = process.env.CLAUDE0_HOME ?? homedir();
  const resolved = await resolveResurrect(resurrectHome, await resurrectOptionSet());
  const { path } = resolved;
  if (!path) {
    console.error(
      resolved.source === "user-elsewhere"
        ? "tmux-resurrect is configured at a non-standard location claude0 can't invoke."
        : "tmux-resurrect not found — run `claude0 setup` to install it.",
    );
    process.exit(1);
  }
  const child = Bun.spawn(resurrectCommand(path, action), {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
}

// ---------------------------------------------------------------------------
// claude0 question-hook (invoked by pretooluse.sh for an intercepted AskUserQuestion)
// ---------------------------------------------------------------------------

/**
 * `claude0 question-hook` — invoked by `pretooluse.sh` ONLY for an intercept-eligible
 * AskUserQuestion (tracked pane + live phone + not focused).
 * Reads the hook stdin, registers a `pending/<session_id>.json` (kind:"question")
 * marker so both surfaces know a question is held, then block-polls
 * `decisions/<session_id>.json` for a matching decision (every 500ms, to the end of the
 * question window). Four outcomes: an answer emits `updatedInput.answers` (keyed by
 * question text) so Claude resolves the tool with no native widget; a `clarify` decision
 * ("Chat about this") denies the tool so the agent yields the turn and waits for a typed
 * message; the user returning to the Mac releases the hold (exit 0 neutral → the native
 * picker renders in front of them); expiry exits 0 neutral the same way. The native
 * picker no longer times out on its own (verified on Claude Code 2.1.217 — see ADR 8),
 * so a fallen-through question waits indefinitely and stays answerable from both
 * surfaces. stdin is parsed with JSON.parse, not shell greps — arbitrary question/label
 * text needs real JSON escaping.
 */
export async function questionHook(): Promise<void> {
  let input: any;
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    process.exit(0); // unreadable stdin → neutral (native widget)
  }
  const sessionId: string = input?.session_id ?? "";
  const toolUseId: string = input?.tool_use_id ?? "";
  const questions = input?.tool_input?.questions;
  if (!sessionId || !toolUseId || !Array.isArray(questions)) process.exit(0);

  const pendingFile = `${PENDING_DIR}/${sessionId}.json`;
  const decisionFile = `${DECISIONS_DIR}/${sessionId}.json`;
  try {
    mkdirSync(PENDING_DIR, { recursive: true });
    writeFileSync(
      pendingFile,
      JSON.stringify({
        sessionId,
        ts: Date.now(),
        // Liveness stamp: once this process is gone the hold is abandoned and the
        // question has fallen through to the native widget, so answers must be sent as
        // keystrokes rather than written to `decisions/` where nobody is polling.
        pid: process.pid,
        kind: "question",
        tool_use_id: toolUseId,
        tool: "AskUserQuestion",
      }),
    );
  } catch {
    process.exit(0); // can't register the hold → neutral
  }

  // Poll to a DEADLINE, not an iteration count: per-pass IO makes a counted loop overrun
  // the window, so it'd still be polling when the hook timeout kills it — and the cleanup
  // below, which un-registers the hold, would never run.
  const paneId = process.env.TMUX_PANE ?? "";
  let lastFocusCheck = 0;
  const deadline = Date.now() + QUESTION_HOLD_MS;
  while (Date.now() < deadline) {
    // Focus-release: the moment the user is back at the Mac, stop holding and exit
    // neutral so the native picker renders in front of them (~1s). Checked AFTER the
    // decision read below on the previous iteration, so an answer that raced the
    // user's return has already won. Throttled to ~1s — atDeskFocus shells out to
    // tmux. Probe ambiguity keeps holding (see atDeskFocus polarity).
    if (paneId && Date.now() - lastFocusCheck >= 1_000) {
      lastFocusCheck = Date.now();
      if (await atDeskFocus(paneId)) {
        rmSync(pendingFile, { force: true });
        process.exit(0);
      }
    }
    try {
      const raw = JSON.parse(readFileSync(decisionFile, "utf8"));
      if (raw.kind === "question" && raw.tool_use_id === toolUseId) {
        rmSync(decisionFile, { force: true });
        rmSync(pendingFile, { force: true });
        if (raw.clarify === true) {
          // "Chat about this": deny the tool so the agent yields the turn and waits for
          // the user's message, instead of picking an option (mirrors the native widget).
          const asked = questions.map((q: any) => `- "${q.question}"`).join("\n");
          const reason =
            "The user wants to discuss these questions before answering, rather than pick one of the " +
            "offered options. Do NOT re-ask or restate the question yet. Wait for the user's next " +
            "message and take it into account before proceeding.\n\nQuestions asked:\n" +
            asked;
          process.stdout.write(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: reason,
              },
            }),
          );
          process.exit(0);
        }
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              updatedInput: { questions, answers: raw.answers ?? {} },
            },
          }),
        );
        process.exit(0);
      }
    } catch {
      // no decision yet (or a torn/mismatched file) — keep waiting
    }
    await Bun.sleep(500);
  }

  rmSync(pendingFile, { force: true });
  process.exit(0); // timeout → neutral → native-widget floor
}

// ---------------------------------------------------------------------------
// claude0 daemon
// ---------------------------------------------------------------------------

/**
 * Long-lived inbox daemon (launchd-kept-alive, installed by `claude0 setup`).
 * Owns the snooze wake pass — the status-right monitor can't: tmux only
 * evaluates the status line while a client is attached, so a midnight wake
 * with no terminal open would never fire from there. `--once` runs a single
 * pass and exits (debugging / manual catch-up).
 */
export async function daemon(): Promise<void> {
  const { InboxStore } = await import("./core/inbox-store");

  // Internal: one discovery pass in a fresh process (the long-lived loop only
  // spawns and reaps — in-process discovery leaks; see inbox-discovery.ts).
  if (process.argv.includes("--discover-once")) {
    const { discoveryTick } = await import("./core/inbox-discovery");
    const store = new InboxStore();
    try {
      await discoveryTick(store);
    } finally {
      store.close();
    }
    return;
  }

  const { wakePass } = await import("./core/inbox-wake");

  // Populate the config cache once for the daemon's lifetime: the sidebar
  // renderer's rows read ui.repoAbbreviations and its tmux wiring reads tmux.keys.
  await loadConfig().catch(() => null);

  // `--once`: a single wake pass (debugging / manual catch-up).
  if (process.argv.includes("--once")) {
    const store = new InboxStore();
    try {
      await wakePass(store);
    } finally {
      store.close();
    }
    return;
  }

  // The sidebar renderer runs inside this process (own 1s loop + unix
  // socket). A second daemon would steal that socket from the live one
  // (the renderer unlinks and rebinds it), so refuse if a renderer answers.
  const { runSidebarRenderer, SIDEBAR_SOCK } = await import("./sidebar/renderer");
  const rendererAlive = await Bun.connect({
    unix: SIDEBAR_SOCK,
    socket: { data() {} },
  }).then(
    (sock) => {
      sock.end();
      return true;
    },
    () => false, // no socket file, or a stale one with no listener
  );
  if (rendererAlive) {
    console.error("claude0 daemon is already running (launchd/systemd manages it) — not starting a second instance.");
    process.exit(1);
  }
  runSidebarRenderer();

  let tick = 0;
  let lastResurrectSave = Date.now();
  while (true) {
    try {
      const child = Bun.spawn(
        [process.execPath, process.argv[1]!, "daemon", "--discover-once"],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
      // a wedged tmux/ps call must not pile up children behind it
      const killer = setTimeout(() => child.kill(), 15_000);
      await child.exited;
      clearTimeout(killer);
    } catch {}
    if (tick % 5 === 0) {
      try {
        const store = new InboxStore();
        try {
          await wakePass(store);
        } finally {
          store.close();
        }
      } catch {
        // tmux down (server not started yet) or db busy — next pass retries
      }
    }
    // Periodic tmux-resurrect layout save. On linux the monitor unit owns this
    // loop; a darwin local install has no unit, so it hangs off the daemon tick
    // instead — making continuum unnecessary on both platforms.
    if (Date.now() - lastResurrectSave >= RESURRECT_SAVE_INTERVAL_MS) {
      lastResurrectSave = Date.now();
      // not awaited: the option probe talks to tmux, and a wedged server must
      // not stall discovery and wake passes behind it
      void periodicResurrectSave();
    }
    tick++;
    await Bun.sleep(3_000);
  }
}

/** Best-effort, fire-and-forget save (see daemonSaveCommand). Never throws. */
async function periodicResurrectSave(): Promise<void> {
  if (process.env.CLAUDE0_HOME) return; // test seam — never probe or spawn from tests
  if (process.platform !== "darwin") return; // linux: the monitor unit owns the save loop
  try {
    const resolved = await resolveResurrect(homedir(), await resurrectOptionSet());
    const argv = daemonSaveCommand(resolved, process.platform);
    if (!argv) return;
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    // a wedged save.sh must not accumulate one orphaned bash per interval
    const killer = setTimeout(() => child.kill(), 60_000);
    killer.unref?.();
    child.exited.finally(() => clearTimeout(killer));
  } catch {}
}

// ---------------------------------------------------------------------------
// claude0 sidebar-pane / sidebar-ctl  (M2 single-renderer chassis)
// ---------------------------------------------------------------------------

/** One-shot control message to the renderer (M-s focus / M-S toggle bindings). */
export async function sidebarCtl(cmd: string | undefined, paneId: string | undefined): Promise<void> {
  if ((cmd !== "focus" && cmd !== "toggle") || !paneId) return;
  const sock = `${PATHS.dir}/sidebar.sock`;
  try {
    await new Promise<void>((resolve) => {
      Bun.connect({
        unix: sock,
        socket: {
          open(s) {
            s.write(`${cmd} ${paneId}\n`);
            s.flush();
            setTimeout(() => {
              s.end();
              resolve();
            }, 50);
          },
          data() {},
          error() {
            resolve();
          },
          close() {
            resolve();
          },
        },
      }).catch(() => resolve());
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// claude0 bridge token — print the bridge login token for phone pairing
// ---------------------------------------------------------------------------

export async function bridgeToken(): Promise<void> {
  const path = `${PATHS.dir}/bridge.env`;
  const env = await Bun.file(path)
    .text()
    .catch(() => null);
  const token = env === null ? undefined : envValue(env, "CLAUDE0_BRIDGE_TOKEN");
  if (!token) {
    console.error(`No bridge token in ${path} — run \`claude0 setup --role host\` on the host first.`);
    process.exit(2);
  }
  console.log(token);
}

// ---------------------------------------------------------------------------
// claude0 notify <message> — broadcast a web push to every subscribed device
// ---------------------------------------------------------------------------

/**
 * Operational alert channel for headless automation (e.g. a systemd OnFailure /
 * staleness timer pushing "backups are stale" to the phone). Broadcasts to ALL
 * subscribed devices — deliberately unlike session pushes, which target only the
 * device that drove the turn: an ops failure has no driving device.
 */
export async function notify(message: string): Promise<void> {
  if (!message.trim()) {
    console.error("usage: claude0 notify <message>");
    process.exit(2);
  }
  // Populate the config cache so resolveVapidContact sees notifications.pushContact.
  await loadConfig().catch(() => null);
  const { listDeviceIds, sendWebPush } = await import("./core/web-push");
  const ids = listDeviceIds();
  if (ids.length === 0) {
    console.error("claude0: no push subscriptions — nothing to notify");
    process.exit(1);
  }
  // Empty sessionId on purpose: it keeps the push out of the tap-attribution ledger
  // (a tap must NOT navigate to a session — there is none behind an ops alert; the
  // service worker falls back to a shared "c0" tag so repeats still collapse).
  await Promise.all(ids.map((id) => sendWebPush(id, { title: "Claude0", body: message, sessionId: "" })));
  console.log(`claude0: pushed to ${ids.length} device(s)`);
}
