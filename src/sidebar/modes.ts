/**
 * The sidebar's two text-input modes (docs/inbox.md, "Search and new session"):
 * `/` searches every retained session, `n` picks a repo to start one in. Both
 * take over the whole pane — query line on top, a cursor list, hints at the
 * bottom — and Esc returns to the inbox. Pure: the renderer owns state and IO.
 *
 * Search is not the inbox: rows carry match snippets and come in relevance
 * order, which ADR 13's labels-only / no-scoring rules don't govern (ADR 34).
 */
import { abbreviateRepo } from "../core/notifications";
import { sectionOf, type InboxSession, type Section } from "../core/inbox-model";
import { C, bg, bold, displayName, fg, fmtAge, fmtWake, plainLen, truncate } from "./ansi";
import type { RenderedView, ViewState } from "./rows";
import type { SearchHit } from "./search-worker";

export type Mode = "inbox" | "search" | "new";

export interface RepoRow {
  name: string;
  path: string;
  branch: string;
  worktree: boolean;
}

/** Where a search hit sits in the inbox right now — null = not in it (archived past RECENT, or never filed). */
export function hitSection(id: string, sessions: InboxSession[], now: number): Section | null {
  const s = sessions.find((x) => x.id === id);
  return s ? sectionOf(s, now) : null;
}

/**
 * Repos matching every query word (name, branch or directory name). A worktree
 * keeps its base row above it as context, so a match deep in a worktree list
 * still reads as "this repo, that branch".
 */
export function filterRepos(repos: RepoRow[], query: string): RepoRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (r: RepoRow) =>
    words.every((w) => `${r.name} ${r.branch} ${r.path.split("/").pop() ?? ""}`.toLowerCase().includes(w));
  const out: RepoRow[] = [];
  let base: RepoRow | null = null;
  let group: RepoRow[] = [];
  const flush = () => {
    if (!base) return;
    const wts = group.filter(matches);
    if (matches(base) || wts.length) out.push(base, ...(words.length ? wts : group));
  };
  for (const r of repos) {
    if (!r.worktree) {
      flush();
      base = r;
      group = [];
    } else group.push(r);
  }
  flush();
  return out;
}

/** Show the END of an over-long query — that's where the typing happens. */
function tail(s: string, width: number): string {
  let out = s;
  while (out && plainLen(out) > width) out = out.slice(1);
  return out.length < s.length ? `…${out.slice(1)}` : out;
}

const HIT_GLYPH: Record<Section, (s: InboxSession | undefined) => string> = {
  "needs-you": () => fg(C.peach, "●"),
  running: () => fg(C.mint, "●"),
  parked: (s) => fg(C.dim, s?.disposition?.kind === "blocked" ? "✗" : "☾"),
  done: () => fg(C.dim, "✓"),
};

function hitLines(h: SearchHit, sessions: InboxSession[], selected: boolean, width: number, now: number): string[] {
  const s = sessions.find((x) => x.id === h.sessionId);
  const section = s ? sectionOf(s, now) : null;
  const glyph = section ? HIT_GLYPH[section](s) : " ";
  const d = section === "parked" ? s?.disposition : undefined;
  const right = d?.kind === "snoozed" ? fmtWake(d.until, now) : d?.kind === "blocked" ? "blocked" : fmtAge(now - h.modified);
  const rightWidth = plainLen(right);
  const name = truncate(displayName(h.name) || h.firstPrompt || h.sessionId.slice(0, 8), width - 3 - rightWidth);
  const nameColor = section === "needs-you" || section === "running" ? C.fg : C.muted;
  const pad = " ".repeat(Math.max(1, width - 2 - plainLen(name) - rightWidth));
  const line1 = `${glyph} ${selected ? bold(fg(nameColor, name)) : fg(nameColor, name)}${pad}${fg(C.dim, right)}`;
  // why it matched, when the match was in the conversation; else where it lives
  const sub = h.matchSnippet
    ? fg(C.muted, truncate(h.matchSnippet, width - 2))
    : fg(C.dim, truncate(abbreviateRepo(h.repo) + (h.branch ? `/${h.branch}` : ""), width - 2));
  const line2 = `  ${sub}`;
  const wrap = (l: string) => (selected ? bg(C.sel, `${l} `) : l);
  return [wrap(line1), wrap(line2)];
}

