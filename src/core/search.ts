import { homedir } from "os";
import type { SessionIndexEntry, SessionIndex, Session } from "../types";
import { getBaseRepoPath, extractTicketId } from "./git";
import { repoNameFromPath } from "./sessions";
import { slugify, getSessionName, type NameCache } from "./names";
import { isConversationalRecord } from "./last-turn";

const home = homedir();
const projectsDir = `${home}/.claude/projects`;

/** Which field a query matched, for the "why did this row show up" line in both UIs. */
export type MatchField = "summary" | "firstPrompt" | "name" | "branch" | "repo" | "content";

export interface SearchEntry {
  sessionId: string;
  projectPath: string;
  fullPath: string; // path to .jsonl file
  baseRepoPath: string;
  repo: string;
  branch: string;
  summary: string;
  firstPrompt: string; // truncated for display (~200 chars)
  name: string; // AI name from cache
  modified: Date;
  messageCount: number;
  searchText: string; // pre-built lowercase concat of all searchable fields
  /** Original-case head+tail conversation text — snippet source for content matches. */
  corpus?: string;
  /** Last assistant message text (truncated) — display sub-line for archived rows. */
  lastAssistant?: string;
  isActive: boolean;
  activePaneId?: string;
  activeSessionName?: string;
  activeWindowIndex?: number;
  activeStatus?: Session["status"];
  isDeletedWorktree: boolean;
  /** Set by filterAndRankEntries on returned entries: where the query matched. */
  matchField?: MatchField;
  /** Set alongside matchField for content-ish fields: text around the first hit. */
  matchSnippet?: string;
}

/** Synthetic index entry with extra field for longer search content */
interface ExtendedIndexEntry extends SessionIndexEntry {
  /** Full head+tail conversation text (not truncated) — used for searchText/snippets */
  fullFirstPrompt?: string;
  /** Newest conversational-turn timestamp from the transcript tail (epoch ms) */
  lastTurnAtMs?: number;
  /** Last assistant message text from the transcript tail (truncated) */
  lastAssistant?: string;
}

/**
 * Load all sessions from all sessions-index.json files.
 * No time cutoff. Skips sidechains and AI-naming sessions.
 * Cross-references with active sessions to mark them.
 */
