import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { readSearchArtifacts, scoreSearchEntry, filterAndRankEntries, searchEntries, addContentSnippets, type SearchEntry } from "./search";
import type { ContentIndex } from "./search-index";

let dir: string;
let n = 0;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/c0-search-`);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function transcript(lines: object[]): string {
  const path = `${dir}/t${n++}.jsonl`;
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

const turn = (type: "user" | "assistant", text: string, timestamp: string) => ({
  type,
  timestamp,
  message: { role: type, content: text },
});

// --- readSearchArtifacts ------------------------------------------------------

test("a large transcript's last reply and turn time come from its tail", async () => {
  const filler = Array.from({ length: 700 }, (_, i) =>
    turn("assistant", `filler block ${i} ${"x".repeat(80)}`, "2026-07-01T10:00:00.000Z"),
  );
  const path = transcript([
    turn("user", "please fix the login flow", "2026-07-01T09:00:00.000Z"),
    ...filler,
    turn("assistant", "done: the xylophone-widget bug is fixed", "2026-07-01T12:00:00.000Z"),
  ]);
  const a = await readSearchArtifacts(path);
  expect(a.lastAssistant).toBe("done: the xylophone-widget bug is fixed");
  expect(a.lastTurnAt).toBe(Date.parse("2026-07-01T12:00:00.000Z"));
});

test("lastTurnAt is the newest conversational turn, not trailing bookkeeping", async () => {
  const path = transcript([
    turn("assistant", "wrapped up", "2026-07-01T12:34:56.000Z"),
    { type: "file-history-snapshot", messageId: "x" },
    { type: "last-prompt", prompt: "..." },
  ]);
  const a = await readSearchArtifacts(path);
  expect(a.lastTurnAt).toBe(Date.parse("2026-07-01T12:34:56.000Z"));
});

test("lastAssistant is the final assistant message, truncated for display", async () => {
  const long = "z".repeat(300);
  const path = transcript([
    turn("assistant", "earlier answer", "2026-07-01T10:00:00.000Z"),
    turn("user", "one more thing", "2026-07-01T10:01:00.000Z"),
    turn("assistant", long, "2026-07-01T10:02:00.000Z"),
  ]);
  const a = await readSearchArtifacts(path);
  expect(a.lastAssistant).toBe("z".repeat(200) + "...");
});

test("missing file yields empty artifacts", async () => {
  expect(await readSearchArtifacts(`${dir}/nope.jsonl`)).toEqual({});
});

// --- scoring / ranking --------------------------------------------------------

function mkEntry(over: Partial<SearchEntry>): SearchEntry {
  const base: SearchEntry = {
    sessionId: `s${n++}`,
    projectPath: "/tmp/x",
    fullPath: "/tmp/x.jsonl",
    baseRepoPath: "/tmp/x",
    repo: "",
    branch: "",
    summary: "",
    firstPrompt: "",
    name: "",
    modified: new Date(),
    messageCount: 1,
    searchText: "",
    isActive: false,
    isDeletedWorktree: false,
    ...over,
  };
  base.searchText = [base.summary, base.firstPrompt, base.name, base.branch, base.repo]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return base;
}

test("repo-name match is capped: content match in another session outranks it", () => {
  const repoOnly = mkEntry({ repo: "claude0" });
  const contentHit = mkEntry({ repo: "throxy", summary: "refactor claude0 bridge auth" });
  const ranked = filterAndRankEntries([repoOnly, contentHit], "claude0");
  expect(ranked[0]!.sessionId).toBe(contentHit.sessionId);
  expect(ranked).toHaveLength(2);
});

test("recency bonus discriminates across the retention horizon, zero past ~90 days", () => {
  const days = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);
  const at60 = scoreSearchEntry(mkEntry({ summary: "fix resurrect", modified: days(60) }), ["resurrect"]);
  const at95 = scoreSearchEntry(mkEntry({ summary: "fix resurrect", modified: days(95) }), ["resurrect"]);
  expect(at60).toBeGreaterThan(at95);
  expect(at95).toBe(60); // contains-tier only — no bonus left past the horizon
});

test("all words must match somewhere (token AND)", () => {
  const e = mkEntry({ summary: "resurrect fix", branch: "cwd-poisoning" });
  expect(scoreSearchEntry(e, ["resurrect", "cwd"])).toBeGreaterThan(0);
  expect(scoreSearchEntry(e, ["resurrect", "zeppelin"])).toBe(0);
});

// --- provenance -----------------------------------------------------------------

test("summary match carries field + snippet around the hit", () => {
  const e = mkEntry({ summary: "a very long summary about the pickSavedCwd home poisoning bug and more" });
  const [hit] = filterAndRankEntries([e], "poisoning");
  expect(hit!.matchField).toBe("summary");
  expect(hit!.matchSnippet).toContain("poisoning");
});

test("repo-only match carries field but no snippet (repo is already on the row)", () => {
  const e = mkEntry({ repo: "claude0" });
  const [hit] = filterAndRankEntries([e], "claude0");
  expect(hit!.matchField).toBe("repo");
  expect(hit!.matchSnippet).toBeUndefined();
});

/** A content index holding `prose` per session id. */
function fakeIndex(prose: Record<string, string>): ContentIndex & { snippetCalls: number } {
  const idx = {
    snippetCalls: 0,
    hits: (word: string) => new Set(Object.keys(prose).filter((id) => prose[id]!.toLowerCase().includes(word))),
    snippet: (id: string, word: string) => {
      idx.snippetCalls++;
      return prose[id]?.toLowerCase().includes(word) ? `…${prose[id]}…` : undefined;
    },
  };
  return idx;
}

test("a word only in the conversation matches through the index, at the content tier", () => {
  const e = mkEntry({ summary: "auth refactor" });
  const other = mkEntry({ summary: "xylophone tuning" });
  const index = fakeIndex({ [e.sessionId]: "and then we fixed the Xylophone bug" });
  const { results } = searchEntries([e, other], "xylophone", 50, index);
  // the summary hit (contains tier) outranks the conversation-only one
  expect(results.map((r) => r.sessionId)).toEqual([other.sessionId, e.sessionId]);
  expect(results[1]!.matchField).toBe("content");
});

test("every word must match, each in metadata or the conversation", () => {
  const e = mkEntry({ summary: "auth refactor" });
  const index = fakeIndex({ [e.sessionId]: "the xylophone bug" });
  expect(searchEntries([e], "auth xylophone", 50, index).total).toBe(1);
  expect(searchEntries([e], "auth zeppelin", 50, index).total).toBe(0);
});

test("content snippets are fetched only for the rows passed in, not while ranking", () => {
  const entries = Array.from({ length: 5 }, () => mkEntry({}));
  const index = fakeIndex(Object.fromEntries(entries.map((e) => [e.sessionId, "the Xylophone bug"])));
  const { results } = searchEntries(entries, "xylophone", 2, index);
  expect(index.snippetCalls).toBe(0);
  addContentSnippets(results, index);
  expect(index.snippetCalls).toBe(2);
  expect(results[0]!.matchSnippet).toContain("Xylophone");
});

// --- repo: scope + total ----------------------------------------------------

test("repo: token scopes to that repo; a bare word does not exclude other repos", () => {
  const inClaude0 = mkEntry({ repo: "claude0", summary: "fix resurrect" });
  const elsewhere = mkEntry({ repo: "throxy", summary: "resurrect the claude0 bridge" });
  const scoped = searchEntries([inClaude0, elsewhere], "repo:claude0 resurrect");
  expect(scoped.results.map((e) => e.sessionId)).toEqual([inClaude0.sessionId]);
  // Same words without the token: both repos stay in play.
  const unscoped = searchEntries([inClaude0, elsewhere], "claude0 resurrect");
  expect(unscoped.results).toHaveLength(2);
});

test("repo: matches by prefix and a bare scope browses that repo in given order", () => {
  // Entries arrive pre-sorted by recency from loadAllSessions; a word-less scope
  // must keep that order, only filtered.
  const newer = mkEntry({ repo: "claude0", modified: new Date("2026-07-01") });
  const other = mkEntry({ repo: "throxy" });
  const older = mkEntry({ repo: "claude0", modified: new Date("2026-01-01") });
  const { results, total } = searchEntries([newer, other, older], "repo:cl");
  expect(results.map((e) => e.sessionId)).toEqual([newer.sessionId, older.sessionId]);
  expect(total).toBe(2);
});

test("total reports all matches even when the page is capped", () => {
  const many = Array.from({ length: 7 }, () => mkEntry({ summary: "resurrect fix" }));
  const { results, total } = searchEntries(many, "resurrect", 3);
  expect(results).toHaveLength(3);
  expect(total).toBe(7);
});

test("an empty or repo-only query drops the previous query's match provenance", () => {
  const e = mkEntry({ repo: "r", summary: "fix the xylophone" });
  searchEntries([e], "xylophone");
  expect(e.matchSnippet).toBeDefined();
  for (const q of ["", "repo:r"]) {
    const [hit] = searchEntries([e], q).results;
    expect(hit!.matchField).toBeUndefined();
    expect(hit!.matchSnippet).toBeUndefined();
  }
});

test("empty query returns recency order untouched", () => {
  const older = mkEntry({ summary: "old", modified: new Date("2026-01-01") });
  const newer = mkEntry({ summary: "new", modified: new Date("2026-07-01") });
  const ranked = filterAndRankEntries([newer, older], "");
  expect(ranked.map((e) => e.sessionId)).toEqual([newer.sessionId, older.sessionId]);
});
