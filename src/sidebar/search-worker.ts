/**
 * `claude0 search-worker` — the sidebar's search engine, in its own process
 * (docs/inbox.md, "Search"). Loading every session's entry plateaus near
 * 210MB RSS (allocator retention, not live heap) while the daemon idles
 * near 73MB, so the renderer spawns this on the first `/`, talks JSON lines
 * over stdio, and the worker exits after IDLE_MS without a query — its memory
 * leaves with it. stdin closing (the daemon died) also ends it.
 */
import { addContentSnippets, loadAllSessions, searchEntries, type MatchField, type SearchEntry } from "../core/search";
import { indexProgress } from "../core/search-index";
import { loadNameCache } from "../core/names";

export interface SearchRequest {
  seq: number;
  q: string;
  limit: number;
}

/** What a result row and an open need — the entry minus its search fields. */
export interface SearchHit {
  sessionId: string;
  name: string;
  firstPrompt: string;
  repo: string;
  branch: string;
  projectPath: string;
  /** epoch ms of the last conversational turn */
  modified: number;
  matchField?: MatchField;
  matchSnippet?: string;
}

export interface SearchResponse {
  seq: number;
  total: number;
  hits: SearchHit[];
  /** Percent done while the conversation index's first build runs. */
  indexing?: number;
}

/** Entries older than this are reloaded — after answering, never before. */
const STALE_MS = 15_000;
const IDLE_MS = 10 * 60_000;

export function runQuery(entries: SearchEntry[], q: string, limit: number): { total: number; hits: SearchHit[] } {
  const { results, total } = searchEntries(entries, q, limit);
  addContentSnippets(results);
  return {
    total,
    hits: results.map((e) => ({
      sessionId: e.sessionId,
      name: e.name,
      firstPrompt: e.firstPrompt,
      repo: e.repo,
      branch: e.branch,
      projectPath: e.projectPath,
      modified: e.modified.getTime(),
      ...(e.matchField ? { matchField: e.matchField } : {}),
      ...(e.matchSnippet ? { matchSnippet: e.matchSnippet } : {}),
    })),
  };
}

export async function searchWorker(): Promise<void> {
  let entries: SearchEntry[] | null = null;
  let loadedAt = 0;
  let reloading: Promise<void> | null = null;

  async function load(): Promise<void> {
    const t0 = performance.now();
    // live state is the renderer's to overlay — it holds the inbox
    const next = await loadAllSessions(await loadNameCache(), []);
    entries = next;
    loadedAt = Date.now();
    console.error(`[search-worker] loaded ${next.length} sessions in ${Math.round(performance.now() - t0)}ms`);
  }

  let idle: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      console.error("[search-worker] idle — exiting");
      process.exit(0);
    }, IDLE_MS);
  };
  armIdle();

  async function answer(req: SearchRequest): Promise<void> {
    armIdle();
    try {
      if (!entries) await load();
      else if (!reloading && Date.now() - loadedAt > STALE_MS) {
        reloading = load()
          .catch(() => {})
          .finally(() => {
            reloading = null;
          });
      }
      const t0 = performance.now();
      const { total, hits } = runQuery(entries ?? [], req.q, req.limit);
      const indexing = indexProgress();
      const res: SearchResponse = { seq: req.seq, total, hits, ...(indexing !== null ? { indexing } : {}) };
      process.stdout.write(`${JSON.stringify(res)}\n`);
      console.error(`[search-worker] q=${JSON.stringify(req.q)} hits=${total} ms=${(performance.now() - t0).toFixed(1)}`);
    } catch (e) {
      console.error("[search-worker] query failed:", e);
      process.stdout.write(`${JSON.stringify({ seq: req.seq, total: 0, hits: [] } satisfies SearchResponse)}\n`);
    }
  }

  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    // Only the newest request in a burst is answered: keystrokes typed while a
    // load or query ran arrive together, and the renderer drops older seqs anyway.
    let latest: SearchRequest | null = null;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      try {
        if (line) latest = JSON.parse(line);
      } catch {}
    }
    if (latest) await answer(latest);
  }
  process.exit(0);
}
