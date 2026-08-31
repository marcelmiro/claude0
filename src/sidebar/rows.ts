/**
 * Sidebar view builder — pure. Ports the prototype sidebar's render()
 * verbatim (ADR 0013 addendum 2 is the spec): sections, glyph language,
 * color tiers, chrome (hints / detail / snooze menu / block note / help),
 * pin vs selector, scroll. The renderer diffs the returned rows against
 * what each pane last showed.
 *
 * Rendering constraints learned the hard way (prototype week):
 * - terminal layout is measured in cells, not UTF-16 code units. Emoji are
 *   normally two cells; combining marks and ZWJ sequences are not one cell
 *   per code unit. `plainLen`/`truncate` own that accounting.
 * - width is a hard invariant: a row line NEVER exceeds the pane (overflow
 *   wraps, shifting every row below and corrupting click + scroll math).
 */
import { abbreviateRepo } from "../core/notifications";
import {
  deriveSections,
  effectiveSince,
  isWoken,
  wakeAt,
  type InboxSession,
  type Section,
} from "../core/inbox-model";
import { C, bg, bold, displayName, fg, fmtAge, fmtWake, fmtWakeAbs, plainLen, truncate } from "./ansi";

export interface VisibleRow {
  id: string;
  section: Section;
}

export type SnoozeUnit = "t" | "d" | "h";
/** Form order = Tab-cycle order, most→least used. `t` = 8AM on the +N calendar day. */
export const SNOOZE_UNITS: [SnoozeUnit, string][] = [
  ["t", "8am"],
  ["d", "day"],
  ["h", "hr"],
];

/** Per-window interaction state the view depends on. */
export interface ViewState {
  focused: boolean;
  selectedId: string | null;
  activePaneId: string | null;
  snoozeMenuFor: string | null;
  snoozeDigits: string;
  snoozeUnit: SnoozeUnit;
  blockNoteFor: string | null;
  blockNote: string;
  helpVisible: boolean;
  flash: string;
  flashUntil: number;
  scrollTop: number;
}

export interface RenderedView {
  /** Exactly dims.height lines, ANSI-styled, each ≤ width printable cells. */
  rows: string[];
  visible: VisibleRow[];
  /** Content line index (pre-scroll) → session id, both lines of a 2-line row. */
  rowAtLine: (string | undefined)[];
  /** Clamped/adjusted scroll — the renderer writes it back to the state. */
  scrollTop: number;
}

// keys only — what they do lives behind ?
const SECTION_HINTS: Record<Section, string> = {
  "needs-you": "↵  s b e f  ?",
  running: "↵  e f  ?",
  parked: "↵  b s e f  ?",
  done: "↵  e f  ?",
};

function helpLines(): string[] {
  return [
    "",
    ` ${bold(fg(C.dim, "navigate"))}`,
    ` ${fg(C.fg, "j/k")}     ${fg(C.muted, "move")}`,
    ` ${fg(C.fg, "J/K")}     ${fg(C.muted, "jump section")}`,
    ` ${fg(C.fg, "g/G")}     ${fg(C.muted, "top / bottom")}`,
    "",
    ` ${bold(fg(C.dim, "act"))}`,
    ` ${fg(C.fg, "↵ click")} ${fg(C.muted, "show session")}`,
    `         ${fg(C.dim, "again: enter pane")}`,
    `         ${fg(C.dim, "parked/recent: peek")}`,
    ` ${fg(C.fg, "s")}       ${fg(C.muted, "snooze, pick time")}`,
    ` ${fg(C.fg, "b")}       ${fg(C.muted, "block, type note")}`,
    `         ${fg(C.dim, "parked: unpark")}`,
    ` ${fg(C.fg, "e")}       ${fg(C.muted, "done + close pane")}`,
    `         ${fg(C.dim, "recent: undo")}`,
    ` ${fg(C.fg, "f")}       ${fg(C.muted, "fork, new window")}`,
    "",
    ` ${bold(fg(C.dim, "leave"))}`,
    ` ${fg(C.fg, "q ⎋")}    ${fg(C.muted, "back to work pane")}`,
    ` ${fg(C.fg, "M-s")}     ${fg(C.muted, "toggle from anywhere")}`,
  ];
}