export async function loadAllSessions(
  nameCache: NameCache,
  activeSessions: Session[],
): Promise<SearchEntry[]> {
  // Build active session lookup
  const activeById = new Map<string, Session>();
  for (const s of activeSessions) {
    if (s.id) activeById.set(s.id, s);
  }

  // Glob all index files
  const glob = new Bun.Glob("*/sessions-index.json");
  const indexFiles: string[] = [];
  try {
    for await (const path of glob.scan({ cwd: projectsDir, absolute: true })) {
      indexFiles.push(path);
    }
  } catch {
    return [];
  }

  // Read all index files in parallel
  const indexResults = await Promise.all(
    indexFiles.map(async (indexFile) => {
      try {
        const raw = await Bun.file(indexFile).text();
        return JSON.parse(raw) as SessionIndex;
      } catch {
        return null;
      }
    }),
  );

  // Collect all entries from indexes, dedup by sessionId
  const seen = new Set<string>();
  const rawEntries: ExtendedIndexEntry[] = [];

  for (const index of indexResults) {
    if (!index?.entries) continue;
    for (const entry of index.entries) {
      if (seen.has(entry.sessionId)) continue;
      if (entry.isSidechain) continue;
      if (entry.firstPrompt?.startsWith("Name this coding session in 2-4 words")) continue;
      seen.add(entry.sessionId);
      rawEntries.push(entry);
    }
  }

  // Fallback: scan for JSONL files not covered by any index.
  // Some projects lack sessions-index.json — read minimal metadata from the JSONL header.
  try {
    const jsonlGlob = new Bun.Glob("*/*.jsonl");
    const looseJsonlPaths: string[] = [];
    for await (const path of jsonlGlob.scan({ cwd: projectsDir, absolute: true })) {
      const sessionId = path.split("/").pop()!.replace(/\.jsonl$/, "");
      // Skip subagent files (contain "/" in relative portion beyond project dir)
      if (path.includes("/subagents/")) continue;
      if (!seen.has(sessionId)) {
        looseJsonlPaths.push(path);
        seen.add(sessionId);
      }
    }

    // Parse loose JSONL headers in parallel (reads first 32KB each)
    const looseEntries = await Promise.all(
      looseJsonlPaths.map((path) => parseJsonlHeader(path)),
    );
    for (const entry of looseEntries) {
      if (entry) rawEntries.push(entry);
    }
  } catch {
    // Non-fatal: index-only search still works
  }

  // Supplement every entry with transcript artifacts: head+tail searchable corpus (the
  // index truncates firstPrompt at ~200 chars, and what a session BECAME often lives in
  // its tail), the true last-turn timestamp (index modified / file mtime move on
  // bookkeeping writes with no conversation behind them), and the last assistant
  // message for display. Two 32KB reads per file, parallel — cheap at ~1000 files.
  await Promise.all(
    rawEntries.map(async (entry: ExtendedIndexEntry) => {
      if (!entry.fullPath) return;
      try {
        const artifacts = await readSearchArtifacts(entry.fullPath);
        if (artifacts.corpus) entry.fullFirstPrompt = artifacts.corpus;
        if (artifacts.lastTurnAt !== undefined) entry.lastTurnAtMs = artifacts.lastTurnAt;
        if (artifacts.lastAssistant) entry.lastAssistant = artifacts.lastAssistant;
      } catch {}
    }),
  );

  // Resolve base repo paths and check worktree existence in parallel
  const entries = await Promise.all(
    rawEntries.map(async (entry: ExtendedIndexEntry) => {
      let baseRepoPath = entry.projectPath;
      let isDeletedWorktree = false;

      try {
        baseRepoPath = await getBaseRepoPath(entry.projectPath);
      } catch {}

      // Check if projectPath still exists (for worktree detection)
      if (entry.projectPath !== baseRepoPath) {
        try {
          const exists = await Bun.file(`${entry.projectPath}/.git`).exists();
          if (!exists) isDeletedWorktree = true;
        } catch {
          isDeletedWorktree = true;
        }
      }

      const repo = repoNameFromPath(baseRepoPath);
      const aiName = getSessionName(entry.sessionId, nameCache);
      const ticketId = extractTicketId(entry.gitBranch || "") || "";
      const activeSession = activeById.get(entry.sessionId);

      // Use fullFirstPrompt (untruncated) for searchText when available,
      // fall back to the index's truncated firstPrompt
      const searchPrompt = entry.fullFirstPrompt || entry.firstPrompt || "";
      const searchText = [
        entry.summary,
        searchPrompt,
        aiName,
        aiName ? slugify(aiName) : "", // abbreviated slug so "impl" still matches "Implementation Cleanup"
        entry.gitBranch,
        repo,
        ticketId,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return {
        sessionId: entry.sessionId,
        projectPath: entry.projectPath,
        fullPath: entry.fullPath,
        baseRepoPath,
        repo,
        branch: entry.gitBranch || "",
        summary: (entry.summary || "").replace(/\s+/g, " ").trim(),
        firstPrompt: (entry.firstPrompt || "").replace(/\s+/g, " ").trim(),
        name: aiName,
        // Real conversational recency when the transcript yields it; index/mtime otherwise.
        modified: entry.lastTurnAtMs !== undefined ? new Date(entry.lastTurnAtMs) : new Date(entry.modified),
        messageCount: entry.messageCount,
        searchText,
        corpus: entry.fullFirstPrompt,
        lastAssistant: entry.lastAssistant,
        isActive: !!activeSession,
        activePaneId: activeSession?.tmuxPane?.paneId,
        activeSessionName: activeSession?.tmuxPane?.sessionName,
        activeWindowIndex: activeSession?.tmuxPane?.windowIndex,
        activeStatus: activeSession?.status,
        isDeletedWorktree,
      } satisfies SearchEntry;
    }),
  );

  // Sort by modified desc (most recent first)
  entries.sort((a, b) => b.modified.getTime() - a.modified.getTime());

  return entries;
}

/**
 * Multi-word search: all words must appear in searchText.
 * Returns score > 0 if all words match, 0 otherwise.
 * Score = sum of per-word best match scores + recency bonus.
 */
export function scoreSearchEntry(entry: SearchEntry, words: string[]): number {
  return scoreEntryDetailed(entry, words).score;
}

/** Tier a single word against a single field's text. */
function wordFieldTier(field: string, word: string): number {
  if (!field) return 0;
  if (field === word) return 100;
  if (field.startsWith(word)) return 80;
  if (field.includes(word)) return 60;
  if (field.split(/[-_\s]+/).some((w) => w.startsWith(word))) return 40;
  return 0;
}

/**
 * Score plus provenance: which field won (for the "why did this match" line). Named
 * fields (summary, name, etc.) score higher than raw searchText (which includes
 * conversation content) so metadata matches rank above conversation-only matches —
 * EXCEPT repo, capped at 40: repo is a filter dimension (chips on the phone, visible
 * grouping in the TUI), so "claude0 resurrect" should rank by "resurrect", not by every
 * session that merely lives in claude0.
 */
function scoreEntryDetailed(
  entry: SearchEntry,
  words: string[],
): { score: number; field: MatchField | null; word: string | null } {
  // All words must be present in searchText
  for (const word of words) {
    if (!entry.searchText.includes(word)) return { score: 0, field: null, word: null };
  }

  const namedFields: Array<[MatchField, string]> = [
    ["summary", entry.summary?.toLowerCase() || ""],
    ["firstPrompt", entry.firstPrompt?.toLowerCase() || ""],
    ["name", entry.name?.toLowerCase() || ""],
    ["branch", entry.branch?.toLowerCase() || ""],
    ["repo", entry.repo?.toLowerCase() || ""],
  ];

  let totalScore = 0;
  let bestField: MatchField | null = null;
  let bestWord: string | null = null;
  let bestWordScore = -1;

  for (const word of words) {
    let wordScore = 0;
    let wordField: MatchField | null = null;

    for (const [fieldName, field] of namedFields) {
      let tier = wordFieldTier(field, word);
      if (fieldName === "repo") tier = Math.min(tier, 40);
      if (tier > wordScore) {
        wordScore = tier;
        wordField = fieldName;
      }
    }

    // Fall back to searchText (includes conversation content) — lower tier
    if (wordScore === 0 && entry.searchText.includes(word)) {
      wordScore = 20;
      wordField = "content";
    }

    totalScore += wordScore;
    if (wordScore > bestWordScore) {
      bestWordScore = wordScore;
      bestField = wordField;
      bestWord = word;
    }
  }

  // Recency bonus: up to 10 points for sessions active today, decaying to zero at the
  // retention horizon (~90 days) so it discriminates across the whole archive.
  const ageMs = Date.now() - entry.modified.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyBonus = Math.max(0, 10 - ageDays / 9);
  totalScore += recencyBonus;

  return { score: totalScore, field: bestField, word: bestWord };
}

/**
 * Snippet around the first occurrence of `word` in `source` (original case), or
 * undefined when the word isn't there. Ellipses mark truncation on either side.
 */
function buildSnippet(source: string | undefined, word: string): string | undefined {
  if (!source) return undefined;
  const idx = source.toLowerCase().indexOf(word);
  if (idx === -1) return undefined;
  const start = Math.max(0, idx - 40);
  const end = Math.min(source.length, idx + word.length + 40);
  return (start > 0 ? "…" : "") + source.slice(start, end).trim() + (end < source.length ? "…" : "");
}

export const CHUNK_SIZE = 32768; // head/tail read size per transcript; exported for tests
const TAIL_SLACK = 8192; // extra bytes read ahead of the tail window so trimming to a line boundary never empties it
const MAX_SEARCH_CONTENT = 6000; // corpus cap per chunk — generous enough that the last few real turns near a session's end (not just the single last message) stay searchable; see corpusFrom

/** One parsed conversational record: extracted display text + timestamp (ms, or null). */
interface ConversationRecord {
  type: "user" | "assistant";
  text: string;
  at: number | null;
}

/**
 * Parse a JSONL chunk into conversational records (user/assistant only — same
 * definition as last-turn.ts). Partial lines at either edge of a mid-file chunk fail
 * JSON.parse and drop, like every other JSONL reader here.
 */
function parseConversationRecords(chunk: string): ConversationRecord[] {
  const records: ConversationRecord[] = [];
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (!isConversationalRecord(parsed)) continue;
      let text = "";
      const content = parsed.message?.content;
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        const tb = content.find((b: { type: string }) => b.type === "text");
        if (tb?.text) text = tb.text;
      }
      if (parsed.type === "user" && (text.startsWith("[Request interrupted") || text.trimStart().startsWith("<"))) text = "";
      const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : NaN;
      records.push({
        type: parsed.type,
        text: text.replace(/\s+/g, " ").trim(),
        at: Number.isFinite(ts) ? ts : null,
      });
    } catch {
      continue;
    }
  }
  return records;
}

