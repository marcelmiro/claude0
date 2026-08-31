/**
 * Single sidebar renderer (M2 chassis — ADR 0013 addendum 2). ONE process
 * (inside `claude0 daemon`) paints every window's sidebar pane by writing ANSI
 * to the pane's tty; the panes themselves are dumb `claude0 sidebar-pane` stubs
 * that raw-mode their tty and relay stdin bytes back over a unix socket.
 *
 * What the per-pane blessed chassis needed cross-process choreography for —
 * focus handoff files, SIGUSR1/2, destination pre-warm — is plain in-process
 * state here: every window's sidebar is always current, so a window switch
 * lands on painted content by construction.
 *
 * Spike-proven mechanics (see .plans + prototype/renderer-spike): writing a
 * pane's pty slave IS pane output; DECSET 1004/1006 written to the tty give
 * focus + SGR mouse through the same relay; a respawned pane gets a NEW tty
 * (EPERM/ENOENT on the old one ⇒ re-resolve and repaint).
 *
 * Self-installs its tmux wiring and repaints per-line on its own 1s loop.
 * Stands down while `M-S` hides sidebars or autostart is off.
 */
import { openSync, writeSync, closeSync } from "node:fs";
import { InboxStore } from "../core/inbox-store";
import { composeSessions, peekEngaged, peekVerdict, sectionOf, wakeAt, type InboxSession } from "../core/inbox-model";
import { readLastPromptAt, resolveTranscriptPath } from "../core/last-turn";
import { resolveRestoreTarget } from "../core/resurrect";
import { PATHS, configCache, parseTmuxKey, tmuxKeys } from "../core/config";
import { SHELL_NAMES } from "../core/tmux";
import { parseInput, type InputEvent } from "./input";
import { renderView, SNOOZE_UNITS, type ViewState, type VisibleRow } from "./rows";
import { fmtWakeAbs } from "./ansi";

const SHELL_RE = new RegExp(`^(${SHELL_NAMES.join("|")})$`);

const COLS = Number(process.env.CLAUDE0_SIDEBAR_COLS ?? 30);
export const SIDEBAR_SOCK = `${PATHS.dir}/sidebar.sock`;
// User-owned visibility toggles: autostart = sidebar on; hidden = M-S hid it.
const AUTOSTART = `${PATHS.dir}/inbox-sidebar-autostart-default`;
const HIDDEN = `${PATHS.dir}/inbox-sidebar-hidden-default`;
/** start_command marker for stub panes (what discovery greps for). */
const STUB_MARK = "sidebar-pane";
/**
 * Field separator for tmux -F output. NOT \t: tmux sanitizes control
 * characters to `_` when the client runs OUTSIDE tmux (no TMUX env) — which
 * is exactly how this daemon always runs. Free-text fields (start_command)
 * go LAST so a separator collision inside them can't shift the fixed fields.
 */
const SEP = "<|>";
/**
 * The pane stub is a SHELL line, not a bun process: a bun runtime per pane
 * costs ~30MB — more than the blessed chassis this replaces; sh+nc+cat is
 * ~1MB. Raw-mode the tty so keys pass through unrendered, greet with the
 * pane id, then relay stdin bytes to the renderer socket verbatim. The
 * reconnect loop survives daemon restarts (nc dies with the socket, the
 * next keypress SIGPIPEs cat, the loop reconnects). `: sidebar-pane` is the
 * discovery marker in pane_start_command.
 */
const STUB_CMD = `: sidebar-pane; stty raw -echo; while :; do (printf 'hello %s\\n' "$TMUX_PANE"; exec cat) | nc -U ${SIDEBAR_SOCK} 2>/dev/null; sleep 1; done`;

interface WinState extends ViewState {
  windowId: string;
  stubPane: string | null;
  stubTty: string | null;
  stubBornAt: number;
  width: number;
  height: number;
  clickArmed: boolean;
  confirmKillId: string | null;
  /** Last painted rows per line — the diff baseline. */
  lastRows: string[];
  /** Mouse/focus modes + cursor-hide written to the current tty. */
  modesWritten: boolean;
  visible: VisibleRow[];
  rowAtLine: (string | undefined)[];
  focusPending: ReturnType<typeof setTimeout> | null;
}

function freshWin(windowId: string): WinState {
  return {
    windowId,
    stubPane: null,
    stubTty: null,
    stubBornAt: 0,
    width: COLS,
    height: 24,
    focused: false,
    clickArmed: false,
    selectedId: null,
    activePaneId: null,
    snoozeMenuFor: null,
    snoozeDigits: "",
    snoozeUnit: "t",
    confirmKillId: null,
    blockNoteFor: null,
    blockNote: "",
    helpVisible: false,
    flash: "",
    flashUntil: 0,
    scrollTop: 0,
    lastRows: [],
    modesWritten: false,
    visible: [],
    rowAtLine: [],
    focusPending: null,
  };
}