// detail row only where it carries AUTHORED info — for normal rows a
// repo/name echo just duplicated the list
export function detailFor(s: InboxSession, now: number): string | null {
  if (s.disposition?.kind === "blocked") return `✗ ${s.disposition.note}`;
  if (s.disposition?.kind === "snoozed") return `☾ until ${fmtWakeAbs(s.disposition.until, now)}`;
  return null;
}

// Rows: name (status-colored — the section's color) + right slot on top;
// abbreviated repo + PR chip underneath on two-line rows.
function sessionLine(
  s: InboxSession,
  vs: ViewState,
  width: number,
  nameColor: string,
  opts: { right: string; rightColor: string; rightRendered?: string; oneLine?: boolean },
): string[] {
  const right = truncate(opts.right, Math.max(2, width - 9));
  const name = displayName(s.name) || s.id.slice(0, 8);
  const rightWidth = plainLen(right);
  const label = truncate(name, width - 1 - rightWidth - 1);
  const labelWidth = plainLen(label);
  const pad = " ".repeat(Math.max(1, width - 1 - labelWidth - rightWidth));
  const sel = vs.focused && s.id === vs.selectedId;
  // passive "you are here" pin: the session in this window's active pane.
  // white, not a status color — the bar means "you are here" regardless of
  // the session's state (mint here read as "running")
  const pinned = !!vs.activePaneId && s.real?.paneId === vs.activePaneId;
  const marker = pinned ? fg(C.fg, "▎") : " ";
  const name1 = sel ? bold(fg(nameColor, label)) : fg(nameColor, label);
  // rightRendered = caller-colored right slot (glyph vs age in different
  // colors); only usable when truncation didn't alter the plain string
  const rightOut =
    opts.rightRendered && right === opts.right ? opts.rightRendered : fg(opts.rightColor, right);
  const line1 = `${marker}${name1}${pad}${rightOut}`;

  // the trailing space runs the bg to the pane border
  const wrap = (l: string) => (sel ? bg(C.sel, `${l} `) : l);
  if (opts.oneLine) return [wrap(line1)];

  // `repo/branch` (tmux short repo names), dim, aligned with the name.
  // PR chip: open → #N (alive, actionable); merged → ✓ alone (landed — the
  // Claude0 "clear me" cue); anything else → nothing.
  const repo = abbreviateRepo(s.repo) + (s.branch ? `/${s.branch}` : "");
  let prText = "";
  let prColor: string = C.dim;
  if (s.pr?.number && s.pr.state === "merged") {
    prText = "✓";
    prColor = C.mint;
  } else if (s.pr?.number && s.pr.state === "open") {
    prText = `#${s.pr.number}`;
    prColor = C.muted;
  }
  const prWidth = plainLen(prText);
  const repoLabel = truncate(repo, width - 1 - prWidth - 1);
  const repoWidth = plainLen(repoLabel);
  const pad2 = " ".repeat(Math.max(1, width - 1 - repoWidth - prWidth));
  const line2 = `${marker}${fg(C.dim, repoLabel)}${pad2}${prText ? fg(prColor, prText) : ""}`;
  return [wrap(line1), wrap(line2)];
}

