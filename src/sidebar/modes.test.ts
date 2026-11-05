import { describe, expect, test } from "bun:test";
import { renderView, type ViewState } from "./rows";
import { filterRepos, hitSection, type RepoRow } from "./modes";
import { plainLen } from "./ansi";
import type { InboxSession } from "../core/inbox-model";
import type { SearchHit } from "./search-worker";

const NOW = Date.UTC(2026, 10, 5, 12);
const H = 3_600_000;
const DIMS = { width: 30, height: 14 };

function vs(over: Partial<ViewState> = {}): ViewState {
  return {
    focused: true,
    selectedId: null,
    activePaneId: null,
    snoozeMenuFor: null,
    snoozeDigits: "",
    snoozeUnit: "t",
    blockNoteFor: null,
    blockNote: "",
    helpVisible: false,
    flash: "",
    flashUntil: 0,
    scrollTop: 0,
    mode: "search",
    query: "",
    modeCursor: 0,
    modeScrollTop: 0,
    modeLoading: false,
    hits: [],
    hitsTotal: 0,
    repos: [],
    ...over,
  };
}

const hit = (id: string, over: Partial<SearchHit> = {}): SearchHit => ({
  sessionId: id,
  name: `session ${id}`,
  firstPrompt: "",
  repo: "claude0",
  branch: "main",
  projectPath: "/home/u/dev/claude0",
  modified: NOW - 2 * H,
  ...over,
});

const SESSIONS: InboxSession[] = [
  { id: "live", repo: "claude0", name: "live one", reason: "turn-done", since: NOW - H, real: { paneId: "%1", status: "ready" } } as InboxSession,
  { id: "snz", repo: "claude0", name: "snoozed one", reason: "turn-done", since: NOW - H, disposition: { kind: "snoozed", until: NOW + 30 * H, createdAt: NOW - H } } as InboxSession,
];

describe("search mode", () => {
  test("exactly height rows, each within width, query line on top, hints at the bottom", () => {
    const hits = Array.from({ length: 12 }, (_, i) => hit(`h${i}`, { name: "a very long session name that overflows ".repeat(2) }));
    const view = renderView([], vs({ query: "auth", hits, hitsTotal: 40 }), DIMS, NOW);
    expect(view.rows).toHaveLength(DIMS.height);
    for (const row of view.rows) expect(plainLen(row)).toBeLessThanOrEqual(DIMS.width);
    expect(view.rows[0]).toContain("/");
    expect(view.rows[0]).toContain("auth");
    expect(view.rows[0]).toContain("40");
    expect(view.rows[DIMS.height - 1]).toContain("↵ preview");
  });

  test("the cursor row stays in view and rowAtLine maps screen lines to hit ids", () => {
    const hits = Array.from({ length: 12 }, (_, i) => hit(`h${i}`));
    const view = renderView([], vs({ hits, hitsTotal: 12, modeCursor: 9 }), DIMS, NOW);
    expect(view.rows.join("\n")).toContain("session h9");
    const lines = view.rowAtLine.map((id, i) => [id, i] as const).filter(([id]) => id === "h9");
    expect(lines).toHaveLength(2); // both lines of the two-line row
    expect(view.modeScrollTop).toBeGreaterThan(0);
  });

  test("a capped list says how many more a sharper query would reach", () => {
    const hits = Array.from({ length: 3 }, (_, i) => hit(`h${i}`));
    const view = renderView([], vs({ hits, hitsTotal: 1261, modeCursor: 2 }), { width: 30, height: 30 }, NOW);
    expect(view.rows.join("\n")).toContain("+1258 more");
  });

  test("the more-note scrolls into view with the cursor on the last row", () => {
    const hits = Array.from({ length: 12 }, (_, i) => hit(`h${i}`));
    const view = renderView([], vs({ hits, hitsTotal: 500, modeCursor: 11 }), DIMS, NOW);
    expect(view.rows.join("\n")).toContain("+488 more");
  });

  test("a content match shows its snippet; otherwise repo/branch", () => {
    const view = renderView([], vs({ hits: [hit("a", { matchSnippet: "…the reaper killed…" }), hit("b")], hitsTotal: 2 }), DIMS, NOW);
    const text = view.rows.join("\n");
    expect(text).toContain("the reaper killed");
    expect(text).toContain("claude0/main");
  });

  test("a parked hit shows its wake instead of its age", () => {
    const view = renderView(SESSIONS, vs({ hits: [hit("snz")], hitsTotal: 1 }), DIMS, NOW);
    expect(view.rows.join("\n")).toContain("☾");
  });

  test("empty states: searching while loading, no matches after", () => {
    expect(renderView([], vs({ modeLoading: true }), DIMS, NOW).rows.join("\n")).toContain("searching…");
    expect(renderView([], vs({ query: "zzz" }), DIMS, NOW).rows.join("\n")).toContain("no matches");
  });

  test("an over-long query shows its end, where the typing is", () => {
    const view = renderView([], vs({ query: "x".repeat(60) + "END" }), DIMS, NOW);
    expect(view.rows[0]).toContain("END");
    expect(plainLen(view.rows[0]!)).toBeLessThanOrEqual(DIMS.width);
  });

  test("unfocused, a mode doesn't render — the glance surface stays the inbox", () => {
    const view = renderView(SESSIONS, vs({ focused: false, hits: [hit("a")] }), DIMS, NOW);
    expect(view.rows.join("\n")).toContain("NEEDS YOU");
  });
});

describe("hitSection", () => {
  test("live, parked, and not-in-inbox", () => {
    expect(hitSection("live", SESSIONS, NOW)).toBe("needs-you");
    expect(hitSection("snz", SESSIONS, NOW)).toBe("parked");
    expect(hitSection("old", SESSIONS, NOW)).toBeNull();
  });
});

describe("new-session mode", () => {
  const REPOS: RepoRow[] = [
    { name: "claude0", path: "/d/claude0", branch: "main", worktree: false },
    { name: "claude0", path: "/d/claude0/.claude/worktrees/search", branch: "sidebar-search", worktree: true },
    { name: "claude0", path: "/d/claude0/.claude/worktrees/fts", branch: "fts-index", worktree: true },
    { name: "throxy", path: "/d/throxy", branch: "main", worktree: false },
  ];

  test("empty filter lists everything, worktrees under their base", () => {
    expect(filterRepos(REPOS, "").map((r) => r.path)).toEqual(REPOS.map((r) => r.path));
  });

  test("a worktree match keeps its base as context and drops non-matching siblings", () => {
    expect(filterRepos(REPOS, "fts").map((r) => r.path)).toEqual(["/d/claude0", "/d/claude0/.claude/worktrees/fts"]);
  });

  test("every word must match", () => {
    expect(filterRepos(REPOS, "throxy main").map((r) => r.path)).toEqual(["/d/throxy"]);
    expect(filterRepos(REPOS, "throxy fts")).toEqual([]);
  });

  test("renders the + sigil, the filtered count, and indented worktrees", () => {
    const view = renderView([], vs({ mode: "new", repos: REPOS, query: "claude" }), DIMS, NOW);
    expect(view.rows[0]).toContain("+");
    expect(view.rows[0]).toContain("3");
    expect(view.rows.join("\n")).toContain("↳");
    expect(view.rowAtLine).toContain("/d/claude0/.claude/worktrees/fts");
    for (const row of view.rows) expect(plainLen(row)).toBeLessThanOrEqual(DIMS.width);
  });
});
