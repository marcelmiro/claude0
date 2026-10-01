import { readdir, unlink, rename, writeFile, mkdir } from "node:fs/promises";
import { PATHS } from "./config";
import type { AggregateStatus, State, Session, SessionNotificationState } from "../types";

// The pane→session map is hook-owned: the SessionStart hook writes one file per pane
// (`panes/<paneId>` → sessionId) atomically (temp+rename), so there's a single durable
// source of truth with no shared-file write race and no consume-once log. Every reader
// (TUI, monitor, bridge) sees the same state — fixing the old bug where a session was
// listed but unsendable because only the monitor persisted the truncate-once event log.
const PANES_DIR = `${PATHS.dir}/panes`;

/** Read the hook-owned per-pane map. Empty when the `panes/` dir doesn't exist yet. */
export async function loadPaneSessions(): Promise<Record<string, string>> {
  let files: string[];
  try {
    files = await readdir(PANES_DIR);
  } catch {
    return {};
  }
  const map: Record<string, string> = {};
  await Promise.all(files.map(async (f) => {
    if (f.endsWith(".tmp")) return; // in-flight atomic write
    try {
      const sid = (await Bun.file(`${PANES_DIR}/${f}`).text()).trim();
      if (sid) map[f] = sid;
    } catch {}
  }));
  return map;
}

/** Persist resolved pane→session entries as per-pane files (atomic temp+rename, one file per
 *  pane → no shared-file contention). Additive — never deletes; pruning is liveness-gated
 *  (`reconcilePaneFiles`). Captures fallback-resolved (--resume / window-name / mtime) panes
 *  the hook never wrote, so `resolveSessionPane` (bridge sends) can find them too. */
export async function savePaneSessions(map: Record<string, string>): Promise<void> {
  try {
    await mkdir(PANES_DIR, { recursive: true });
    await Promise.all(Object.entries(map).map(async ([paneId, sessionId]) => {
      if (!paneId || !sessionId) return;
      const dest = `${PANES_DIR}/${paneId}`;
      const tmp = `${dest}.tmp`;
      await writeFile(tmp, sessionId);
      await rename(tmp, dest);
    }));
  } catch {}
}

/** Drop per-pane files for panes that have truly left tmux, bounding dir growth. Liveness-gated
 *  on the full live-pane set (not "has a claude process") so a transient ps/tmux miss can't
 *  delete a still-live mapping — preserving the old disk-survives-a-cache-miss safety net. */
export async function reconcilePaneFiles(livePaneIds: Set<string>): Promise<void> {
  try {
    const files = await readdir(PANES_DIR);
    await Promise.all(files.map(async (f) => {
      if (f.endsWith(".tmp") || livePaneIds.has(f)) return;
      try { await unlink(`${PANES_DIR}/${f}`); } catch {}
    }));
  } catch {}
}

const EMPTY_STATE: State = {
  lastUpdatedBy: "tui",
  lastUpdatedAt: 0,
  sessions: {},
};

export async function loadState(): Promise<State> {
  try {
    const raw = await Bun.file(PATHS.state).text();
    const parsed = JSON.parse(raw);
    if (parsed.sessions && parsed.lastUpdatedBy) return parsed;
  } catch {
    // No state or malformed
  }
  return { ...EMPTY_STATE, sessions: {} };
}

export async function saveState(state: State): Promise<void> {
  try {
    await Bun.$`mkdir -p ${PATHS.dir}`.quiet();
    await Bun.write(PATHS.state, JSON.stringify(state));
  } catch {
    // Non-fatal
  }
}

export function computeAggregate(state: State): AggregateStatus {
  let needsAttention = 0;
  let running = 0;
  let waiting = 0;
  let ready = 0;

  for (const s of Object.values(state.sessions)) {
    if (s.needsAttention) needsAttention++;
    if (s.status === "running") running++;
    if (s.status === "waiting") waiting++;
    if (s.status === "ready") ready++;
  }

  return { needsAttention, running, waiting, ready };
}

/**
 * Build session notification state map from current sessions.
 * Preserves attention flags from existing state when sessions still need attention.
 */
export function buildSessionStates(
  sessions: Session[],
  needsAttention: Set<string>,
  attentionTypes: Map<string, "blocked" | "turnComplete">,
  previousStates?: Record<string, SessionNotificationState>,
  pushedKeys?: Set<string>,
): Record<string, SessionNotificationState> {
  const states: Record<string, SessionNotificationState> = {};

  for (const session of sessions) {
    if (!session.tmuxPane) continue;
    const key = session.tmuxPane.paneId;
    const prev = previousStates?.[key];
    // Scoped to the attention episode, exactly like lastTransition below: carried while
    // attention persists, dropped the moment it clears so the next episode pushes again.
    const phonePushed =
      needsAttention.has(key) &&
      (pushedKeys?.has(key) === true || (prev?.needsAttention === true && prev.phonePushed === true));
    states[key] = {
      status: session.status,
      needsAttention: needsAttention.has(key),
      attentionType: attentionTypes.get(key),
      phonePushed: phonePushed || undefined,
      tmuxSession: session.tmuxPane.sessionName,
      tmuxWindow: session.tmuxPane.windowIndex,
      tmuxPane: session.tmuxPane.paneId,
      windowName: session.name || session.tmuxPane.windowName,
      // Preserve original transition time; only set when newly added to attention
      lastTransition: needsAttention.has(key)
        ? (prev?.needsAttention ? prev.lastTransition : Date.now())
        : undefined,
    };
  }

  return states;
}

/**
 * Sync the in-memory pane→session map with the hook-owned per-pane files and report which
 * panes changed id (/clear, /compact mint a new id without restarting the process). Replaces
 * the old consume-once hook-events log: reading is now non-destructive, so the monitor, TUI
 * and bridge no longer race to persist a truncate-once file. `changedPaneIds` flags only panes
 * whose id CHANGED — a brand-new pane is not a "change" — preserving the original contract.
 */
export async function processHookEvents(
  paneSessionMap: Record<string, string>,
): Promise<{ changed: boolean; changedPaneIds: Set<string>; paneMap: Record<string, string> }> {
  const changedPaneIds = new Set<string>();
  let changed = false;

  const fresh = await loadPaneSessions();
  for (const [paneId, sessionId] of Object.entries(fresh)) {
    const oldId = paneSessionMap[paneId];
    if (oldId && oldId !== sessionId) changedPaneIds.add(paneId);
    if (oldId !== sessionId) {
      paneSessionMap[paneId] = sessionId;
      changed = true;
    }
  }

  // Hand the freshly-loaded map back so callers on the discovery hot path don't
  // immediately re-read the same per-pane files.
  return { changed, changedPaneIds, paneMap: fresh };
}