export function runSidebarRenderer(): void {
  console.error(`[sidebar] renderer starting (pid ${process.pid})`);
  const store = new InboxStore();
  let sessions: InboxSession[] = [];
  let lastDataVersion = -1;
  const wins = new Map<string, WinState>();
  const paneToWin = new Map<string, string>(); // stub paneId → windowId
  // sessionId → window spawned by an Enter-resume: discovery hasn't stamped
  // the new pane onto the row yet (~3s), so a second Enter must commit into
  // this window instead of double-spawning
  const resumedWindows = new Map<string, string>();
  // tmux server start time from the last tick — a change means every window id
  // the daemon remembers may now name an unrelated window (see the tick)
  let tmuxEpoch: string | null = null;
  // peeked sessionId → when its window was last the viewed one (grace anchor)
  const peekLastActive = new Map<string, number>();
  let standing = false; // currently active (markers allow)
  let lastMinute = -1;

  function reloadSessions(): void {
    try {
      lastDataVersion = store.dataVersion();
      sessions = composeSessions(store);
    } catch {}
  }

  function findSession(id: string | null | undefined): InboxSession | undefined {
    return id ? sessions.find((s) => s.id === id) : undefined;
  }

  // ── painting ─────────────────────────────────────────────────────────────

  function paint(win: WinState): void {
    if (!win.stubTty) return;
    const view = renderView(sessions, win, { width: win.width, height: win.height }, Date.now());
    win.scrollTop = view.scrollTop;
    win.visible = view.visible;
    win.rowAtLine = view.rowAtLine;
    const full = !win.modesWritten;
    let out = "";
    if (full) {
      // alternate screen first: tmux mouse bindings gate on #{alternate_on}
      // (a stock-style DoubleClick1Pane binding drops a non-alternate pane
      // into copy-mode instead of forwarding the press — the second click
      // of a double-click would never reach us); then hide cursor, SGR
      // mouse + focus reporting (arrive back via the relay)
      out += "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?1004h\x1b[2J";
    }
    for (let i = 0; i < view.rows.length; i++) {
      if (!full && win.lastRows[i] === view.rows[i]) continue;
      out += `\x1b[${i + 1};1H\x1b[2K${view.rows[i]}`;
    }
    // lines beyond the new frame (pane shrank): clear them
    if (!full) {
      for (let i = view.rows.length; i < win.lastRows.length; i++) out += `\x1b[${i + 1};1H\x1b[2K`;
    }
    if (!out) return;
    try {
      const fd = openSync(win.stubTty, "w");
      writeSync(fd, out);
      closeSync(fd);
      win.lastRows = view.rows;
      win.modesWritten = true;
    } catch {
      // tty vanished (pane respawned/killed) — re-resolve next topology tick
      win.stubTty = null;
      win.modesWritten = false;
      win.lastRows = [];
    }
  }

  function paintAll(): void {
    for (const win of wins.values()) paint(win);
  }

  function showFlash(win: WinState, msg: string): void {
    win.flash = msg;
    win.flashUntil = Date.now() + 2500;
  }

  // Verbs are single SQLite transactions. Apply, re-read, repaint everywhere.
  function applyVerb(fn: () => boolean): boolean {
    let ok = false;
    try {
      ok = fn();
    } catch {}
    reloadSessions();
    return ok;
  }

  // ── selection ────────────────────────────────────────────────────────────

  function seedSelection(win: WinState): void {
    const from = sessions.find((s) => s.real?.paneId === win.activePaneId);
    if (from && win.visible.some((v) => v.id === from.id)) win.selectedId = from.id;
    else if (!win.visible.some((v) => v.id === win.selectedId)) win.selectedId = win.visible[0]?.id ?? null;
  }

  function move(win: WinState, delta: number): void {
    if (!win.visible.length) return;
    const i = win.visible.findIndex((v) => v.id === win.selectedId);
    const next = Math.min(win.visible.length - 1, Math.max(0, (i === -1 ? 0 : i) + delta));
    win.selectedId = win.visible[next]!.id;
  }

  // J/K: jump between sections. J → first row of the next section; K → first
  // row of this section, or the previous one's if already there.
  function jumpSection(win: WinState, dir: 1 | -1): void {
    const visible = win.visible;
    if (!visible.length) return;
    const i = Math.max(0, visible.findIndex((v) => v.id === win.selectedId));
    const sec = visible[i]!.section;
    if (dir === 1) {
      const next = visible.findIndex((v, j) => j > i && v.section !== sec);
      if (next !== -1) win.selectedId = visible[next]!.id;
    } else {
      const first = visible.findIndex((v) => v.section === sec);
      if (i > first) win.selectedId = visible[first]!.id;
      else if (first > 0) {
        const prevSec = visible[first - 1]!.section;
        win.selectedId = visible[visible.findIndex((v) => v.section === prevSec)]!.id;
      }
    }
  }

  // After a verb the item leaves its list; the cursor falls to the row UNDER
  // it (crossing section borders), else the one above.
  function nextSelectionAfterVerb(win: WinState, id: string): string | null {
    const i = win.visible.findIndex((v) => v.id === id);
    if (i === -1) return win.visible[0]?.id ?? null;
    return win.visible[i + 1]?.id ?? win.visible[i - 1]?.id ?? null;
  }

  // ── tmux actions ─────────────────────────────────────────────────────────

  // Where a pane lives, or null when it's dead. NOT display-message: with a
  // vanished pane target, `display-message -p -t %x` silently formats against
  // a fallback pane and exits 0 (tmux 3.7b) — it can't detect death and
  // returns some other window's id. list-panes genuinely fails on a dead pane.
  async function paneLocation(paneId: string): Promise<{ windowId: string; session: string } | null> {
    try {
      const line = (
        await Bun.$`tmux list-panes -t ${paneId} -F ${`#{window_id}${SEP}#{session_name}`}`.quiet().text()
      )
        .trim()
        .split("\n")[0];
      const [windowId, session] = (line ?? "").split(SEP);
      return windowId ? { windowId, session: session ?? "" } : null;
    } catch {
      return null;
    }
  }

  async function windowOf(paneId: string): Promise<string> {
    return (await paneLocation(paneId))?.windowId ?? "";
  }

  // Show another window but stay in the sidebar: switch the display, then
  // land focus on the TARGET window's stub with the row selected. The
  // select-window → select-pane order is load-bearing — the after-select-
  // window bounce hook ejects a stub-active window, and the pane select
  // after it is what defeats the bounce.
  async function showWindowKeepSidebar(
    from: WinState,
    targetWin: string,
    sessionId: string,
    tmuxSession?: string,
  ): Promise<void> {
    await Bun.$`tmux select-window -t ${targetWin}`.quiet();
    if (tmuxSession) await showToClients(tmuxSession);
    const target = wins.get(targetWin);
    if (!target?.stubPane) return; // no sidebar there (hidden?) — window shown, done
    await landInSidebar(from, target, sessionId);
  }

  // Focus a window's sidebar with the row selected. The FROM sidebar drops
  // its chrome eagerly — its focus-out escape can lag a tick.
  async function landInSidebar(from: WinState, target: WinState, sessionId: string): Promise<void> {
    if (target !== from && from.focused) {
      from.focused = false;
      from.clickArmed = false;
      paint(from);
    }
    cancelPendingFocus(target);
    target.focused = true;
    target.clickArmed = true;
    target.selectedId = sessionId;
    await Bun.$`tmux select-pane -t ${target.stubPane}`.quiet();
    paint(target);
  }

  // After a disposition the VIEW follows the selection: show the next
  // session's window, focused in its sidebar. All in-process — no handoff
  // files, no signals.
  async function followSelection(from: WinState, nextId: string | null): Promise<void> {
    if (!nextId) return;
    const next = findSession(nextId);
    if (!next?.real) return;
    const win = await windowOf(next.real.paneId);
    if (!win || win === from.windowId) return; // already looking at it
    try {
      await showWindowKeepSidebar(from, win, nextId);
    } catch {}
  }

  // The disposition walk follows the view to the next session's window ONLY
  // when the disposed session lived in the window being looked at (its pane
  // is about to die under you). Disposing a row that lives elsewhere must
  // not yank the view away — the cursor still falls to the next row.
  // Resolve BEFORE killPaneOf: a dead pane no longer answers windowOf.
  async function livesHere(win: WinState, s: InboxSession | undefined): Promise<boolean> {
    if (!s?.real) return false;
    return (await windowOf(s.real.paneId)) === win.windowId;
  }

  // Leave a dying window for the next session's sidebar, selection carried.
  async function handOffTo(nextId: string | null, dyingWin: string): Promise<void> {
    try {
      const next = findSession(nextId);
      let targetWin: string | null = null;
      if (next?.real) targetWin = (await windowOf(next.real.paneId)) || null;
      if (!targetWin || targetWin === dyingWin) {
        const order = [...wins.keys()];
        const i = order.indexOf(dyingWin);
        targetWin =
          [...order.slice(i + 1), ...order.slice(0, i)].find((w) => w !== dyingWin) ?? null;
      }
      if (!targetWin) return;
      await Bun.$`tmux select-window -t ${targetWin}`.quiet();
      const target = wins.get(targetWin);
      if (!target?.stubPane) return;
      target.focused = true;
      target.clickArmed = true;
      if (nextId) target.selectedId = nextId;
      else seedSelection(target);
      await Bun.$`tmux select-pane -t ${target.stubPane}`.quiet();
      paint(target);
    } catch {}
  }

  // snooze/block/done close the pane (a live pane exists only for active
  // work — ADR 0013). When the pane is its window's last work pane, kill the
  // WINDOW — and when that window is the one being SHOWN, navigate away
  // FIRST so the demolition happens off-screen.
  async function killPaneOf(from: WinState, s: InboxSession | undefined, nextId?: string | null): Promise<void> {
    if (!s?.real) return;
    try {
      const win = await windowOf(s.real.paneId);
      if (!win) return;
      const panes = (
        await Bun.$`tmux list-panes -t ${win} -F ${`#{pane_id}${SEP}#{pane_start_command}`}`.quiet().text()
      )
        .trim()
        .split("\n")
        .filter((l) => !l.startsWith(`${s.real!.paneId}${SEP}`) && !l.includes(STUB_MARK));
      if (panes.length === 0) {
        if (win === from.windowId) await handOffTo(nextId ?? null, win);
        wins.delete(win);
        await Bun.$`tmux kill-window -t ${win}`.quiet();
      } else {
        await Bun.$`tmux kill-pane -t ${s.real.paneId}`.quiet();
      }
    } catch {}
  }

  // Any client looking at a different tmux session gets switched — selecting
  // a window in an UNATTACHED session is invisible (the resurrect incident
  // left live claudes in a stray session "0"; Enter on them did "nothing").
  async function showToClients(session: string): Promise<void> {
    if (!session) return;
    try {
      const clients = (
        await Bun.$`tmux list-clients -F ${`#{client_tty}${SEP}#{client_session}`}`.quiet().text()
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const line of clients) {
        const [tty, current] = line.split(SEP);
        if (tty && current !== session) {
          await Bun.$`tmux switch-client -c ${tty} -t ${session}`.quiet();
        }
      }
    } catch {}
  }

  // Enter and click share this, select-then-commit like the click grammar:
  // a row in ANOTHER window shows that window — Enter with its sidebar
  // focused (the keyboard flow keeps working the queue from the sidebar; the
  // next Enter there commits), a click commit with the session PANE focused
  // (`focusPane` — a double-click means "take me there", and the mouse can
  // re-enter the sidebar in one click, no M-s round trip). A row in THIS
  // window commits — focus drops into the session pane itself. A row whose
  // pane died resumes on demand as
  // a PEEK when it's parked/done: the disposition/archive stays, engagement
  // (a new prompt) is what graduates it. The window comes from the live
  // pane's ACTUAL location, never the row's recorded session:index — indexes
  // get reused, and a stale one lands anywhere.
  async function switchTo(win: WinState, s: InboxSession, focusPane = false): Promise<void> {
    const loc = s.real ? await paneLocation(s.real.paneId) : null;
    if (loc && s.real) {
      if (loc.windowId === win.windowId) {
        try {
          await Bun.$`tmux select-pane -t ${s.real.paneId}`.quiet();
          await showToClients(loc.session);
          return;
        } catch {} // pane died under us — fall through to resume
      } else {
        // a mid-flight failure here must NOT fall through: the pane is alive,
        // resuming would spawn a duplicate window for a live session
        try {
          if (focusPane) {
            await Bun.$`tmux select-window -t ${loc.windowId}`.quiet();
            await Bun.$`tmux select-pane -t ${s.real.paneId}`.quiet();
            await showToClients(loc.session);
            // drop this sidebar's chrome eagerly — its focus-out escape can
            // lag a tick (same as landInSidebar's FROM handling)
            if (win.focused) {
              win.focused = false;
              win.clickArmed = false;
              paint(win);
            }
          } else {
            await showWindowKeepSidebar(win, loc.windowId, s.id, loc.session);
          }
        } catch {}
        return;
      }
    }
    await resumeOrRevisit(win, s);
  }

  /** The window's first non-stub pane, or null when the window is gone. */
  async function workPaneOf(winId: string): Promise<string | null> {
    try {
      const lines = (
        await Bun.$`tmux list-panes -t ${winId} -F ${`#{pane_id}${SEP}#{pane_start_command}`}`.quiet().text()
      )
        .trim()
        .split("\n");
      for (const l of lines) {
        const [pane] = l.split(SEP);
        if (pane && !l.includes(STUB_MARK)) return pane;
      }
    } catch {}
    return null;
  }

  // First Enter on a pane-less row spawns its window and lands in THAT
  // window's sidebar; a second Enter — before discovery has stamped the new
  // pane onto the row — commits into the spawned window's work pane instead
  // of double-spawning. Parked/done rows resume as a PEEK (recorded for the
  // engagement gate + reaper); their overlay is untouched, so the row keeps
  // filing under Parked/Recent until a prompt graduates it.
  async function resumeOrRevisit(win: WinState, s: InboxSession): Promise<void> {
    const prior = resumedWindows.get(s.id);
    if (prior) {
      const work = await workPaneOf(prior);
      if (work) {
        try {
          await Bun.$`tmux select-window -t ${prior}`.quiet();
          await Bun.$`tmux select-pane -t ${work}`.quiet();
          return;
        } catch {}
      }
      resumedWindows.delete(s.id);
    }
    const spawned = await resumeSession(win, s);
    if (!spawned) return;
    resumedWindows.set(s.id, spawned);
    // the CURRENT overlay decides peek vs plain resume — the caller's row can
    // predate a just-applied verb (b-unpark clears the disposition first)
    const fresh = findSession(s.id) ?? s;
    const section = sectionOf(fresh, Date.now());
    const peeked = section === "parked" || section === "done";
    if (peeked) {
      applyVerb(() => {
        store.setPeek(s.id, spawned, Date.now());
        return true;
      });
      // fresh grace anchor: a re-peek must not inherit the previous peek's
      // (possibly hours-old) last-active time and get reaped on first sight
      peekLastActive.set(s.id, Date.now());
    }
    // land in the new window's sidebar NOW instead of waiting for a tick to
    // split it (ctlToggle's sequence: ensure → sync → select stub → paint)
    try {
      await ensure(spawned);
      syncTopology(await listAllPanes());
      const target = wins.get(spawned);
      if (target?.stubPane) {
        // selection set explicitly — seedSelection can't find it, `real` lags discovery
        if (peeked) showFlash(target, section === "parked" ? "peek — stays parked" : "peek — stays in recent");
        await landInSidebar(win, target, s.id);
      }
    } catch {}
  }

  async function resumeSession(win: WinState, s: InboxSession): Promise<string | null> {
    try {
      const home = process.env.HOME ?? "/";
      const dir = (await resolveRestoreTarget(s.id, s.repoPath ?? home)) ?? s.repoPath ?? home;
      // -d is load-bearing: a NON-detached new-window from the tty-less
      // daemon never returns (verified live — the Bun.$ promise just hangs),
      // so spawn detached and select the window explicitly. -a beside the
      // invoking sidebar's window (fork parity): resuming is a detour from
      // that window, so kill-window/prefix-l land back where the user was.
      // The window-id target also pins the session — an untargeted
      // new-window from outside tmux lands in the most recently USED
      // session, not the one on screen.
      // ONE string, not word-split argv: tmux direct-execs a multi-arg
      // command with no shell, and the daemon's PATH has no claude — the
      // single string goes through `$SHELL -c`, where zshenv restores PATH
      const cmd = `exec claude -r ${s.id}`;
      const spawned = (
        await Bun.$`tmux new-window -d -a -P -F ${"#{window_id}"} -t ${win.windowId} -c ${dir} ${cmd}`.quiet().text()
      ).trim();
      if (spawned) await Bun.$`tmux select-window -t ${spawned}`.quiet();
      showFlash(win, "pane gone — resuming in new window");
      return spawned || null;
    } catch {
      showFlash(win, "resume failed");
      return null;
    }
  }

  async function unfocusToPane(win: WinState): Promise<void> {
    cancelPendingFocus(win);
    win.focused = false;
    win.clickArmed = false;
    win.helpVisible = false;
    paint(win);
    try {
      if (win.stubPane) await Bun.$`tmux select-pane -l -t ${win.stubPane}`.quiet();
    } catch {}
  }

  // Focus that arrives WITHOUT an explanation (focus-in escape) may be a
  // click still in flight — the terminal sends focus-in before the mouse
  // sequence. Defer the first chrome paint one beat; anything that knows
  // better (click, M-s, keypress) cancels and paints itself.
  function gainFocusSoon(win: WinState): void {
    if (win.focused || win.focusPending) return;
    win.focusPending = setTimeout(() => {
      win.focusPending = null;
      win.focused = true;
      seedSelection(win);
      paint(win);
    }, 80);
  }

  function cancelPendingFocus(win: WinState): void {
    if (win.focusPending) {
      clearTimeout(win.focusPending);
      win.focusPending = null;
    }
  }

  // ── verbs / keys (port of the prototype keypress handler) ───────────────

  const VERBS: Record<string, string[]> = {
    "needs-you": ["s", "b", "e"],
    running: ["e"],
    parked: ["s", "b", "e"],
    done: ["e"],
  };

  async function handleKey(win: WinState, ev: { name: string; ch?: string; shift?: boolean; ctrl?: boolean }): Promise<void> {
    win.clickArmed = true;

    // first key after regaining focus only reveals the cursor — a blind
    // "M-s, e" used to archive whatever was selected on the LAST visit
    if (!win.focused) {
      cancelPendingFocus(win);
      win.focused = true;
      seedSelection(win);
      paint(win);
      return;
    }

    if (ev.name !== "e") win.confirmKillId = null;

    // inline block-note input: free typing until ↵ commits / esc cancels
    if (win.blockNoteFor) {
      const id = win.blockNoteFor;
      if (ev.name === "escape") {
        win.blockNoteFor = null;
        paint(win);
        return;
      }
      if (ev.name === "enter") {
        win.blockNoteFor = null;
        const note = win.blockNote.trim() || "waiting on external";
        const prev = win.selectedId;
        win.selectedId = nextSelectionAfterVerb(win, id);
        const target = findSession(id);
        const walk = await livesHere(win, target);
        const ok = applyVerb(() => store.block(id, note, Date.now()));
        if (ok) {
          await killPaneOf(win, target, win.selectedId);
          showFlash(win, `blocked${target?.real ? " — pane closed" : ""}`);
          paintAll();
          if (walk) await followSelection(win, win.selectedId);
        } else {
          win.selectedId = prev;
          showFlash(win, "gone — nothing blocked");
          paint(win);
        }
        return;
      }
      if (ev.name === "backspace") {
        win.blockNote = win.blockNote.slice(0, -1);
        paint(win);
        return;
      }
      if (ev.ch && !ev.ctrl && ev.ch.length === 1 && ev.ch >= " ") {
        win.blockNote += ev.ch;
        paint(win);
      }
      return;
    }

    // ? overlay: deliberate close only (? / q / esc); other keys inert
    if (win.helpVisible) {
      if (ev.ch === "?" || ev.name === "q" || ev.name === "escape") {
        win.helpVisible = false;
        paint(win);
      }
      return;
    }
    if (ev.ch === "?" && !win.snoozeMenuFor) {
      win.helpVisible = true;
      paint(win);
      return;
    }

    if (win.snoozeMenuFor) {
      // Snooze form: digits fill the amount (empty = placeholder 1), t/d/h or
      // Tab pick the unit, Enter commits, q/esc cancel. Everything else is
      // INERT — a stray key never closes the form, and nothing commits before
      // Enter (the retired digits-then-unit grammar's instant unit-commit made
      // a partial "16h" a destructive 1h snooze).
      const id = win.snoozeMenuFor;
      if (ev.name === "q") {
        win.snoozeMenuFor = null;
        win.snoozeDigits = "";
        await unfocusToPane(win);
        return;
      }
      if (ev.name === "escape") {
        win.snoozeMenuFor = null;
        win.snoozeDigits = "";
        paint(win);
        return;
      }
      if (/^[0-9]$/.test(ev.ch ?? "") && win.snoozeDigits.length < 3) {
        // a leading 0 can't start a valid amount — refuse it so Enter is always committable
        if (win.snoozeDigits === "" && ev.ch === "0") return;
        win.snoozeDigits += ev.ch;
        paint(win);
        return;
      }
      if (ev.name === "backspace") {
        win.snoozeDigits = win.snoozeDigits.slice(0, -1);
        paint(win);
        return;
      }
      if (ev.ch === "t" || ev.ch === "d" || ev.ch === "h") {
        win.snoozeUnit = ev.ch;
        paint(win);
        return;
      }
      if (ev.name === "tab") {
        const i = SNOOZE_UNITS.findIndex(([u]) => u === win.snoozeUnit);
        win.snoozeUnit = SNOOZE_UNITS[(i + 1) % SNOOZE_UNITS.length]![0];
        paint(win);
        return;
      }
      if (ev.name === "enter") {
        const n = win.snoozeDigits === "" ? 1 : Number(win.snoozeDigits);
        const unit = win.snoozeUnit;
        win.snoozeMenuFor = null;
        win.snoozeDigits = "";
        const prev = win.selectedId;
        if (win.selectedId === id) win.selectedId = nextSelectionAfterVerb(win, id);
        const target = findSession(id);
        const walk = await livesHere(win, target);
        const now = Date.now();
        const wake = wakeAt(now, n, unit);
        const ok = applyVerb(() => store.snooze(id, wake, now));
        if (ok) {
          await killPaneOf(win, target, win.selectedId);
          showFlash(win, `☾ ${fmtWakeAbs(wake, now)}${target?.real ? " — pane closed" : ""}`);
          paintAll();
          if (walk) await followSelection(win, win.selectedId);
          return;
        }
        win.selectedId = prev;
        showFlash(win, "gone — nothing snoozed");
        paint(win);
        return;
      }
      return;
    }

    const row = win.visible.find((v) => v.id === win.selectedId);
    const verb = ["s", "b", "e"].includes(ev.name) && !ev.shift ? ev.name : null;
    if (verb && row && !VERBS[row.section]!.includes(verb)) {
      showFlash(win, row.section === "done" ? "archived — read-only" : `no '${verb}' here`);
      paint(win);
      return;
    }

    switch (ev.name) {
      case "j":
      case "down":
        ev.shift ? jumpSection(win, 1) : move(win, 1);
        paint(win);
        break;
      case "k":
      case "up":
        ev.shift ? jumpSection(win, -1) : move(win, -1);
        paint(win);
        break;
      case "g": {
        if (!win.visible.length) break;
        win.selectedId = ev.shift ? win.visible[win.visible.length - 1]!.id : win.visible[0]!.id;
        paint(win);
        break;
      }
      case "enter": {
        const s = findSession(row?.id);
        if (s) await switchTo(win, s);
        paint(win);
        break;
      }
      case "f": {
        // fork, TUI parity — beside the parent; works on any real row,
        // RECENT included.
        const s = findSession(row?.id);
        if (s && (s.repoPath || s.real)) {
          try {
            const home = process.env.HOME ?? "/";
            const dir = (await resolveRestoreTarget(s.id, s.repoPath ?? home)) ?? s.repoPath ?? home;
            const parentWin = s.real ? await windowOf(s.real.paneId) : "";
            // -d and the single-string command for the same reasons as
            // resumeSession: non-detached new-window hangs the tty-less
            // daemon, and a word-split command skips the shell (no PATH)
            const cmd = `exec claude -r ${s.id} --fork-session`;
            const spawned = (
              parentWin
                ? await Bun.$`tmux new-window -d -a -P -F ${"#{window_id}"} -t ${parentWin} -c ${dir} ${cmd}`.quiet().text()
                : await Bun.$`tmux new-window -d -P -F ${"#{window_id}"} -c ${dir} ${cmd}`.quiet().text()
            ).trim();
            if (spawned) await Bun.$`tmux select-window -t ${spawned}`.quiet();
            showFlash(win, "forked → new window");
          } catch {
            showFlash(win, "fork failed");
          }
        }
        paint(win);
        break;
      }
      case "s": {
        if (row) {
          win.snoozeMenuFor = row.id;
          win.snoozeDigits = "";
          win.snoozeUnit = "t";
          paint(win);
        }
        break;
      }
      case "b": {
        if (!row) break;
        // on a PARKED row, b is the undo: unpark, reopen, back into Needs You
        if (row.section === "parked") {
          const s = findSession(row.id);
          const was = applyVerb(() => store.clearDisposition(row.id, Date.now(), "manual") !== null);
          if (was && s) {
            showFlash(win, "unparked — reopening");
            await switchTo(win, s); // dead pane (dispositions kill) → resumes
          } else showFlash(win, "gone — nothing to unpark");
          paintAll();
          break;
        }
        win.blockNoteFor = row.id;
        win.blockNote = "";
        paint(win);
        break;
      }
      case "e": {
        if (!row) break;
        // RECENT: e toggles — undo done, back to Needs you
        if (row.section === "done") {
          const prev = win.selectedId;
          win.selectedId = nextSelectionAfterVerb(win, row.id);
          const ok = applyVerb(() => store.unarchive(row.id, Date.now()));
          if (ok) showFlash(win, "restored — needs you");
          else {
            win.selectedId = prev;
            showFlash(win, "gone — nothing to restore");
          }
          paintAll();
          break;
        }
        // done closes the pane. RUNNING keeps the double-tap — killing a
        // mid-turn Claude throws away in-flight work.
        const s = findSession(row.id);
        const willKill = !!s?.real;
        if (row.section === "running" && willKill && win.confirmKillId !== row.id) {
          win.confirmKillId = row.id;
          showFlash(win, "e again — done + close pane (mid-turn!)");
          paint(win);
          break;
        }
        win.confirmKillId = null;
        // advance the cursor NOW — the next rapid keypress must aim at the
        // next row, not re-target this one while the mutate is in flight
        const prev = win.selectedId;
        win.selectedId = nextSelectionAfterVerb(win, row.id);
        const walk = await livesHere(win, s);
        const ok = applyVerb(() => store.archive(row.id, Date.now()));
        if (ok) {
          if (willKill && s?.real) {
            await killPaneOf(win, s, win.selectedId);
            showFlash(win, "done — pane closed");
          } else showFlash(win, "archived");
          paintAll();
          if (walk) await followSelection(win, win.selectedId);
          break;
        }
        win.selectedId = prev;
        showFlash(win, "gone — nothing archived");
        paint(win);
        break;
      }
      case "q":
      case "escape":
        await unfocusToPane(win);
        break;
    }
  }

  async function handleEvent(win: WinState, ev: InputEvent): Promise<void> {
    if (ev.type === "focus") {
      if (ev.in) gainFocusSoon(win);
      else {
        cancelPendingFocus(win);
        win.focused = false;
        win.clickArmed = false;
        win.helpVisible = false;
        win.blockNoteFor = null;
        win.snoozeMenuFor = null;
        win.snoozeDigits = "";
        // selection deliberately kept — invisible unfocused, re-seeded on gain
        paint(win);
      }
      return;
    }
    if (ev.type === "wheel") {
      win.scrollTop = Math.max(0, win.scrollTop + ev.dir * 2);
      paint(win);
      return;
    }
    if (ev.type === "click") {
      const line = ev.y - 1 + win.scrollTop;
      const id = win.rowAtLine[line];
      // select-then-commit: first click focuses + highlights; a click on a
      // non-highlighted row moves the highlight; the highlighted row commits
      if (!win.focused || !win.clickArmed) {
        cancelPendingFocus(win); // the click IS the focus event
        win.focused = true;
        win.clickArmed = true;
        if (id && win.visible.some((v) => v.id === id)) win.selectedId = id;
        else seedSelection(win);
        paint(win);
        return;
      }
      const s = findSession(id);
      if (!s) return;
      if (win.selectedId === s.id) await switchTo(win, s, true);
      else win.selectedId = s.id;
      paint(win);
      return;
    }
    await handleKey(win, ev);
  }

  // ── control (M-s / M-S via `claude0 sidebar-ctl`) ───────────────────────────

  async function ctlFocus(invokerPane: string): Promise<void> {
    const winId = await windowOf(invokerPane);
    const win = wins.get(winId);
    if (!win?.stubPane) return;
    if (invokerPane === win.stubPane) {
      await unfocusToPane(win); // M-s from the sidebar = toggle back out
      return;
    }
    // select the pane FIRST — the topology tick reads pane_active as the
    // focus fallback, and painting chrome before the move lets a tick land
    // in between and blur it right back
    try {
      await Bun.$`tmux select-pane -t ${win.stubPane}`.quiet();
    } catch {}
    cancelPendingFocus(win);
    win.focused = true;
    win.clickArmed = true;
    reloadSessions();
    const from = sessions.find((s) => s.real?.paneId === invokerPane);
    if (from) win.selectedId = from.id;
    else seedSelection(win);
    paint(win);
  }

  async function ctlToggle(invokerPane: string): Promise<void> {
    if (await Bun.file(HIDDEN).exists()) {
      // show: current window's sidebar first, focused; ensure() fills the rest
      try {
        await Bun.$`rm -f ${HIDDEN}`.quiet();
      } catch {}
      const winId = await windowOf(invokerPane);
      await ensure(winId || undefined);
      // the just-created stub hasn't been seen by a topology tick: the fresh
      // WinState has no dims, no activePaneId and an empty view, so seeding
      // straight off it selects nothing. Sync + paint the glance frame first,
      // then reuse the M-s path — it seeds selection off the invoker pane
      // (which IS this window's active work pane) with a populated fallback.
      reloadSessions();
      syncTopology(await listAllPanes());
      const win = wins.get(winId);
      if (win?.stubPane) {
        paint(win);
        await ctlFocus(invokerPane);
      }
    } else {
      await Bun.write(HIDDEN, "");
      for (const win of wins.values()) {
        if (win.stubPane) {
          try {
            await Bun.$`tmux kill-pane -t ${win.stubPane}`.quiet();
          } catch {}
        }
      }
      wins.clear();
      paneToWin.clear();
    }
  }

  // ── topology + ensure ────────────────────────────────────────────────────

  interface PaneRow {
    windowId: string;
    paneId: string;
    left: number;
    width: number;
    height: number;
    paneActive: boolean;
    windowActive: boolean;
    /** The pane's tmux session has at least one attached client. */
    attached: boolean;
    tty: string;
    startCmd: string;
    currentCmd: string;
  }

  async function listAllPanes(): Promise<PaneRow[]> {
    const fmt = ["#{window_id}", "#{pane_id}", "#{pane_left}", "#{pane_width}", "#{pane_height}", "#{pane_active}", "#{window_active}", "#{session_attached}", "#{pane_tty}", "#{pane_current_command}", "#{pane_start_command}"].join(SEP);
    const out = (await Bun.$`tmux list-panes -a -F ${fmt}`.quiet().text()).trim();
    if (!out) return [];
    return out.split("\n").map((l) => {
      const parts = l.split(SEP);
      const [windowId, paneId, left, width, height, pa, wa, att, tty, currentCmd] = parts;
      return {
        windowId: windowId!,
        paneId: paneId!,
        left: Number(left),
        width: Number(width),
        height: Number(height),
        paneActive: pa === "1",
        windowActive: wa === "1",
        attached: Number(att) > 0,
        tty: tty ?? "",
        // start_command is free text — it goes last and swallows any SEP hits
        startCmd: parts.slice(10).join(SEP),
        currentCmd: currentCmd ?? "",
      };
    });
  }

  /**
   * Resurrect restores stub panes as bare shells (left=0, thin, no
   * start_command, idle shell) — reclaim them so ensure() can split real
   * stubs. Ports the prototype's corpse detection.
   */
  async function reclaimCorpses(panes: PaneRow[]): Promise<void> {
    const suspects = panes.filter(
      (p) =>
        p.left === 0 &&
        p.width <= 60 &&
        !p.startCmd &&
        SHELL_RE.test(p.currentCmd) &&
        panes.filter((q) => q.windowId === p.windowId).length > 1,
    );
    if (!suspects.length) return;
    try {
      // one ps pass: a corpse shell has no children
      const ppids = new Set(
        (await Bun.$`ps -ax -o ppid=`.quiet().text()).trim().split("\n").map((s) => s.trim()),
      );
      const pids = (
        await Bun.$`tmux list-panes -a -F ${`#{pane_id}${SEP}#{pane_pid}`}`.quiet().text()
      )
        .trim()
        .split("\n")
        .reduce((m, l) => {
          const [pane, pid] = l.split(SEP);
          if (pane && pid) m.set(pane, pid);
          return m;
        }, new Map<string, string>());
      for (const p of suspects) {
        const pid = pids.get(p.paneId);
        if (pid && !ppids.has(pid)) {
          try {
            await Bun.$`tmux kill-pane -t ${p.paneId}`.quiet();
          } catch {}
        }
      }
    } catch {}
  }

  async function ensure(onlyWindow?: string): Promise<void> {
    const panes = await listAllPanes();
    await reclaimCorpses(panes);
    const byWindow = new Map<string, PaneRow[]>();
    for (const p of panes) {
      if (!byWindow.has(p.windowId)) byWindow.set(p.windowId, []);
      byWindow.get(p.windowId)!.push(p);
    }
    await Promise.all(
      [...byWindow.entries()].map(async ([winId, winPanes]) => {
        if (onlyWindow && winId !== onlyWindow) return;
        const stubs = winPanes.filter((p) => p.startCmd.includes(STUB_MARK));
        const work = winPanes.filter((p) => !p.startCmd.includes(STUB_MARK));
        try {
          // a window that is ONLY sidebar (work pane closed) dies naturally —
          // grace period covers the split-window creation race
          if (work.length === 0 && stubs.length) {
            const win = wins.get(winId);
            if (!win || Date.now() - win.stubBornAt > 3000) {
              wins.delete(winId);
              await Bun.$`tmux kill-window -t ${winId}`.quiet();
            }
            return;
          }
          // dedupe: keep the leftmost stub
          for (const extra of stubs.slice(1)) {
            await Bun.$`tmux kill-pane -t ${extra.paneId}`.quiet();
          }
          let stub: PaneRow | undefined = stubs.find((p) => p.left === 0) ?? stubs[0];
          if (stub && stub.left !== 0) {
            await Bun.$`tmux kill-pane -t ${stub.paneId}`.quiet();
            stub = undefined;
          }
          if (!stub) {
            const created = (
              await Bun.$`tmux split-window -f -h -b -d -l ${COLS} -t ${winId} -P -F ${`#{pane_id}${SEP}#{pane_tty}`} ${STUB_CMD}`
                .quiet()
                .text()
            )
              .trim()
              .split(SEP);
            const win = wins.get(winId) ?? freshWin(winId);
            win.stubPane = created[0] ?? null;
            win.stubTty = created[1] ?? null;
            win.stubBornAt = Date.now();
            win.modesWritten = false;
            win.lastRows = [];
            wins.set(winId, win);
            if (win.stubPane) paneToWin.set(win.stubPane, winId);
          } else if (stub.width !== COLS) {
            await Bun.$`tmux resize-pane -t ${stub.paneId} -x ${COLS}`.quiet();
          }
        } catch (e) {
          console.error(`[sidebar] ensure ${winId} failed:`, (e as { stderr?: Buffer }).stderr?.toString() ?? e);
        }
      }),
    );
  }

  // A stub that outlived a previous renderer holds a DEAD relay: its `cat`
  // blocks reading the tty and only notices the vanished socket when a
  // keystroke dies into it (SIGPIPE) — eating that keystroke, one per pane.
  // Respawn every existing stub at stand-up so they reconnect to THIS
  // renderer's socket immediately.
  async function respawnRelays(): Promise<void> {
    try {
      for (const p of await listAllPanes()) {
        if (!p.startCmd.includes(STUB_MARK)) continue;
        await Bun.$`tmux respawn-pane -k -t ${p.paneId} ${STUB_CMD}`.quiet();
      }
    } catch {}
  }

  function syncTopology(panes: PaneRow[]): void {
    const seen = new Set<string>();
    const byWindow = new Map<string, PaneRow[]>();
    for (const p of panes) {
      if (!byWindow.has(p.windowId)) byWindow.set(p.windowId, []);
      byWindow.get(p.windowId)!.push(p);
    }
    for (const [winId, winPanes] of byWindow) {
      const stub = winPanes.find((p) => p.startCmd.includes(STUB_MARK));
      if (!stub) continue;
      seen.add(winId);
      const win = wins.get(winId) ?? freshWin(winId);
      wins.set(winId, win);
      if (win.stubPane !== stub.paneId || win.stubTty !== stub.tty) {
        // new/respawned stub (new tty) — full repaint
        if (win.stubPane) paneToWin.delete(win.stubPane);
        win.stubPane = stub.paneId;
        win.stubTty = stub.tty;
        win.modesWritten = false;
        win.lastRows = [];
        paneToWin.set(stub.paneId, winId);
      }
      if (win.width !== stub.width || win.height !== stub.height) {
        win.width = stub.width;
        win.height = stub.height;
        win.modesWritten = false; // repaint full frame at the new size
        win.lastRows = [];
      }
      // pin: this window's active WORK pane (survives a visit to the sidebar)
      const activeWork = winPanes.find((p) => p.paneActive && !p.startCmd.includes(STUB_MARK));
      if (activeWork) win.activePaneId = activeWork.paneId;
      // focus fallback (focus escapes are the fast path): sidebar pane active
      // in the active window ⇔ focused
      const nowFocused = stub.paneActive && stub.windowActive;
      if (win.focused && !nowFocused) {
        win.focused = false;
        win.clickArmed = false;
        win.helpVisible = false;
        win.blockNoteFor = null;
      } else if (!win.focused && nowFocused) {
        gainFocusSoon(win);
      }
    }
    for (const [winId, win] of wins) {
      if (!seen.has(winId)) {
        if (win.stubPane) paneToWin.delete(win.stubPane);
        wins.delete(winId);
      }
    }
  }

  // ── peek reaping ─────────────────────────────────────────────────────────

  // A peek window is provisional: if its row is still parked/done and nobody
  // has looked at the window for the grace period, kill it. Engagement is
  // normally cleared by discovery's gate; the transcript re-check here covers
  // a prompt whose whole turn fit inside one discovery tick.
  async function reapPeeks(panes: PaneRow[]): Promise<void> {
    let peeks: Map<string, { windowId: string; openedAt: number }>;
    try {
      peeks = store.peeks();
    } catch {
      return;
    }
    if (!peeks.size) {
      peekLastActive.clear();
      return;
    }
    // anchors for records other writers cleared (discovery graduation) must
    // not survive to poison a later re-peek of the same session
    for (const id of peekLastActive.keys()) {
      if (!peeks.has(id)) peekLastActive.delete(id);
    }
    const now = Date.now();
    const windows = new Set(panes.map((p) => p.windowId));
    const viewed = new Set(panes.filter((p) => p.windowActive && p.attached).map((p) => p.windowId));
    for (const [id, peek] of peeks) {
      const s = findSession(id);
      // section, not overlay-presence: a DUE snooze files under needs-you —
      // a window demanding attention must not be reaped out from under it
      const sec = s ? sectionOf(s, now) : null;
      const verdict = peekVerdict({
        parkedOrDone: sec === "parked" || sec === "done",
        windowAlive: windows.has(peek.windowId),
        viewed: viewed.has(peek.windowId),
        lastActiveAt: peekLastActive.get(id) ?? now, // first sight arms the grace
        now,
      });
      if (!peekLastActive.has(id) || viewed.has(peek.windowId)) peekLastActive.set(id, now);
      if (verdict === "keep") continue;
      if (verdict === "drop") {
        applyVerb(() => {
          store.clearPeek(id);
          return true;
        });
        peekLastActive.delete(id);
        continue;
      }
      // A turn in flight must never be reaped: answering an approval or an
      // AskUserQuestion is a single keystroke that writes no prompt record, so
      // the transcript re-check below is blind to that engagement — but the
      // discovery snapshot sees the running turn it started. Keep and re-arm;
      // the window becomes reapable again once the turn ends.
      if (s?.running && s.running.finishAt > now) {
        peekLastActive.set(id, now);
        continue;
      }
      let engaged = false;
      try {
        const path = await resolveTranscriptPath(id);
        engaged = peekEngaged(peek.openedAt, path ? await readLastPromptAt(path) : null);
      } catch {}
      if (engaged) {
        applyVerb(() => {
          store.replyObserved(id, now);
          return true;
        });
      } else {
        // tmux reassigns @N ids after a server restart, so a durable peek
        // record can name an unrelated window that inherited the id. Kill only
        // a window still hosting this session's `claude -r`; any other
        // occupant means the peek window itself is gone — drop the record.
        let hostsSession = false;
        try {
          const cmds =
            await Bun.$`tmux list-panes -t ${peek.windowId} -F ${"#{pane_start_command}"}`.quiet().text();
          hostsSession = cmds.includes(id);
        } catch {}
        if (!hostsSession) {
          applyVerb(() => {
            store.clearPeek(id);
            return true;
          });
          peekLastActive.delete(id);
          continue;
        }
        const win = wins.get(peek.windowId);
        if (win?.stubPane) paneToWin.delete(win.stubPane);
        wins.delete(peek.windowId);
        try {
          await Bun.$`tmux kill-window -t ${peek.windowId}`.quiet();
        } catch {}
        applyVerb(() => {
          store.clearPeek(id);
          return true;
        });
      }
      peekLastActive.delete(id);
      paintAll();
    }
  }

  // ── input socket ─────────────────────────────────────────────────────────

  try {
    require("node:fs").rmSync(SIDEBAR_SOCK, { force: true });
  } catch {}
  // Protocol: one greeting line, then raw bytes. A stub sends `hello <pane>`
  // and every subsequent byte is that pane's stdin verbatim (nc can't frame);
  // `claude0 sidebar-ctl` connections send a single `focus <pane>` / `toggle
  // <pane>` line and close.
  function feedInput(paneId: string, bytes: string): void {
    const winId = paneToWin.get(paneId);
    const win = winId ? wins.get(winId) : undefined;
    if (!win) return;
    for (const ev of parseInput(bytes)) void handleEvent(win, ev);
  }

  Bun.listen<{ paneId?: string; buf: string; greeted: boolean }>({
    unix: SIDEBAR_SOCK,
    socket: {
      open(sock) {
        sock.data = { buf: "", greeted: false };
      },
      data(sock, chunk) {
        if (sock.data.greeted) {
          if (sock.data.paneId) feedInput(sock.data.paneId, chunk.toString());
          return;
        }
        sock.data.buf += chunk.toString();
        const nl = sock.data.buf.indexOf("\n");
        if (nl === -1) return;
        const line = sock.data.buf.slice(0, nl).trim();
        const rest = sock.data.buf.slice(nl + 1);
        sock.data.buf = "";
        sock.data.greeted = true;
        const [cmd, arg] = line.split(" ");
        if (cmd === "hello" && arg) {
          sock.data.paneId = arg;
          if (rest) feedInput(arg, rest);
        } else if (cmd === "focus" && arg) {
          void ctlFocus(arg);
        } else if (cmd === "toggle" && arg) {
          void ctlToggle(arg);
        }
      },
      error() {},
      close() {},
    },
  });

  // ── tmux wiring (bindings + bounce hook) ────────────────────────────────
  //
  // Installed on every stand-up, idempotently: tmux server state dies with
  // the server, and the daemon outliving it is exactly the point — a fresh
  // server gets rebound within a tick, no tmux.conf hook needed. The
  // after-new-window hook the prototype needed is gone too: ensure() splits
  // a missing stub within a second.
  async function installTmuxWiring(): Promise<void> {
    const ctl = (cmd: string) =>
      `${process.execPath} ${process.argv[1]} sidebar-ctl ${cmd} '#{pane_id}'`;
    // Keys from config (tmux.keys.sidebarFocus/sidebarToggle; defaults M-s/M-S).
    // The previous binds are remembered on disk so a config change unbinds them —
    // rebinding alone would leave the old key live until the tmux server restarts.
    // (popup/next stale binds are handled differently: cli.ts's setup diffs the
    // rendered tmux.conf fragment instead, since those binds live in a template.)
    const keys = tmuxKeys(configCache());
    const bindArgs = (spec: string) => {
      const parsed = parseTmuxKey(spec);
      return parsed.table === "root" ? ["-n", parsed.key] : [parsed.key];
    };
    const marker = `${PATHS.dir}/sidebar-keys.json`;
    try {
      let previous: { focus?: string; toggle?: string } = {};
      try { previous = JSON.parse(await Bun.file(marker).text()); } catch {}
      for (const [prev, current] of [[previous.focus, keys.sidebarFocus], [previous.toggle, keys.sidebarToggle]] as const) {
        if (prev && prev !== current) await Bun.$`tmux unbind-key ${bindArgs(prev)}`.quiet().nothrow();
      }
      await Bun.$`tmux bind-key ${bindArgs(keys.sidebarFocus)} run-shell ${ctl("focus")}`.quiet();
      await Bun.$`tmux bind-key ${bindArgs(keys.sidebarToggle)} run-shell ${ctl("toggle")}`.quiet();
      if (previous.focus !== keys.sidebarFocus || previous.toggle !== keys.sidebarToggle) {
        await Bun.write(marker, JSON.stringify({ focus: keys.sidebarFocus, toggle: keys.sidebarToggle }));
      }
      // cycling windows never lands you inside a sidebar — bounce to the pane
      // right of it (pure tmux, alt+[ / ] untouched)
      await Bun.$`tmux set-hook -g after-select-window ${`if -F "#{&&:#{m:*${STUB_MARK}*,#{pane_start_command}},#{e|>:#{window_panes},1}}" "select-pane -t '{right-of}'"`}`.quiet();
      // copy mode on a sidebar is only ever accidental (wheel racing the
      // mouse-mode preamble, habitual prefix-[): it freezes the frame and
      // hijacks j/k, and the renderer scrolls wheel itself — eject instantly.
      // after-copy-mode, NOT pane-mode-changed: the latter doesn't fire on
      // mode ENTER (tmux 3.7b, verified). No -t on the cancel — if-shell
      // format-expands only its condition, and the hook context already
      // targets the pane the copy-mode command ran in.
      await Bun.$`tmux set-hook -g after-copy-mode ${`if -F "#{&&:#{m:*${STUB_MARK}*,#{pane_start_command}},#{pane_in_mode}}" "send-keys -X cancel"`}`.quiet();
    } catch {}
  }

  // ── main loop ────────────────────────────────────────────────────────────

  reloadSessions();
  let tickCount = 0;
  let phase = "idle"; // what the tick was doing — named by the watchdog on a hang

  async function tick(): Promise<void> {
    tickCount++;
    // Wiring installs BEFORE the stand-down gate: M-S is the only way back
    // from hidden, so a hidden sidebar must still get its bindings on a fresh
    // tmux server (or after this entry script's path changes) — behind the
    // gate, the un-hide key itself would be the thing that's missing.
    // Periodic, not just first tick: a tmux SERVER restart wipes bindings
    // while the daemon lives on.
    phase = "wiring";
    if (tickCount === 1 || tickCount % 30 === 0) await installTmuxWiring();
    // stand down while M-S hides the sidebar or autostart is off
    phase = "gate";
    const active =
      (await Bun.file(AUTOSTART).exists()) &&
      !(await Bun.file(HIDDEN).exists());
    if (!active) {
      if (standing) console.error("[sidebar] standing down (markers)");
      standing = false;
      return;
    }
    const firstTick = !standing;
    standing = true;
    if (firstTick) console.error("[sidebar] standing up");
    phase = "relays";
    if (firstTick) await respawnRelays();
    // tmux reissues window ids from zero after a server restart, and the
    // daemon (with its in-memory maps) lives on. resumedWindows is sound for
    // one server lifetime — ids are never reused within it — but across a
    // restart a stale entry names whatever unrelated window inherited its id,
    // and Enter would commit the user into it. Epoch = server start time.
    phase = "epoch";
    try {
      const epoch = (await Bun.$`tmux display-message -p ${"#{start_time}"}`.quiet().text()).trim();
      if (tmuxEpoch !== null && epoch !== tmuxEpoch) resumedWindows.clear();
      tmuxEpoch = epoch;
    } catch {}
    phase = "ensure";
    await ensure();
    phase = "topology";
    const panes = await listAllPanes();
    syncTopology(panes);
    phase = "peeks";
    await reapPeeks(panes);

    phase = "store";
    try {
      const dv = store.dataVersion();
      if (dv !== lastDataVersion) reloadSessions();
    } catch {}
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== lastMinute) lastMinute = minute;
    // paint() diffs per line, so ticking every second is cheap
    phase = "paint";
    paintAll();
    phase = "idle";
  }

  // Self-scheduling loop, NOT setInterval: Bun's setInterval waits for an
  // async callback's promise, so one hung tmux call would freeze rendering
  // forever (while the daemon's other loops live on). The watchdog races
  // every tick; a hang logs the phase it died in and the loop keeps going.
  (async () => {
    while (true) {
      try {
        await Promise.race([
          tick(),
          Bun.sleep(10_000).then(() => {
            throw new Error(`watchdog: tick hung in phase '${phase}'`);
          }),
        ]);
      } catch (e) {
        console.error("[sidebar] tick failed:", e);
      }
      await Bun.sleep(1000);
    }
  })();
}
