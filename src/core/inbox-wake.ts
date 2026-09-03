/**
 * Snooze wake pass (ADR 0013): a due snooze auto-reopens its session in a
 * detached ⚡-named window — snooze means "it literally comes back", and since
 * the snooze verb killed the pane, the wake is what restores trust in killing.
 *
 * Run by `claude0 daemon` (launchd-kept-alive), NOT the status-right monitor: tmux
 * only evaluates the status line while a client is attached, so a midnight
 * wake with no terminal open would silently not fire from there.
 */
import type { DispositionRow, InboxStore } from "./inbox-store";
import { loadConfig } from "./config";
import { USER_SHELL } from "./launch-command";
import { snoozeSpan, wakeBanner } from "./inbox-model";
import { sendNativeNotification } from "./notifications";
import { resolveRestoreTarget } from "./resurrect";
import { loadState, saveState, loadPaneSessions } from "./state";
import { detectStatus } from "./status";
import { capturePane, listPanes } from "./tmux";

export interface DueWake {
  sessionId: string;
  snoozedAt: number;
  /** The portkey device that set the snooze — the wake push targets it. Null = Mac-set. */
  deviceId: string | null;
}

/**
 * Which snoozes should wake right now. Pure — the daemon feeds it store reads
 * and the set of session ids that already have a live pane (a session the
 * user manually resumed mid-snooze must not get a second window).
 */
export function dueWakes(
  dispositions: Map<string, DispositionRow>,
  archived: Map<string, number>,
  liveSessionIds: Set<string>,
  now: number,
): DueWake[] {
  const due: DueWake[] = [];
  for (const [id, d] of dispositions) {
    if (d.kind !== "snoozed" || d.until === null || d.until > now) continue;
    if (d.autoResumed || archived.has(id) || liveSessionIds.has(id)) continue;
    due.push({ sessionId: id, snoozedAt: d.createdAt, deviceId: d.deviceId });
  }
  return due;
}

/** Session ids with a live pane: the hook-owned pane map ∩ panes that still exist. */
export async function liveSessionIds(): Promise<Set<string>> {
  const [paneMap, panes] = await Promise.all([loadPaneSessions(), listPanes()]);
  const livePanes = new Set(panes.map((p) => p.paneId));
  return new Set(
    Object.entries(paneMap)
      .filter(([paneId]) => livePanes.has(paneId))
      .map(([, sessionId]) => sessionId),
  );
}

export interface WakeWindow {
  paneId: string;
  sessionName: string;
  windowIndex: number;
}

/**
 * A wake must LOOK like an attention event, not just exist: write a real
 * attention entry into state.json keyed by the new pane. The monitor carries
 * attention flags over each tick (until focus or a new turn), so ⚡ on the
 * window name, the status-right count and `claude0 next` all follow natively —
 * naming the window ⚡ ourselves loses to the monitor's rename within seconds.
 *
 * The stamp waits for detected status `ready`, not merely for claude to own
 * the pane: the monitor clears carried attention both for unknown panes
 * ("pane gone") AND for running ones ("user already interacted") — and
 * claude's boot spinner reads as running, which ate the first live stamp.
 * Returns true once the stamp is in place.
 */
export async function stampWakeAttention(paneId: string): Promise<boolean> {
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const cap = await capturePane(paneId);
      if (detectStatus(cap, true).status === "ready") {
        ready = true;
        break;
      }
    } catch {
      return false; // pane died
    }
    await Bun.sleep(1000);
  }
  if (!ready) return false; // still booting/running after 30s — a stamp would be eaten anyway
  // write, then re-assert once — the monitor rewrites state.json wholesale
  // each tick, and a tick that loaded before our write saves over it
  for (const wait of [0, 3000]) {
    if (wait) await Bun.sleep(wait);
    const st = await loadState();
    const prev = st.sessions[paneId];
    if (prev?.needsAttention) continue; // stuck — monitor carried it over
    st.sessions[paneId] = {
      ...(prev ?? { status: "ready" }),
      needsAttention: true,
      attentionType: "turnComplete",
      tmuxPane: paneId,
      lastTransition: Date.now(),
    };
    st.lastUpdatedAt = Date.now();
    await saveState(st);
  }
  return true;
}

