import type { Widgets } from "blessed";
import type { RepoGroup, DisplayRow, Session } from "../types";
import { C, statusColor, statusDot } from "./colors";
import { formatTimeAgo, sessionActivityAt } from "../core/status";
import { extractTicketId } from "../core/git";
import { buildSessionLabel, disambiguateNames } from "../core/session-label";

export { extractTicketId, buildSessionLabel };

/**
 * Map sessionId → display name, disambiguating same-repo name collisions
 * (`fix-auth`, `fix-auth-2`) across the labeled session rows. Only rows actually
 * rendered with a label participate, so a collapsed/hidden archived session never
 * perturbs a visible name.
 */
function disambiguationMap(rows: DisplayRow[], order: Map<string, number>): Map<string, string> {
  const byRepo = new Map<string, Array<{ id: string; name: string }>>();
  for (const row of rows) {
    if (row.type !== "session") continue;
    const s = row.session;
    const bucket = byRepo.get(s.repo);
    if (bucket) bucket.push({ id: s.id, name: s.name });
    else byRepo.set(s.repo, [{ id: s.id, name: s.name }]);
  }
  const out = new Map<string, string>();
  for (const items of byRepo.values()) {
    for (const [id, name] of disambiguateNames(items, order)) out.set(id, name);
  }
  return out;
}

/**
 * Converts RepoGroup array into a flat list of DisplayRow items.
 * For each group: add a repo-header row, then session rows (with optional detail rows).
 * Adds a blank separator before each group except the first.
 */
export function buildDisplayRows(groups: RepoGroup[], showArchived = true): DisplayRow[] {
  const rows: DisplayRow[] = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];

    // Partition sessions into non-archived and archived
    const nonArchived = group.sessions.filter((s) => s.status !== "archived");
    const archived = group.sessions.filter((s) => s.status === "archived");

    // Skip groups with no visible sessions
    if (nonArchived.length === 0 && archived.length === 0) continue;

    // Add blank separator before each group except the first
    if (rows.length > 0) {
      rows.push({ type: "separator" });
    }

    // Repo header (compact — no separator after)
    rows.push({ type: "repo-header", name: group.name, path: group.path });

    // Non-archived session rows with optional detail rows
    for (const session of nonArchived) {
      rows.push({ type: "session", session });
      if (session.summary) {
        rows.push({ type: "session-detail", session });
      }
    }

    // Archived sessions: show individually or collapsed
    if (archived.length > 0) {
      if (showArchived) {
        for (const session of archived) {
          rows.push({ type: "session", session });
          if (session.summary) {
            rows.push({ type: "session-detail", session });
          }
        }
      } else {
        rows.push({
          type: "archive-collapsed",
          repoName: group.name,
          count: archived.length,
          sessions: archived,
        });
      }
    }
  }

  return rows;
}

/**
 * Renders the display rows into the blessed box using box.setContent().
 * Uses blessed tags for colors.
 */
