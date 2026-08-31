/**
 * Claude0 Monitor — single state authority for tmux status-right.
 *
 * Called by tmux every `status-interval` seconds (e.g. 5s).
 * Phase 1 (fast, ~50ms): Detect transitions, manage attention, sync prefixes, output status.
 * Phase 2 (after stdout): Process hook events, detect /clear, generate AI names.
 */

import { listPanes, capturePane, renameWindow } from "./core/tmux";
import { findClaudeProcesses } from "./core/process";
import { detectStatus, type SessionStatus } from "./core/status";
import { eventSourcedStatus } from "./core/hook-events";
import { nativeStatus, resolveStatus } from "./core/session-state";
import { reapDeadSessionFiles } from "./core/approval";
import { loadConfig, configCache } from "./core/config";
import { debugLog } from "./core/debug";
import { loadState, saveState, computeAggregate, buildSessionStates, loadPaneSessions, savePaneSessions, processHookEvents } from "./core/state";
import { detectTransitions, dispatchNotifications, dispatchHeldApprovalPushes, syncWindowPrefix, ATTENTION_PREFIX, RUNNING_PREFIX, SCRIPT_PREFIX, stripAllPrefixes, desiredPrefix, buildBaseName, abbreviateRepo, NAME_SEPARATOR } from "./core/notifications";
import { clearSource } from "./core/input-source";
import { classifyActivity } from "./core/presence";
import { detectScriptWaits } from "./core/script-wait";
import { getBaseRepoPath } from "./core/git";
import { repoNameFromPath } from "./core/sessions";
import { loadNameCache, saveNameCache, generateAIName, getSessionName, slugify, acquireNamingLock, releaseNamingLock, pruneNameCacheIfLarge, loadNamingSkips, setNamingSkip, needsNaming, inNamingCooldown, type NameCache } from "./core/names";
import { disambiguateByRepo } from "./core/session-label";
import { findActiveSessionInfo, readNamingExtras } from "./core/sessions";
import { homedir } from "os";
import type { Session, AggregateStatus, PaneInfo, ClaudeProcess } from "./types";

// ---------------------------------------------------------------------------
// Debug logging — only active when ~/.config/claude0/debug.log exists
// (shared logger in core/debug.ts; see debugLog import)
// ---------------------------------------------------------------------------

/**
 * Quick-discover active Claude sessions. Much lighter than discoverSessions() —
 * skips index files, archive scanning, lsof, git branch, name resolution.
 * Only needs: which panes have Claude, what status are they in.
 * Returns sessions with their current status and all tmux panes.
 */