export function renderView(
  sessions: InboxSession[],
  vs: ViewState,
  dims: { width: number; height: number },
  now: number,
): RenderedView {
  const width = dims.width - 1;
  const height = dims.height;

  // help overlay (focused only): content swaps wholesale, chrome shows close keys
  if (vs.helpVisible && vs.focused) {
    const content = helpLines().slice(0, Math.max(0, height - 1));
    while (content.length < height - 1) content.push("");
    content.push(` ${fg(C.dim, "? q ⎋ close")}`);
    return { rows: content, visible: [], rowAtLine: [], scrollTop: 0 };
  }

  const sections = deriveSections(sessions, now);
  const { needsYou, running, parked, done } = sections;
  const lines: string[] = [];
  const visible: VisibleRow[] = [];
  const rowAtLine: (string | undefined)[] = [];
  let selLine = -1;

  // absurdly narrow pane (layout accident): counts only, no letter-soup
  if (width < 16) {
    const rows = [
      "",
      ` ${fg(C.peach, `●${needsYou.length}`)}`,
      ` ${fg(C.mint, `⦿${running.length}`)}`,
      ` ${fg(C.dim, `⏸${parked.length}`)}`,
    ].slice(0, height);
    while (rows.length < height) rows.push("");
    return { rows, visible: [], rowAtLine: [], scrollTop: 0 };
  }

  const header = (label: string, count: number | null, color: string) =>
    lines.push(bold(fg(color, ` ${label}`) + (count === null ? "" : fg(color, ` ${count}`))));

  const push = (s: InboxSession, section: Section, rowLines: string[]) => {
    if (vs.focused && s.id === vs.selectedId && selLine === -1) selLine = lines.length;
    for (let k = 0; k < rowLines.length; k++) rowAtLine[lines.length + k] = s.id;
    lines.push(...rowLines);
    visible.push({ id: s.id, section });
  };

  lines.push("");
  header("NEEDS YOU", needsYou.length, needsYou.length ? C.peach : C.dim);
  for (const s of needsYou) {
    const woken = isWoken(s, now) || s.fromSnooze;
    const age = fmtAge(now - effectiveSince(s, now));
    const glyph = woken ? "↺ " : s.reason === "question" ? "? " : s.reason === "approval" ? "! " : "";
    // names stay white — peach is reserved for signal: the reason glyph, and
    // a stale (>1d) age, escalating to red past 3d (ignored debt should
    // burn). The whole point is not losing these.
    const ignored = now - effectiveSince(s, now);
    const ageColor = ignored >= 3 * 86_400_000 ? C.red : ignored >= 86_400_000 ? C.peach : C.muted;
    push(s, "needs-you", sessionLine(s, vs, width, C.fg, {
      right: `${glyph}${age}`,
      rightColor: C.muted,
      rightRendered: (glyph ? fg(C.peach, glyph) : "") + fg(ageColor, age),
    }));
  }

  lines.push("");
  header("RUNNING", running.length, running.length ? C.mint : C.dim);
  for (const s of running) {
    // mode rides the right slot: ⧗ = turn done but a background script still
    // runs, aged from when the script-wait began; bare age = turn in flight,
    // since your last prompt.
    const age = fmtAge(now - (s.script ? (s.scriptSince ?? s.since) : s.since));
    push(s, "running", sessionLine(s, vs, width, C.fg, {
      right: `${s.script ? "⧗ " : ""}${age}`,
      rightColor: C.dim,
      rightRendered: (s.script ? fg(C.mint, "⧗ ") : "") + fg(C.dim, age),
    }));
  }

  lines.push("");
  lines.push(bold(fg(C.dim, ` PARKED ${parked.length}`)));
  for (const s of parked) {
    const d = s.disposition!;
    const right = d.kind === "snoozed" ? `☾ ${fmtWake(d.until, now)}` : `✗ ${d.note}`;
    // names muted, glyph slots dim: parked and RECENT rows keep readable
    // names while their metadata stays quiet — only headers carry section
    // weight down here
    push(s, "parked", sessionLine(s, vs, width, C.muted, { right: truncate(right, 12), rightColor: C.dim, oneLine: true }));
  }

  if (done.length) {
    lines.push("");
    header("RECENT", null, C.dim);
    for (const s of done) {
      push(s, "done", sessionLine(s, vs, width, C.muted, { right: fmtAge(now - s.archivedAt!), rightColor: C.dim, oneLine: true }));
    }
  }

  if (!sessions.length) {
    lines.push("", fg(C.dim, " inbox zero ✓"));
  }

  // chrome: hints bottom-most, detail row above it ONLY when the selected row
  // has authored info. Unfocused = pure glance surface, no chrome, top-pinned.
  const sel = sessions.find((s) => s.id === vs.selectedId);
  const detail = vs.focused && sel ? detailFor(sel, now) : null;
  // the snooze form spends a second chrome line (unit blocks + amount/preview)
  const chromeRows = (vs.focused && vs.snoozeMenuFor ? 2 : 1) + (detail ? 1 : 0);
  const contentHeight = Math.max(1, height - chromeRows);

  // scroll: glance mode always shows the top (Needs you); focused keeps the
  // selection in view
  let scrollTop = vs.focused ? Math.max(0, Math.min(vs.scrollTop, lines.length - contentHeight)) : 0;
  if (vs.focused && selLine >= 0) {
    if (selLine < scrollTop) scrollTop = selLine;
    else if (selLine >= scrollTop + contentHeight) scrollTop = selLine - contentHeight + 1;
  }

  const rows = lines.slice(scrollTop, scrollTop + contentHeight);
  while (rows.length < contentHeight) rows.push("");
  if (detail) rows.push(` ${fg(C.muted, truncate(detail, dims.width - 2))}`);

  if (!vs.focused) {
    rows.push("");
  } else if (vs.blockNoteFor) {
    const w = dims.width - 12;
    rows.push(` ${fg(C.peach, "✗")} ${truncate(vs.blockNote, Math.max(4, w))}${fg(C.peach, "▏")} ${fg(C.dim, "↵ ⎋")}`);
  } else if (vs.snoozeMenuFor) {
    // two-line form: unit blocks (Tab / direct key selects), then amount +
    // resolved-wake preview. Empty amount = overwritable placeholder 1 (dim).
    const blocks = SNOOZE_UNITS.map(([u, label]) => {
      const inner = ` ${bold(fg(C.fg, u))} ${fg(u === vs.snoozeUnit ? C.fg : C.muted, label)} `;
      return u === vs.snoozeUnit ? bg(C.sel, inner) : inner;
    }).join(" ");
    rows.push(` ${blocks}`);
    // caret AFTER typed digits (cursor at end of input), BEFORE the placeholder
    // (insertion point at start — the dim 1 is untyped, so typing replaces it).
    // ▏ inks the LEFT edge of its cell, ▕ the RIGHT — each hugs the digit it
    // sits against. The typed branch pads one cell where the caret's cell was,
    // so the first digit lands in the placeholder's own column and the bar
    // advances a cell — typing reads as replace-in-place, not a digit hop.
    const amount = vs.snoozeDigits
      ? ` ${fg(C.fg, vs.snoozeDigits)}${fg(C.peach, "▏")}`
      : `${fg(C.peach, "▕")}${fg(C.dim, "1")}`;
    const preview = fmtWakeAbs(wakeAt(now, Number(vs.snoozeDigits || "1"), vs.snoozeUnit), now);
    rows.push(
      ` ${fg(C.peach, "☾")} ${amount} ${fg(C.muted, "→")} ${fg(C.fg, preview)}  ${fg(C.dim, "↵ ⎋")}`,
    );
  } else if (vs.flash && now < vs.flashUntil) {
    rows.push(` ${fg(C.mint, truncate(vs.flash, dims.width - 2))}`);
  } else {
    const section = visible.find((v) => v.id === vs.selectedId)?.section;
    rows.push(` ${fg(C.dim, section ? SECTION_HINTS[section] : "j/k J/K ↵ s b e f q ?")}`);
  }

  return { rows, visible, rowAtLine, scrollTop };
}