/** Best-effort repo/name/path for a session from the store's activity snapshot. */
function snapshotRow(
  store: InboxStore,
  sessionId: string,
): { repo?: string; repoPath?: string; name?: string } {
  for (const r of store.loadSnapshot()) {
    if (r.sessionId !== sessionId) continue;
    try {
      return JSON.parse(r.data) as { repo?: string; repoPath?: string; name?: string };
    } catch {
      break;
    }
  }
  return {};
}

async function spawnWakeWindow(
  sessionId: string,
  dir: string,
  repo: string,
  banner: string,
): Promise<WakeWindow | null> {
  // banner scrolls above claude's UI: walking into this window days later
  // should say WHY it exists (safe chars only — it runs through a shell).
  // Separator is printable on purpose: tmux sanitizes control chars (\t) to
  // `_` for clients running outside tmux — i.e. this daemon, always.
  // Trailing login shell (not `exec claude`) so the window survives claude exiting.
  const out = (
    await Bun.$`tmux new-window -d -P -F ${"#{pane_id}<|>#{session_name}<|>#{window_index}"} -c ${dir} -n ${`⚡${repo}`} ${`echo '${banner}'; claude -r ${sessionId}; exec ${USER_SHELL} -l`}`.text()
  ).trim();
  const [paneId, sessionName, windowIndex] = out.split("<|>");
  if (!paneId || !sessionName || windowIndex === undefined) return null;
  return { paneId, sessionName, windowIndex: Number(windowIndex) };
}

/**
 * One wake pass: reopen every due snooze. The auto_resumed claim is the
 * at-most-once guard (atomic in the store), so an overlapping pass — or a
 * stray second daemon — never double-spawns.
 */
export async function wakePass(store: InboxStore, now = Date.now()): Promise<void> {
  const due = dueWakes(store.dispositions(), store.archivedAt(), await liveSessionIds(), now);
  if (!due.length) return;
  const config = await loadConfig();
  for (const w of due) {
    if (!store.markAutoResumed(w.sessionId, now)) continue; // another waker claimed it
    try {
      const row = snapshotRow(store, w.sessionId);
      const home = process.env.HOME ?? "/";
      const dir = (await resolveRestoreTarget(w.sessionId, row.repoPath ?? home)) ?? row.repoPath ?? home;
      const win = await spawnWakeWindow(
        w.sessionId,
        dir,
        row.repo ?? "wake",
        wakeBanner(w.snoozedAt, now),
      );
      if (!win) continue;
      const stamped = await stampWakeAttention(win.paneId);
      // Alert tier: a wake is an alarm the user set, so it alerts like any
      // attention event. Only once the session is genuinely ready — a resume
      // that never boots must not announce itself. On darwin that's the
      // native banner. The push tier routes by who set the alarm: a snooze
      // set FROM A PHONE (disposition carries its deviceId) pushes to that
      // device on either platform — the darwin banner alone would wake only
      // the Mac for an alarm the phone asked for. Without a setter
      // subscription, darwin has already alerted via the banner; a headless
      // host has no banner tier, so it broadcasts to every device instead
      // (replacing a tier that cannot exist off-darwin, not adding one).
      // All media share the nativeNotification gate on purpose: it is the
      // "alert me on wake" toggle, and which medium delivers it is the
      // platform's business, not a second setting.
      if (stamped && config.notifications.native) {
        const title = `☾ Woke — ${row.name ?? row.repo ?? w.sessionId.slice(0, 8)}`;
        const body = `snoozed ${snoozeSpan(w.snoozedAt, now)} ago — due now`;
        if (process.platform === "darwin") sendNativeNotification(title, body, win, config.notifications.terminalBundleId);
        try {
          const { getSubscription, listDeviceIds, sendWebPush } = await import("./web-push");
          const targets =
            w.deviceId && getSubscription(w.deviceId)
              ? [w.deviceId]
              : process.platform === "darwin"
                ? []
                : listDeviceIds();
          await Promise.all(targets.map((id) => sendWebPush(id, { title, body, sessionId: w.sessionId })));
        } catch {}
      }
    } catch {
      // best-effort per session; the claim stands (no wake retry storm), the
      // row still resurfaces in Needs You via the sidebar's woken derivation
    }
  }
}