function repoLine(r: RepoRow, selected: boolean, width: number): string {
  let line: string;
  if (r.worktree) {
    line = `   ${fg(C.dim, "↳")} ${fg(C.muted, truncate(r.branch || (r.path.split("/").pop() ?? ""), width - 6))}`;
  } else {
    const branch = truncate(r.branch, Math.max(4, Math.floor(width / 3)));
    const name = truncate(r.name, width - 3 - plainLen(branch));
    const pad = " ".repeat(Math.max(1, width - 1 - plainLen(name) - plainLen(branch)));
    line = ` ${selected ? bold(fg(C.fg, name)) : fg(C.fg, name)}${pad}${fg(C.dim, branch)}`;
  }
  return selected ? bg(C.sel, `${line} `) : line;
}

export function renderMode(
  sessions: InboxSession[],
  vs: ViewState,
  dims: { width: number; height: number },
  now: number,
): RenderedView {
  const width = dims.width - 1;
  const search = vs.mode === "search";
  const repos = search ? [] : filterRepos(vs.repos, vs.query);
  const count = search ? vs.hits.length : repos.length;
  const cursor = Math.max(0, Math.min(vs.modeCursor, count - 1));

  // query line: mode glyph, the typed text, the caret; result count on the right —
  // or, while the first index build runs, how far it got (conversation hits fill in)
  const right = vs.modeLoading
    ? "…"
    : search && vs.indexing !== undefined
      ? `indexing ${vs.indexing}%`
      : String(search ? vs.hitsTotal : repos.length);
  const sigil = fg(C.peach, search ? "/" : "+");
  const typed = tail(vs.query, width - 5 - plainLen(right));
  const queryPad = " ".repeat(Math.max(1, width - 4 - plainLen(typed) - plainLen(right)));
  const queryLine = ` ${sigil} ${fg(C.fg, typed)}${fg(C.peach, "▏")}${queryPad}${fg(C.dim, right)}`;

  const lines: string[] = [];
  const rowAtLine: (string | undefined)[] = [];
  let selStart = -1;
  let selEnd = -1;
  if (search) {
    vs.hits.forEach((h, i) => {
      const rowLines = hitLines(h, sessions, i === cursor, width, now);
      if (i === cursor) [selStart, selEnd] = [lines.length, lines.length + rowLines.length - 1];
      for (let k = 0; k < rowLines.length; k++) rowAtLine[lines.length + k] = h.sessionId;
      lines.push(...rowLines);
    });
  } else {
    repos.forEach((r, i) => {
      if (i === cursor) [selStart, selEnd] = [lines.length, lines.length];
      rowAtLine[lines.length] = r.path;
      lines.push(repoLine(r, i === cursor, width));
    });
  }
  // the list is capped (SEARCH_LIMIT); say how much more a sharper query would reach
  if (search && vs.hitsTotal > vs.hits.length) {
    lines.push(` ${fg(C.dim, truncate(`+${vs.hitsTotal - vs.hits.length} more — keep typing`, width - 1))}`);
    if (cursor === count - 1) selEnd = lines.length - 1; // scrolled to the end: show the note too
  }
  if (!count) {
    const empty = vs.modeLoading ? "searching…" : search ? "no matches" : vs.repos.length ? "no repos match" : "no repos found";
    lines.push(` ${fg(C.dim, empty)}`);
  }

  // content sits between the query line + spacer and one chrome line
  const contentHeight = Math.max(1, dims.height - 3);
  let scrollTop = Math.max(0, Math.min(vs.modeScrollTop, lines.length - contentHeight));
  if (selStart >= 0) {
    if (selStart < scrollTop) scrollTop = selStart;
    else if (selEnd >= scrollTop + contentHeight) scrollTop = selEnd - contentHeight + 1;
  }
  const body = lines.slice(scrollTop, scrollTop + contentHeight);
  while (body.length < contentHeight) body.push("");

  const chrome =
    vs.flash && now < vs.flashUntil
      ? ` ${fg(C.mint, truncate(vs.flash, dims.width - 2))}`
      : ` ${fg(C.dim, search ? "↵ preview  ^j/^k  ⎋ back" : "↵ start  ^j/^k  ⎋ back")}`;

  // rowAtLine is content-relative like the inbox's, offset by the two header lines
  const shifted: (string | undefined)[] = [undefined, undefined];
  for (let i = 0; i < contentHeight; i++) shifted.push(rowAtLine[scrollTop + i]);
  return {
    rows: [queryLine, "", ...body, chrome].slice(0, dims.height),
    visible: [],
    rowAtLine: shifted,
    scrollTop: 0,
    modeScrollTop: scrollTop,
  };
}