/**
 * Concatenate record texts up to MAX_SEARCH_CONTENT chars. `fromEnd` keeps the LAST
 * records instead of the first — the tail chunk exists to capture how the session
 * ended, so its cap must trim from the front, not eat the ending. The record that
 * crosses the cap is kept whole rather than sliced: a mid-slice keeps only one edge
 * of that record's text, silently losing a match that happened to live past the cut
 * (real case: a hit near the end of a long message got dropped because an earlier
 * slice took only its first ~200 of 789 chars). Bounded overflow past the nominal
 * cap — at most one record's length — is an acceptable tradeoff for never losing a
 * match inside an included record.
 */
function corpusFrom(records: ConversationRecord[], fromEnd = false): string {
  const ordered = fromEnd ? [...records].reverse() : records;
  const parts: string[] = [];
  let totalLen = 0;
  for (const r of ordered) {
    if (totalLen >= MAX_SEARCH_CONTENT) break;
    if (!r.text) continue;
    parts.push(r.text);
    totalLen += r.text.length;
  }
  if (fromEnd) parts.reverse();
  return parts.join(" ");
}

/**
 * Everything search wants from a transcript, in at most two reads (head + tail chunk;
 * one read when the file fits in a single chunk): searchable corpus covering how the
 * session started AND ended, the newest conversational-turn timestamp (the same
 * semantics as readLastTurnAt — file mtime lies after bookkeeping writes and bulk
 * resumes), and the last assistant message for display. Exported for tests.
 */