export function renderSessionList(
  box: Widgets.BoxElement,
  rows: DisplayRow[],
  selectedIndex: number,
  attentionKeys: Set<string> | undefined,
  order: Map<string, number>,
): void {
  const lines: string[] = [];
  const dnMap = disambiguationMap(rows, order);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (row.type === "repo-header") {
      lines.push(
        `{bold}{${C.peach}-fg}  ${row.name.toUpperCase()}{/${C.peach}-fg}{/bold}`,
      );
    } else if (row.type === "separator") {
      lines.push("");
    } else if (row.type === "session-detail") {
      const session = row.session;
      // Check if parent session row (i-1) is selected
      const parentSelected = (i - 1) === selectedIndex;
      const escaped = session.summary
        .replace(/\{/g, "{open}")
        .replace(/\}/g, "{close}");
      // 4ch indent to align under label text
      const boxWidth = typeof box.width === "number" ? box.width : 60;
      const maxLen = Math.max(10, boxWidth - 6);
      const truncated = escaped.length > maxLen ? escaped.slice(0, maxLen - 1) + "\u2026" : escaped;

      if (parentSelected) {
        lines.push(
          `{${C.surface}-bg}    {${C.muted}-fg}${truncated}{/${C.muted}-fg}{/${C.surface}-bg}`,
        );
      } else {
        lines.push(
          `    {${C.dim}-fg}${truncated}{/${C.dim}-fg}`,
        );
      }
    } else if (row.type === "session") {
      const session = row.session;
      const isSelected = i === selectedIndex;
      const isDimmed = session.status === "idle" || session.status === "archived";

      // Check if this session needs attention (blinking dot)
      const sessionKey = session.tmuxPane?.paneId ?? session.id;
      const needsAttention = attentionKeys?.has(sessionKey) ?? false;

      // Column layout: cursor(2) | label | gap(≥2) | dot status(10) | time(5) |
      // Right block is fixed at 15 display cols. Label fills remaining space.
      const cursor = isSelected ? `{${C.peach}-fg}▸{/${C.peach}-fg} ` : "  ";
      const boxWidth = typeof box.width === "number" ? box.width : 40;
      const contentWidth = boxWidth - 3; // scrollbar + unicode wide-char safety

      const dot = statusDot(session.status);
      const sColor = statusColor(session.status);
      const dotStr = needsAttention ? `{blink}${dot}{/blink}` : dot;
      const statusText = (session.status === "ready" ? "input" : session.status).padEnd(8);
      const timeStr = formatTimeAgo(sessionActivityAt(session)).padStart(5);

      // \u23f3 = ready but still waiting on a live background script. The emoji renders
      // 2 cols but counts 1 in .length, so the gap math subtracts the extra column.
      const waitMark = session.scriptWaiting ? "\u23f3 " : "";
      const waitCols = session.scriptWaiting ? 1 : 0;
      const rawLabel = waitMark + buildSessionLabel(session, dnMap.get(session.id));
      const labelMax = Math.max(8, contentWidth - 2 - 15 - 2 - waitCols);
      const truncLabel = rawLabel.length > labelMax
        ? rawLabel.slice(0, labelMax - 1) + "\u2026"
        : rawLabel;
      const gap = " ".repeat(Math.max(2, contentWidth - 2 - truncLabel.length - waitCols - 15));

      if (isSelected) {
        lines.push(
          `{${C.surface}-bg}` +
            cursor +
            `{bold}{${C.fg}-fg}${truncLabel}{/${C.fg}-fg}{/bold}` +
            gap +
            `{${sColor}-fg}${dotStr} ${statusText}{/${sColor}-fg}` +
            `{${C.muted}-fg}${timeStr}{/${C.muted}-fg}` +
            `{/${C.surface}-bg}`,
        );
      } else if (isDimmed) {
        lines.push(
          `{${C.dim}-fg}` +
            "  " +
            truncLabel +
            gap +
            `${dot} ${statusText}` +
            timeStr +
            `{/${C.dim}-fg}`,
        );
      } else {
        lines.push(
          "  " +
            `{${C.muted}-fg}${truncLabel}{/${C.muted}-fg}` +
            gap +
            `{${sColor}-fg}${dotStr} ${statusText}{/${sColor}-fg}` +
            `{${C.muted}-fg}${timeStr}{/${C.muted}-fg}`,
        );
      }
    } else if (row.type === "archive-collapsed") {
      const isSelected = i === selectedIndex;
      const label = `${row.count} archived`;
      if (isSelected) {
        lines.push(
          `{${C.surface}-bg}{${C.peach}-fg}▸{/${C.peach}-fg} {${C.muted}-fg}${label}{/${C.muted}-fg}{/${C.surface}-bg}`,
        );
      } else {
        lines.push(
          `  {${C.dim}-fg}${label}{/${C.dim}-fg}`,
        );
      }
    }
  }

  box.setContent(lines.join("\n"));

  // Scroll to keep the selected row visible within the box
  if (selectedIndex >= 0) {
    const boxHeight = (box as any).height as number;
    const visibleHeight = typeof boxHeight === "number" ? boxHeight - 2 : 20; // -2 for padding/border
    const scrollPos = (box as any).childBase || 0;

    // Also ensure the detail row below (if any) is visible
    let bottomRow = selectedIndex;
    if (selectedIndex + 1 < rows.length && rows[selectedIndex + 1].type === "session-detail") {
      bottomRow = selectedIndex + 1;
    }

    if (selectedIndex < scrollPos) {
      // Walk backwards through repo-header and separator rows to keep context visible
      let scrollTarget = selectedIndex;
      for (let r = selectedIndex - 1; r >= 0; r--) {
        const rt = rows[r].type;
        if (rt === "repo-header" || rt === "separator") {
          scrollTarget = r;
        } else {
          break;
        }
      }
      box.scrollTo(scrollTarget);
    } else if (bottomRow >= scrollPos + visibleHeight) {
      box.scrollTo(bottomRow - visibleHeight + 1);
    }
  }
}

/**
 * Returns indices of rows that are "session" type (not headers, separators, or details).
 * Used for j/k navigation.
 */
