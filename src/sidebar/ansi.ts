/**
 * Raw-ANSI text helpers for the sidebar renderer. The renderer paints pane
 * ttys directly (no blessed), so styling is plain SGR — truecolor fg/bg with
 * explicit resets, never a bare full-reset mid-line (a row-wide bg must
 * survive its inner fg changes).
 */

import { TICKET_ID_SOURCE } from "../core/git";

// Vesper palette (CLAUDE.md)
export const C = {
  fg: "#FFFFFF",
  muted: "#A0A0A0",
  dim: "#505050",
  surface: "#1C1C1C",
  // selection bg: surface (#1C1C1C) on bg (#101010) was near-invisible, and
  // #333333 still washed out on lesser displays — the selector needs to read
  // at a glance from the main pane
  sel: "#404040",
  peach: "#FFC799",
  mint: "#99FFE4",
  red: "#FF8080",
} as const;

function rgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

export function fg(color: string, s: string): string {
  const [r, g, b] = rgb(color);
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

export function bold(s: string): string {
  return `\x1b[1m${s}\x1b[22m`;
}

/** Row-wide background (the selector). 49 = default bg, not a full reset. */
export function bg(color: string, s: string): string {
  const [r, g, b] = rgb(color);
  return `\x1b[48;2;${r};${g};${b}m${s}\x1b[49m`;
}

const SGR = /\x1b\[[0-9;]*m/g;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Printable terminal-cell width of a line, ignoring the SGR sequences we emit. */
export function plainLen(s: string): number {
  return Bun.stringWidth(s.replace(SGR, ""));
}

export function truncate(s: string, w: number): string {
  if (w <= 0) return "";
  if (Bun.stringWidth(s) <= w) return s;

  const ellipsis = "…";
  const contentWidth = w - Bun.stringWidth(ellipsis);
  if (contentWidth <= 0) return ellipsis;

  let out = "";
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(s)) {
    const segmentWidth = Bun.stringWidth(segment);
    if (used + segmentWidth > contentWidth) break;
    out += segment;
    used += segmentWidth;
  }
  return out + ellipsis;
}

export function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Wake display on rows: RELATIVE ("in how long"), matching the age style —
// "8-14" style dates read as noise at a glance. Exact moment lives in the
// selection detail line via fmtWakeAbs. The math lives in shared/wake-format.js
// because portkey renders the same countdown (served as /wake-format.js).
export { formatWakeIn as fmtWake } from "../shared/wake-format";

// Exact wake for the detail line, snooze-form preview and commit flash:
// shared with portkey's snooze toast (served as /wake-abs.js) so one wake
// never renders two ways. Fixed English format; splits on the LOCAL calendar day.
export { formatWakeAbs as fmtWakeAbs } from "../shared/wake-abs";

// Branch names bury the ticket ID mid-string; the prefix before it is the
// useless half ("marcelmiro-ENG-2687-pass-…" → "ENG-2687-pass-…").
const TICKET_ID_RE = new RegExp(TICKET_ID_SOURCE, "i");
export function displayName(name: string): string {
  const m = name.match(TICKET_ID_RE);
  return m && m.index! > 0 ? name.slice(m.index!) : name;
}