export async function readSearchArtifacts(filePath: string): Promise<{
  corpus?: string;
  lastTurnAt?: number;
  lastAssistant?: string;
}> {
  try {
    return await readSearchArtifactsInner(filePath);
  } catch {
    return {}; // missing/unreadable transcript — entry keeps its index metadata
  }
}

async function readSearchArtifactsInner(filePath: string): Promise<{
  corpus?: string;
  lastTurnAt?: number;
  lastAssistant?: string;
}> {
  const file = Bun.file(filePath);
  const stat = await file.stat();
  if (!stat) return {};

  const headChunk = await file.slice(0, Math.min(stat.size, CHUNK_SIZE)).text();
  const headRecords = parseConversationRecords(headChunk);

  let tailRecords = headRecords;
  let corpus = corpusFrom(headRecords);
  if (stat.size > CHUNK_SIZE) {
    // A byte-offset slice can start mid-line; without slack, that leading fragment
    // fails JSON.parse and silently drops — including whichever record it belonged
    // to, even if most of that record's bytes are actually inside the window. Read
    // extra bytes ahead of the window and trim forward to the first newline so every
    // parsed line is complete, the same guarantee the head chunk gets for free by
    // starting at byte 0.
    const tailReadSize = Math.min(stat.size, CHUNK_SIZE + TAIL_SLACK);
    const tailStart = stat.size - tailReadSize;
    const rawTail = await file.slice(tailStart, stat.size).text();
    const firstNewline = rawTail.indexOf("\n");
    const tailChunk = tailStart > 0 && firstNewline !== -1 ? rawTail.slice(firstNewline + 1) : rawTail;
    tailRecords = parseConversationRecords(tailChunk);
    const tailCorpus = corpusFrom(tailRecords, true);
    if (tailCorpus) corpus = corpus ? `${corpus} ${tailCorpus}` : tailCorpus;
  }

  let lastTurnAt: number | undefined;
  let lastAssistant: string | undefined;
  for (let i = tailRecords.length - 1; i >= 0; i--) {
    const r = tailRecords[i]!;
    if (lastTurnAt === undefined && r.at !== null) lastTurnAt = r.at;
    if (lastAssistant === undefined && r.type === "assistant" && r.text) {
      lastAssistant = r.text.length > 200 ? r.text.slice(0, 200) + "..." : r.text;
    }
    if (lastTurnAt !== undefined && lastAssistant !== undefined) break;
  }

  return { corpus: corpus || undefined, lastTurnAt, lastAssistant };
}

/**
 * Parse the header of a JSONL session file to extract minimal metadata.
 * Reads first 32KB. Returns a synthetic ExtendedIndexEntry or null.
 * Reuses extractSearchContent for the searchable corpus.
 */