async function quickDiscoverActive(
  paneSessionMap: Record<string, string>,
): Promise<{ sessions: Session[]; allPanes: PaneInfo[]; resumeIds: Record<string, string>; forkPaneIds: Set<string> }> {
  const [panes, processes] = await Promise.all([
    listPanes(),
    findClaudeProcesses(),
  ]);

  // Build TTY→process map (prefer processes with sessionId from --resume flag)
  const claudeTtyMap = new Map<string, ClaudeProcess>();
  for (const proc of processes) {
    const existing = claudeTtyMap.get(proc.tty);
    if (!existing || proc.sessionId) {
      claudeTtyMap.set(proc.tty, proc);
    }
  }

  // Find panes with Claude processes and collect --resume session IDs
  const claudePanes: PaneInfo[] = [];
  const resumeIds: Record<string, string> = {};
  const forkPaneIds = new Set<string>();
  for (const pane of panes) {
    const normalizedTty = pane.tty.replace(/^\/dev\//, "");
    const proc = claudeTtyMap.get(normalizedTty);
    if (proc) {
      claudePanes.push(pane);
      if (proc.isFork) forkPaneIds.add(pane.paneId);
      if (proc.sessionId) {
        resumeIds[pane.paneId] = proc.sessionId;
      }
    }
  }

  // Capture and detect status for each pane in parallel
  const sessions = await Promise.all(
    claudePanes.map(async (pane): Promise<Session> => {
      const captured = await capturePane(pane.paneId);
      // Strip ANSI for status detection
      const plain = captured
        .replace(/\x1b\[[0-9;?]*[\x40-\x7e]/g, "")
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      const scraper = detectStatus(plain, true);

      // Status resolution order: Claude's native status file › event-sourced hook
      // log › scraper. Keeps the monitor (sole window-naming authority) aligned
      // with the TUI so ⚡/🔄 prefixes track Claude's real state (Inc7). A fork's
      // native-resolved id (resumeIds) wins over the hook map, which holds the
      // parent id — otherwise the fork renders the parent's running status.
      const sessionId = forkPaneIds.has(pane.paneId)
        ? (resumeIds[pane.paneId] ?? paneSessionMap[pane.paneId])
        : (paneSessionMap[pane.paneId] ?? resumeIds[pane.paneId]);
      const native = sessionId ? await nativeStatus(sessionId) : null;
      const eventStatus = sessionId ? await eventSourcedStatus(sessionId) : null;
      const resolved = resolveStatus(native, eventStatus, scraper.status);

      const baseRepoPath = await getBaseRepoPath(pane.currentPath);
      return {
        id: sessionId ?? "",
        repo: repoNameFromPath(baseRepoPath),
        repoPath: pane.currentPath,
        baseRepoPath,
        branch: "",
        status: resolved.status,
        statusSource: resolved.source,
        messageCount: 0,
        summary: "",
        modified: new Date(),
        firstPrompt: "",
        lastPrompt: "",
        name: stripAllPrefixes(pane.windowName),
        lastCapture: plain,
        tmuxPane: {
          paneId: pane.paneId,
          windowIndex: pane.windowIndex,
          sessionName: pane.sessionName,
          windowName: pane.windowName,
        },
      };
    }),
  );
  return { sessions, allPanes: panes, resumeIds, forkPaneIds };
}

function formatStatus(aggregate: AggregateStatus): string {
  const parts: string[] = [];
  if (aggregate.needsAttention > 0) parts.push(`⚡ ${aggregate.needsAttention}`);
  if (aggregate.running > 0) parts.push(`🔄 ${aggregate.running}`);
  return parts.join(" ");
}

async function main(): Promise<void> {
  const [config, state, paneSessionMap, nameCache] = await Promise.all([
    // An invalid config must not kill the monitor tick — status-right would go
    // blank until the file is fixed. Degrade to defaults and say so on stderr.
    loadConfig().catch((error: unknown) => {
      console.error(`claude0 status: ${error instanceof Error ? error.message : String(error)} — using defaults`);
      return configCache();
    }),
    loadState(),
    loadPaneSessions(),
    loadNameCache(),
  ]);

  // Auto-clear: sync prefix on the window the user is currently viewing,
  // but ONLY when the user is actually at the terminal (a client keystroke
  // inside the presence window). Otherwise the user isn't looking — keep
  // attention flags and ⚡ prefix so notifications still fire.
  let activePaneId: string | undefined;
  let activeWindow: string | undefined;
  let activeSession: string | undefined;
  let terminalFocused = false;
  try {
    // Most recently active client decides presence AND supplies the viewed window.
    // With 2+ clients attached (desk + a stray phone SSH), an arbitrary pick could
    // read an idle client's activity as the user's — presence is max across clients.
    const clients = (await Bun.$`tmux list-clients -F '#{client_activity} #{client_name}'`.quiet().text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort((a, b) => Number(b.split(" ")[0]) - Number(a.split(" ")[0]));
    const client = clients[0]?.slice(clients[0].indexOf(" ") + 1);
    if (client) {
      // client_activity leads the format (window_name may itself contain colons, so it
      // must stay the greedy tail) and rides the same display-message call — no extra fork.
      const info = (await Bun.$`tmux display-message -c ${client} -p '#{client_activity}:#{pane_id}:#{window_index}:#{session_name}:#{window_name}'`.quiet().text()).trim();
      const colonIdx0 = info.indexOf(":");
      const colonIdx1 = info.indexOf(":", colonIdx0 + 1);
      const colonIdx2 = info.indexOf(":", colonIdx1 + 1);
      const colonIdx3 = info.indexOf(":", colonIdx2 + 1);
      const clientActivity = info.slice(0, colonIdx0);
      activePaneId = info.slice(colonIdx0 + 1, colonIdx1);
      activeWindow = info.slice(colonIdx1 + 1, colonIdx2);
      activeSession = info.slice(colonIdx2 + 1, colonIdx3);
      const activeWindowName = info.slice(colonIdx3 + 1);

      // Presence = this client's last keystroke inside the window. "unknown" maps to
      // focused — a broken probe must not spray attention/pushes at the active pane.
      terminalFocused = classifyActivity([Number(clientActivity)], Date.now()) !== "absent";

      // Only auto-clear ⚡ when the user is actually looking at the terminal
      if (terminalFocused && activeWindowName?.startsWith(ATTENTION_PREFIX)) {
        const otherPanesHaveAttention = Object.values(state.sessions).some(
          (s) =>
            s.needsAttention &&
            s.tmuxPane !== activePaneId &&
            s.tmuxSession === activeSession &&
            String(s.tmuxWindow) === activeWindow,
        );
        const anyRunning = Object.values(state.sessions).some(
          (s) =>
            s.tmuxSession === activeSession &&
            String(s.tmuxWindow) === activeWindow &&
            s.status === "running",
        );
        await debugLog(`auto-clear ⚡ on active window ${activeSession}:${activeWindow} (${activeWindowName})`);
        await syncWindowPrefix(activeSession!, parseInt(activeWindow!, 10), otherPanesHaveAttention, anyRunning);
      }
    }
  } catch {
    // Not in tmux context
  }

  // Quick poll active sessions (event-sourced status when a hook log exists)
  const { sessions, allPanes, resumeIds, forkPaneIds } = await quickDiscoverActive(paneSessionMap);
  await debugLog(`discovered ${sessions.length} sessions: ${sessions.map((s) => `${s.tmuxPane!.paneId}=${s.status}`).join(", ") || "(none)"}`);

  // Seed paneSessionMap with --resume IDs as fallbacks (don't overwrite hook events,
  // which are more authoritative — e.g. after /clear the process still has stale --resume <old-id>)
  for (const [paneId, sessionId] of Object.entries(resumeIds)) {
    if (!paneSessionMap[paneId]) {
      paneSessionMap[paneId] = sessionId;
    }
  }

  // Process hook events early (before prefix sync) so /clear renames happen in the same cycle.
  // This prevents the prefix sync from re-applying a stale AI name from the old session.
  const { changed: hookChanged, changedPaneIds: clearPaneIds } = await processHookEvents(paneSessionMap);
  if (hookChanged) {
    await debugLog(`hook events processed (early), changed panes: ${[...clearPaneIds].join(", ") || "(new only)"}`);
  }

  // Fork override — MUST run after processHookEvents (which just re-imposed the hook's
  // parent id from disk onto fork panes). Force the fork's real, native-resolved id and
  // remember we changed the map so phase2 persists it (overwriting the wrong on-disk pane
  // file), self-healing `claude0 list`, the TUI and the bridge on the next read.
  let forkCorrected = false;
  for (const paneId of forkPaneIds) {
    const realId = resumeIds[paneId];
    if (realId && paneSessionMap[paneId] !== realId) {
      paneSessionMap[paneId] = realId;
      forkCorrected = true;
    }
  }

  // Rebuild previous statuses from saved state
  const previousStatuses = new Map<string, SessionStatus>();
  for (const [key, s] of Object.entries(state.sessions)) {
    previousStatuses.set(key, s.status as SessionStatus);
  }

  // Detect transitions
  const transitions = detectTransitions(previousStatuses, sessions);
  for (const t of transitions) {
    await debugLog(`transition ${t.sessionKey}: ${t.previousStatus}→${t.currentStatus} (${t.classification})`);
  }

  // Carry over existing attention flags from state
  const needsAttention = new Set<string>();
  const attentionTypes = new Map<string, "blocked" | "turnComplete">();
  // Build a quick lookup of current statuses
  const currentStatusMap = new Map(sessions.map((s) => [s.tmuxPane!.paneId, s.status]));
  for (const [key, s] of Object.entries(state.sessions)) {
    if (s.needsAttention) {
      const currentStatus = currentStatusMap.get(key);
      // Clear stale attention: if session went back to running, user already interacted
      if (currentStatus === "running") {
        await debugLog(`carry-over ${key}: cleared (now running)`);
        continue;
      }
      // Clear if pane no longer exists
      if (!currentStatus) {
        await debugLog(`carry-over ${key}: cleared (pane gone)`);
        continue;
      }
      await debugLog(`carry-over ${key}: preserved (status=${currentStatus})`);
      needsAttention.add(key);
      if (s.attentionType) attentionTypes.set(key, s.attentionType);
    }
  }

  // Add new attention from transitions. Exclude the active pane only when the
  // terminal is focused — the user is actually looking at it. When unfocused,
  // the active pane should still get attention + notifications.
  const notable = transitions.filter(
    (e) => e.classification !== "none" && !(terminalFocused && e.sessionKey === activePaneId),
  );
  for (const event of notable) {
    needsAttention.add(event.sessionKey);
    attentionTypes.set(event.sessionKey, event.classification as "blocked" | "turnComplete");
  }

  // Clear attention for the specific pane the user is focused on, but only
  // when the terminal is focused — otherwise the user isn't actually looking
  if (activePaneId && terminalFocused) {
    needsAttention.delete(activePaneId);
    attentionTypes.delete(activePaneId);
    // Mac takeover: the user is looking at this pane, so the session is theirs at
    // the desk now — drop any portkey source marker so later transitions don't
    // push to a phone. paneSessionMap is the authoritative pane→id source here
    // (hook events processed + fork-corrected above; a session object's own id
    // can lag it).
    const takenOver = paneSessionMap[activePaneId];
    if (takenOver) clearSource(takenOver);
  }

  // Dispatch notifications only for sessions that still have attention
  const notableWithAttention = notable.filter((e) => needsAttention.has(e.sessionKey));
  if (notableWithAttention.length > 0) {
    await dispatchNotifications(notableWithAttention, {
      statusMonitor: config.ui.statusMonitor,
      windowPrefix: config.ui.windowPrefix,
      nativeNotification: config.notifications.native,
      terminalBundleId: config.notifications.terminalBundleId,
    }, nameCache);
  }

  // Approvals HELD by the PreToolUse hook never render the pane picker, so the
  // status stays `running` and no transition can push for them — tell the driving
  // phone directly (once per hold, skipped while it watches via SSE).
  await dispatchHeldApprovalPushes(sessions, nameCache);

  // Script-wait detection: a ready session may still be driving a run_in_background
  // script (the turn genuinely ends while the runner lives — pr-triage waits this way
  // for tens of minutes). Visibility only: feeds the ⏳ window prefix, never
  // notifications, attention, or the status-right counts. paneSessionMap is consulted
  // first — quickDiscoverActive resolved ids before hook events / fork correction.
  const sidOf = (s: Session): string =>
    (s.tmuxPane ? paneSessionMap[s.tmuxPane.paneId] : undefined) ?? s.id;
  const readyIds = [...new Set(sessions.filter((s) => s.status === "ready" && sidOf(s)).map(sidOf))];
  const scriptWaitIds = readyIds.length > 0 ? await detectScriptWaits(readyIds) : new Set<string>();
  if (scriptWaitIds.size > 0) {
    await debugLog(`script-wait: ${[...scriptWaitIds].join(", ")}`);
  }

  // Sync prefixes on tmux window names.
  // Group sessions by window, compute desired prefix + name-aware base name.
  const windowMap = new Map<string, { sessionName: string; windowIndex: number; windowName: string; hasAttention: boolean; hasRunning: boolean; hasScriptWait: boolean; paneIds: string[] }>();
  for (const session of sessions) {
    if (!session.tmuxPane) continue;
    const hasScriptWait = session.status === "ready" && scriptWaitIds.has(sidOf(session));
    const wKey = `${session.tmuxPane.sessionName}:${session.tmuxPane.windowIndex}`;
    const existing = windowMap.get(wKey);
    if (existing) {
      if (needsAttention.has(session.tmuxPane.paneId)) existing.hasAttention = true;
      if (session.status === "running") existing.hasRunning = true;
      if (hasScriptWait) existing.hasScriptWait = true;
      existing.paneIds.push(session.tmuxPane.paneId);
    } else {
      windowMap.set(wKey, {
        sessionName: session.tmuxPane.sessionName,
        windowIndex: session.tmuxPane.windowIndex,
        windowName: session.tmuxPane.windowName,
        hasAttention: needsAttention.has(session.tmuxPane.paneId),
        hasRunning: session.status === "running",
        hasScriptWait,
        paneIds: [session.tmuxPane.paneId],
      });
    }
  }
  const dnMap = buildRepoDnMap(sessions, paneSessionMap, nameCache);

  for (const win of windowMap.values()) {
    const prefix = desiredPrefix(win.hasAttention, win.hasRunning, win.hasScriptWait);

    // Resolve repo name(s) for this window's panes
    const paneRepos = win.paneIds.map(id => {
      const s = sessions.find(s => s.tmuxPane?.paneId === id);
      return s ? repoNameFromPath(s.baseRepoPath) : "unknown";
    });
    const uniqueRepos = [...new Set(paneRepos)].filter(r => r !== "unknown");
    const repo = uniqueRepos.length > 0 ? uniqueRepos[0] : "unknown";

    let baseName: string;

    // If any pane in this window just had /clear, reset to repo name
    const hasCleared = win.paneIds.some(id => clearPaneIds.has(id));
    if (hasCleared) {
      baseName = abbreviateRepo(repo);
    } else if (win.paneIds.length === 1) {
      // Single-pane: {repo}/{ai-name} or just {repo}
      const sessionId = paneSessionMap[win.paneIds[0]];
      const aiName = sessionId ? (dnMap.get(sessionId) ?? getSessionName(sessionId, nameCache)) : undefined;
      baseName = buildBaseName(repo, aiName ? slugify(aiName) || undefined : undefined);
    } else {
      // Multi-pane: show all unique repos joined with "+"
      baseName = uniqueRepos.length > 1
        ? uniqueRepos.map(abbreviateRepo).join("+")
        : abbreviateRepo(repo);
    }

    const desired = `${prefix}${baseName}`;
    if (win.windowName !== desired) {
      await debugLog(`prefix-sync ${win.sessionName}:${win.windowIndex}: "${win.windowName}" → "${desired}"`);
      await renameWindow(win.sessionName, win.windowIndex, desired);
    }
  }

  // Strip stale ⚡/🔄 prefixes from windows that no longer have Claude sessions.
  // When a session exits, its window is invisible to the sync loop above.
  for (const pane of allPanes) {
    const wKey = `${pane.sessionName}:${pane.windowIndex}`;
    if (!windowMap.has(wKey) && pane.windowName !== stripAllPrefixes(pane.windowName)) {
      const baseName = stripAllPrefixes(pane.windowName);
      await debugLog(`stale-prefix ${pane.sessionName}:${pane.windowIndex}: "${pane.windowName}" → "${baseName}"`);
      await renameWindow(pane.sessionName, pane.windowIndex, baseName);
    }
  }

  // Save state — but first check if another process (claude0 next) modified state
  // since we loaded it. If so, don't overwrite their changes.
  const freshState = await loadState();
  if (freshState.lastUpdatedAt !== state.lastUpdatedAt) {
    await debugLog(`freshState bail: state modified by another process during poll`);
    const aggregate = computeAggregate(freshState);
    process.stdout.write(formatStatus(aggregate));
    // Still run Phase 2 (lsof + naming) — it writes to separate files
    phase2(sessions, paneSessionMap, nameCache, hookChanged || forkCorrected).catch(() => {});
    return;
  }

  await debugLog(`saving: needsAttention={${[...needsAttention].join(", ")}}`);
  const sessionStates = buildSessionStates(sessions, needsAttention, attentionTypes, state.sessions);
  const newState = { lastUpdatedBy: "monitor" as const, lastUpdatedAt: Date.now(), sessions: sessionStates };
  await saveState(newState);

  // Output status text to stdout — tmux renders this in the status bar
  const aggregate = computeAggregate(newState);
  process.stdout.write(formatStatus(aggregate));

  // Phase 2: hook events + AI naming (runs after stdout, doesn't block tmux)
  phase2(sessions, paneSessionMap, nameCache, hookChanged || forkCorrected).catch(() => {});
}

/**
 * Phase 2 — runs after stdout output so tmux doesn't wait.
 * Hook events are already processed in Phase 1. This handles pane cleanup and AI naming.
 */
/**
 * Per-repo name disambiguation over every live named session — keyed on sessionId
 * and fed the same per-repo session set the bridge uses, so tmux and the phone
 * assign identical " 2"/" 3" suffixes.
 */
function buildRepoDnMap(
  sessions: Session[],
  paneSessionMap: Record<string, string>,
  cache: NameCache,
): Map<string, string> {
  const items: Array<{ id: string; name: string; repo: string }> = [];
  for (const s of sessions) {
    if (!s.tmuxPane) continue;
    const sid = paneSessionMap[s.tmuxPane.paneId];
    if (!sid) continue;
    const nm = getSessionName(sid, cache);
    if (!nm) continue;
    items.push({ id: sid, name: nm, repo: repoNameFromPath(s.baseRepoPath) });
  }
  return disambiguateByRepo(items);
}

async function phase2(
  sessions: Session[],
  paneSessionMap: Record<string, string>,
  nameCache: NameCache,
  hookChanged: boolean,
): Promise<void> {
  const home = homedir();
  const projectsDir = `${home}/.claude/projects`;

  let mapChanged = hookChanged;

  // Clean stale pane entries (panes that no longer have sessions)
  const activePaneIds = new Set(sessions.map(s => s.tmuxPane?.paneId).filter(Boolean));
  for (const paneId of Object.keys(paneSessionMap)) {
    if (!activePaneIds.has(paneId)) {
      delete paneSessionMap[paneId];
      mapChanged = true;
    }
  }

  if (mapChanged) {
    await savePaneSessions(paneSessionMap);
  }

  // Reap on-disk files for dead sessions (Inc7 rotation). After the cleanup above,
  // the map's values are exactly the live sessions — reuse that liveness, no scan.
  reapDeadSessionFiles(new Set(Object.values(paneSessionMap)));

  // AI naming: find one session that needs a (re)name, skipping cooldowns.
  // The cooldown doubles as a post-rename guard so summary churn doesn't
  // thrash regenerations — it is not auto-cleared when a name exists.
  const namingSkips = await loadNamingSkips();

  const unnamed = sessions.find(s => {
    if (!s.tmuxPane) return false;
    const sessionId = paneSessionMap[s.tmuxPane.paneId];
    if (!sessionId || inNamingCooldown(namingSkips, sessionId, nameCache)) return false;
    return needsNaming(nameCache, sessionId, s.lastPrompt || s.summary || "");
  });

  if (unnamed?.tmuxPane) {
    const sessionId = paneSessionMap[unnamed.tmuxPane.paneId];
    if (sessionId && await acquireNamingLock()) {
      try {
        await debugLog(`phase2: generating name for session ${sessionId}`);
        const info = await findActiveSessionInfo(projectsDir, unnamed.repoPath, sessionId);
        const firstPrompt = info?.firstPrompt ?? "";
        const summary = info?.summary ?? "";
        const lastPrompt = info?.lastPrompt ?? "";
        if (firstPrompt || summary || lastPrompt) {
          // Get branch for naming context
          let branch = "";
          try { branch = (await Bun.$`git -C ${unnamed.repoPath} branch --show-current`.quiet().text()).trim(); } catch {}
          const { firstAssistant, lastAssistant } = await readNamingExtras(unnamed.repoPath, sessionId);
          const name = await generateAIName({ firstPrompt, summary, branch, lastPrompt, firstAssistant, lastAssistant });
          if (name) {
            // Reload: names the bridge wrote (or pruned) during the ≤15s claude -p
            // run must not be clobbered or resurrected by this stale in-memory copy —
            // the disk state is authoritative, plus our one new entry.
            const fresh = await loadNameCache();
            nameCache.names = fresh.names;
            nameCache.sources = fresh.sources;
            nameCache.names[sessionId] = name;
            // Store the freshest signal we used so future drift checks compare apples-to-apples
            nameCache.sources[sessionId] = lastPrompt || summary || firstPrompt;
            await pruneNameCacheIfLarge(nameCache, projectsDir);
            await saveNameCache(nameCache);
            // Cooldown — prevents re-running claude -p on every minor summary edit
            await setNamingSkip(sessionId);
            await debugLog(`phase2: named session ${sessionId} → "${name}"`);

            // Apply name to window immediately, preserving the current prefix and
            // running the same per-repo disambiguation as the sync loop so a fresh
            // collision gets its " 2" now, not one tick later.
            const currentWindowName = unnamed.tmuxPane.windowName;
            const prefix = currentWindowName.startsWith(ATTENTION_PREFIX) ? ATTENTION_PREFIX
              : currentWindowName.startsWith(RUNNING_PREFIX) ? RUNNING_PREFIX
              : currentWindowName.startsWith(SCRIPT_PREFIX) ? SCRIPT_PREFIX : "";
            const repo = repoNameFromPath(unnamed.baseRepoPath);
            const dn = buildRepoDnMap(sessions, paneSessionMap, nameCache).get(sessionId) ?? name;
            await renameWindow(unnamed.tmuxPane.sessionName, unnamed.tmuxPane.windowIndex, `${prefix}${buildBaseName(repo, slugify(dn) || undefined)}`);
          } else {
            // AI naming returned empty — skip for a while
            await setNamingSkip(sessionId);
            await debugLog(`phase2: skipping session ${sessionId} (AI returned empty name)`);
          }
        } else {
          // No session data found — skip for a while
          await setNamingSkip(sessionId);
          await debugLog(`phase2: skipping session ${sessionId} (no session data)`);
        }
      } finally {
        await releaseNamingLock();
      }
    }
  }
}

// Safety net: force-exit after 20s to prevent blocking tmux's #() command.
// If phase2 (AI naming via claude -p) hangs, tmux won't start new monitor
// invocations and the status bar goes stale.
setTimeout(() => process.exit(0), 20_000).unref();

main().catch(() => {
  // Never crash — just output nothing
});