export function getSelectableIndices(rows: DisplayRow[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].type;
    if (t === "session" || t === "archive-collapsed") {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Moves to the first selectable row of the next/previous repo group.
 * Used for J/K (shift) navigation. Wraps around at boundaries.
 */
export function moveToGroup(
  rows: DisplayRow[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  const selectable = getSelectableIndices(rows);
  if (selectable.length === 0) return currentIndex;

  // Find which repo-header each selectable row belongs to
  // by scanning backwards from each selectable index to find its group header
  function groupHeaderFor(rowIdx: number): number {
    for (let r = rowIdx; r >= 0; r--) {
      if (rows[r].type === "repo-header") return r;
    }
    return 0;
  }

  const currentGroup = groupHeaderFor(currentIndex);

  if (direction === 1) {
    // Find first selectable row in the next group
    const next = selectable.find((idx) => groupHeaderFor(idx) > currentGroup);
    if (next !== undefined) return next;
    // Wrap to first selectable
    return selectable[0];
  } else {
    // Find first selectable row in the previous group
    const prevGroups = selectable.filter((idx) => groupHeaderFor(idx) < currentGroup);
    if (prevGroups.length > 0) {
      // Jump to the first session of the previous group
      const prevGroupHeader = groupHeaderFor(prevGroups[prevGroups.length - 1]);
      const first = selectable.find((idx) => groupHeaderFor(idx) === prevGroupHeader);
      if (first !== undefined) return first;
    }
    // Wrap to last group's first selectable
    const lastGroupHeader = groupHeaderFor(selectable[selectable.length - 1]);
    const first = selectable.find((idx) => groupHeaderFor(idx) === lastGroupHeader);
    return first ?? selectable[selectable.length - 1];
  }
}

/**
 * Moves from currentIndex to the next selectable row in the given direction.
 * Skips repo-header and separator rows. Wraps around at boundaries.
 * Returns the new index.
 */
export function moveSelection(
  rows: DisplayRow[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  const selectable = getSelectableIndices(rows);
  if (selectable.length === 0) return currentIndex;

  const currentPos = selectable.indexOf(currentIndex);

  if (currentPos === -1) {
    // Current index is not selectable; return first selectable
    return selectable[0];
  }

  let nextPos = currentPos + direction;

  // Wrap around
  if (nextPos < 0) {
    nextPos = selectable.length - 1;
  } else if (nextPos >= selectable.length) {
    nextPos = 0;
  }

  return selectable[nextPos];
}

// ---------------------------------------------------------------------------
// Search / filter
// ---------------------------------------------------------------------------

function isSubsequence(sub: string, str: string): boolean {
  let j = 0;
  for (let i = 0; i < str.length && j < sub.length; i++) {
    if (str[i] === sub[j]) j++;
  }
  return j === sub.length;
}

function fuzzyScore(candidate: string, needle: string): number {
  if (candidate === needle) return 100;
  if (candidate.startsWith(needle)) return 80;
  if (candidate.includes(needle)) return 60;
  const words = candidate.split(/[-_\s]+/);
  if (words.some((w) => w.startsWith(needle))) return 40;
  if (isSubsequence(needle, candidate)) return 20;
  return 0;
}

/** Score a session against a search needle across all searchable fields. */
export function scoreSessionMatch(session: Session, needle: string): number {
  const lower = needle.toLowerCase();
  let best = 0;

  const fields = [
    session.name,
    session.branch,
    session.repo,
    extractTicketId(session.branch),
    session.summary,
    buildSessionLabel(session),
  ];

  for (const field of fields) {
    if (!field) continue;
    const score = fuzzyScore(field.toLowerCase(), lower);
    if (score > best) best = score;
  }

  return best;
}

/**
 * Filter DisplayRow[] by search string, preserving group structure.
 * Keeps repo headers that have at least one matching session underneath.
 * Strips empty groups and their separators.
 */
export function filterDisplayRows(rows: DisplayRow[], filter: string): DisplayRow[] {
  if (!filter) return rows;

  // Score every session row
  const sessionScores = new Map<number, number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.type === "session") {
      sessionScores.set(i, scoreSessionMatch(row.session, filter));
    }
  }

  // Walk rows, keeping groups that have at least one matching session
  const result: DisplayRow[] = [];
  let pendingSeparator: DisplayRow | null = null;
  let pendingHeader: DisplayRow | null = null;
  let groupHasMatch = false;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (row.type === "separator") {
      // Flush previous group if it had matches
      // Hold this separator for the next group
      pendingSeparator = row;
      pendingHeader = null;
      groupHasMatch = false;
      continue;
    }

    if (row.type === "repo-header") {
      pendingHeader = row;
      groupHasMatch = false;
      continue;
    }

    if (row.type === "session") {
      const score = sessionScores.get(i) ?? 0;
      if (score > 0) {
        // Emit pending separator + header if this is the first match in the group
        if (!groupHasMatch) {
          if (result.length > 0 && pendingSeparator) {
            result.push(pendingSeparator);
          }
          if (pendingHeader) {
            result.push(pendingHeader);
          }
          groupHasMatch = true;
        }
        result.push(row);
      }
      continue;
    }

    if (row.type === "session-detail") {
      // Include detail row if its parent session was included
      const parentIdx = i - 1;
      const parentScore = sessionScores.get(parentIdx) ?? 0;
      if (parentScore > 0) {
        result.push(row);
      }
      continue;
    }

    if (row.type === "archive-collapsed") {
      // Check if any archived session in this collapsed row matches
      const hasMatch = row.sessions.some((s) => scoreSessionMatch(s, filter) > 0);
      if (hasMatch) {
        if (!groupHasMatch) {
          if (result.length > 0 && pendingSeparator) {
            result.push(pendingSeparator);
          }
          if (pendingHeader) {
            result.push(pendingHeader);
          }
          groupHasMatch = true;
        }
        result.push(row);
      }
    }
  }

  return result;
}