async function parseJsonlHeader(filePath: string): Promise<ExtendedIndexEntry | null> {
  try {
    const file = Bun.file(filePath);
    const stat = await file.stat();
    if (!stat) return null;

    // Read first 32KB for metadata + first user prompt
    const chunk = await file.slice(0, Math.min(stat.size, 32768)).text();
    const lines = chunk.split("\n").filter(Boolean);

    let projectPath = "";
    let gitBranch = "";
    let firstPromptDisplay = "";
    let isSidechain = false;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);

        if (!projectPath && parsed.cwd) {
          projectPath = parsed.cwd;
          gitBranch = parsed.gitBranch || "";
          isSidechain = !!parsed.isSidechain;
        }

        if (!firstPromptDisplay && parsed.type === "user") {
          let text = "";
          const content = parsed.message?.content;
          if (typeof content === "string") text = content;
          else if (Array.isArray(content)) {
            const tb = content.find((b: { type: string }) => b.type === "text");
            if (tb?.text) text = tb.text;
          }
          if (text && !text.startsWith("[Request interrupted") && !text.trimStart().startsWith("<")) {
            const clean = text.replace(/\s+/g, " ").trim();
            firstPromptDisplay = clean.length > 200 ? clean.slice(0, 200) + "..." : clean;
          }
        }

        if (projectPath && firstPromptDisplay) break;
      } catch {
        continue;
      }
    }

    if (!projectPath) return null;
    if (isSidechain) return null;
    if (firstPromptDisplay?.startsWith("Name this coding session in 2-4 words")) return null;

    const sessionId = filePath.split("/").pop()!.replace(/\.jsonl$/, "");

    // Searchable corpus / last-turn artifacts come from the shared supplement pass in
    // loadAllSessions (readSearchArtifacts) — no separate content read here.
    return {
      sessionId,
      fullPath: filePath,
      fileMtime: stat.mtimeMs,
      firstPrompt: firstPromptDisplay,
      summary: "",
      messageCount: 0,
      created: new Date(stat.mtimeMs).toISOString(),
      modified: new Date(stat.mtimeMs).toISOString(),
      gitBranch,
      projectPath,
      isSidechain: false,
    };
  } catch {
    return null;
  }
}

/**
 * Filter and rank entries by multi-word query, reporting the total match count
 * alongside the truncated page so UIs can say "50 of 137" instead of lying.
 *
 * `repo:<name>` tokens scope the search to repos whose name equals or starts with
 * <name> (multiple tokens OR together); remaining words search as usual. A bare
 * `repo:` scope with no other words browses that repo by recency. Explicit syntax
 * on purpose: a bare word equal to a repo name must NOT silently exclude sessions
 * in other repos that mention it in content.
 *
 * If the query is empty, returns entries sorted by recency (already the default order).
 */
export function searchEntries(
  entries: SearchEntry[],
  query: string,
  limit = 50,
): { results: SearchEntry[]; total: number } {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const repoScopes: string[] = [];
  const words: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("repo:")) {
      const scope = token.slice(5);
      if (scope) repoScopes.push(scope); // a bare "repo:" mid-typing filters nothing
    } else {
      words.push(token);
    }
  }

  const pool = repoScopes.length
    ? entries.filter((e) => {
        const repo = e.repo.toLowerCase();
        return repoScopes.some((scope) => repo.startsWith(scope));
      })
    : entries;

  if (words.length === 0) {
    return { results: pool.slice(0, limit), total: pool.length };
  }

  const scored: Array<{ entry: SearchEntry; score: number }> = [];
  for (const entry of pool) {
    const { score, field, word } = scoreEntryDetailed(entry, words);
    if (score > 0) {
      // Provenance rides on the entry (in place — recomputed per query; only returned
      // entries are read, so stale fields on filtered-out entries are inert). Snippets
      // only for content-ish fields: name/branch/repo are already visible on the row.
      entry.matchField = field ?? undefined;
      entry.matchSnippet =
        field === "summary"
          ? buildSnippet(entry.summary, word!)
          : field === "firstPrompt"
            ? buildSnippet(entry.firstPrompt, word!)
            : field === "content"
              ? buildSnippet(entry.corpus, word!)
              : undefined;
      scored.push({ entry, score });
    }
  }

  // Sort by score desc, tie-break by modified desc
  scored.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 0.01) return scoreDiff;
    return b.entry.modified.getTime() - a.entry.modified.getTime();
  });

  return { results: scored.slice(0, limit).map((s) => s.entry), total: scored.length };
}

/** searchEntries without the total, for callers that only render the page. */
export function filterAndRankEntries(
  entries: SearchEntry[],
  query: string,
  limit = 50,
): SearchEntry[] {
  return searchEntries(entries, query, limit).results;
}
