/**
 * Full-depth conversation search (ADR 36, docs/search.md): an SQLite FTS5 index over
 * the prose of every transcript — user prompts and assistant text, nothing else.
 *
 * One writer, `claude0 daemon --index-once` (a fresh child every 30s), appends each
 * file's new complete lines by byte offset. Readers (the sidebar's search worker, the
 * bridge) open it read-only and lazily, and re-open when the file is replaced.
 */
import { Database } from "bun:sqlite";
import { existsSync, rmSync, statSync } from "fs";
import { homedir } from "os";
import { PATHS } from "./config";
import { recordProse } from "./transcript";

export const SEARCH_DB = `${PATHS.dir}/search.db`;
/** Bump on any schema or extraction change: the writer deletes the file and rebuilds. */
const SCHEMA_VERSION = "2";
/** Characters per FTS row: bounded rows keep snippet() cheap and hit→session lookups short. */
const ROW_CHARS = 64 * 1024;
const FILES_PER_TXN = 100;

// `prose_rows` maps rows back to their file and session: deleting FTS rows by an
// UNINDEXED column is a full scan, and snippets look rows up by session.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS files(
  path       TEXT PRIMARY KEY,
  ino        INTEGER NOT NULL,
  offset     INTEGER NOT NULL,
  size       INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS prose USING fts5(
  text, tokenize='unicode61 remove_diacritics 2', prefix='2 3'
);
CREATE TABLE IF NOT EXISTS prose_rows(
  fts_rowid  INTEGER PRIMARY KEY,
  path       TEXT NOT NULL,
  session_id TEXT NOT NULL,
  chars      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS prose_rows_path ON prose_rows(path);
CREATE INDEX IF NOT EXISTS prose_rows_session ON prose_rows(session_id);
`;

// --- writer -------------------------------------------------------------------------

function schemaVersion(db: Database): string | null {
  try {
    return db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? null;
  } catch {
    return null; // fresh file, no meta table yet
  }
}

function deleteIndex(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
}

function create(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA);
    db.run("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)", [SCHEMA_VERSION]);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

/** Opens the index for writing; another schema version, or a file that isn't a database, is rebuilt. */
function openWriter(dbPath: string): Database {
  let db: Database;
  try {
    db = new Database(dbPath, { create: true });
    const found = schemaVersion(db);
    if (found === null || found === SCHEMA_VERSION) {
      db.close();
      return create(dbPath);
    }
    db.close();
  } catch {
    // corrupt — fall through to a rebuild
  }
  deleteIndex(dbPath);
  return create(dbPath);
}

/**
 * A complete line's prose, or "". The substring test skips JSON.parse for the records
 * that can't carry prose (tool results dominate transcript bytes). Records stamped
 * with another session's id are a fork's byte-copied parent (ADR 25): the parent's
 * own file already holds that prose.
 */
export function lineProse(line: string, sessionId: string): string {
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"queued_command"')) {
    return "";
  }
  let record: { sessionId?: unknown; isSidechain?: unknown };
  try {
    record = JSON.parse(line);
  } catch {
    return "";
  }
  if (typeof record.sessionId === "string" && record.sessionId !== sessionId) return "";
  if (record.isSidechain) return "";
  return recordProse(record).replace(/\s+/g, " ").trim();
}

/**
 * Prose from `[from, to)` of a transcript, read as bytes: a line counts only once its
 * newline is seen, and `end` is the byte after the last one — where the next pass
 * starts. (A decoded-string reader can't give byte offsets: lengths drift on non-ASCII.)
 */
export async function readProse(
  path: string,
  from: number,
  to: number,
  sessionId: string,
): Promise<{ prose: string[]; end: number }> {
  const prose: string[] = [];
  const decoder = new TextDecoder();
  let carry: Uint8Array = new Uint8Array(0);
  let pos = from; // file offset of carry[0]
  for await (const chunk of Bun.file(path).slice(from, to).stream()) {
    let buf: Uint8Array = chunk;
    if (carry.length) {
      buf = new Uint8Array(carry.length + chunk.length);
      buf.set(carry);
      buf.set(chunk, carry.length);
    }
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf(0x0a, start)) !== -1) {
      if (nl > start) {
        const text = lineProse(decoder.decode(buf.subarray(start, nl)), sessionId);
        if (text) prose.push(text);
      }
      start = nl + 1;
    }
    pos += start;
    carry = buf.slice(start);
  }
  return { prose, end: pos };
}

/** Split text into ≤ROW_CHARS pieces at spaces, so no word straddles two rows. */
function pieces(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > ROW_CHARS) {
    let cut = rest.lastIndexOf(" ", ROW_CHARS);
    if (cut <= 0) cut = ROW_CHARS;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

interface Pending {
  path: string;
  sessionId: string;
  ino: number;
  size: number;
  from: number;
  reset: boolean;
}

export interface IndexStats {
  files: number;
  bytes: number;
  dropped: number;
  ms: number;
}

/**
 * One incremental pass: index every transcript's new complete lines. A file whose
 * inode changed or that shrank is re-indexed from 0; a vanished file's rows go.
 * Commits every FILES_PER_TXN files, so a killed pass resumes where it stopped.
 */
export async function indexOnce(opts: { dbPath?: string; projectsDir?: string } = {}): Promise<IndexStats> {
  const t0 = performance.now();
  const projectsDir = opts.projectsDir ?? `${homedir()}/.claude/projects`;
  const db = openWriter(opts.dbPath ?? SEARCH_DB);
  try {
    const known = new Map<string, { ino: number; offset: number; size: number }>();
    for (const r of db.query<{ path: string; ino: number; offset: number; size: number }, []>("SELECT * FROM files").all()) {
      known.set(r.path, r);
    }

    const dropRows = db.prepare("DELETE FROM prose WHERE rowid IN (SELECT fts_rowid FROM prose_rows WHERE path = ?)");
    const dropMap = db.prepare("DELETE FROM prose_rows WHERE path = ?");
    const dropFile = db.prepare("DELETE FROM files WHERE path = ?");
    const clear = (path: string) => {
      dropRows.run(path);
      dropMap.run(path);
    };

    const present = new Set<string>();
    const todo: Pending[] = [];
    // no projects dir yet (a fresh host) is an empty corpus, not a failed pass
    const paths = existsSync(projectsDir)
      ? await Array.fromAsync(new Bun.Glob("*/*.jsonl").scan({ cwd: projectsDir, absolute: true }))
      : [];
    for (const path of paths) {
      present.add(path);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      const sessionId = path.slice(path.lastIndexOf("/") + 1, -".jsonl".length);
      const k = known.get(path);
      if (!k) todo.push({ path, sessionId, ino: st.ino, size: st.size, from: 0, reset: false });
      else if (k.ino !== st.ino || st.size < k.offset) todo.push({ path, sessionId, ino: st.ino, size: st.size, from: 0, reset: true });
      else if (st.size !== k.size) todo.push({ path, sessionId, ino: st.ino, size: st.size, from: k.offset, reset: false });
    }

    let dropped = 0;
    db.transaction(() => {
      for (const path of known.keys()) {
        if (present.has(path)) continue;
        clear(path);
        dropFile.run(path);
        dropped++;
      }
    })();

    const lastRow = db.prepare<{ fts_rowid: number; chars: number }, [string]>(
      "SELECT fts_rowid, chars FROM prose_rows WHERE path = ? ORDER BY fts_rowid DESC LIMIT 1",
    );
    const appendText = db.prepare("UPDATE prose SET text = text || ' ' || ? WHERE rowid = ?");
    const growRow = db.prepare("UPDATE prose_rows SET chars = ? WHERE fts_rowid = ?");
    const insertText = db.prepare("INSERT INTO prose(text) VALUES (?)");
    const insertRow = db.prepare("INSERT INTO prose_rows(fts_rowid, path, session_id, chars) VALUES (?, ?, ?, ?)");
    const upsertFile = db.prepare(
      "INSERT INTO files(path, ino, offset, size) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET ino = excluded.ino, offset = excluded.offset, size = excluded.size",
    );
    const setMeta = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");

    const write = (p: Pending, prose: string[], end: number) => {
      if (p.reset) clear(p.path);
      const text = prose.join(" ");
      if (text) {
        const last = p.reset ? null : lastRow.get(p.path);
        if (last && last.chars + 1 + text.length <= ROW_CHARS) {
          appendText.run(text, last.fts_rowid);
          growRow.run(last.chars + 1 + text.length, last.fts_rowid);
        } else {
          for (const piece of pieces(text)) {
            const rowid = Number(insertText.run(piece).lastInsertRowid);
            insertRow.run(rowid, p.path, p.sessionId, piece.length);
          }
        }
      }
      upsertFile.run(p.path, p.ino, end, p.size);
    };

    // The first build reports progress by bytes for search's "indexing N%" header.
    const building = db.query("SELECT 1 FROM meta WHERE key = 'built'").get() === null;
    const totalBytes = todo.reduce((n, p) => n + p.size - p.from, 0);
    let bytes = 0;
    for (let i = 0; i < todo.length; i += FILES_PER_TXN) {
      const batch: { p: Pending; prose: string[]; end: number }[] = [];
      for (const p of todo.slice(i, i + FILES_PER_TXN)) {
        try {
          const { prose, end } = await readProse(p.path, p.from, p.size, p.sessionId);
          batch.push({ p, prose, end });
          bytes += p.size - p.from;
        } catch {
          // vanished or unreadable mid-pass — the next pass sees it again
        }
      }
      db.transaction(() => {
        for (const b of batch) write(b.p, b.prose, b.end);
        if (building) setMeta.run("progress", String(Math.floor((100 * bytes) / Math.max(1, totalBytes))));
      })();
    }
    if (building) {
      db.transaction(() => {
        setMeta.run("built", String(Date.now()));
        db.run("DELETE FROM meta WHERE key = 'progress'");
      })();
    }
    setMeta.run("last_pass", String(Date.now()));
    return { files: todo.length, bytes, dropped, ms: Math.round(performance.now() - t0) };
  } finally {
    db.close();
  }
}

// --- readers ------------------------------------------------------------------------

/** A word's letter/digit runs, and whether its last run is too short to prefix-match. */
function wordTokens(word: string): { tokens: string[]; exact: boolean } | null {
  const tokens = word.match(/[\p{L}\p{N}]+/gu);
  if (!tokens) return null;
  const exact = tokens[tokens.length - 1]!.length < 2;
  // a lone 1-character run ("c++" → "c") would match nearly every session
  if (exact && tokens.length === 1) return null;
  return { tokens, exact };
}

/**
 * The FTS query for one search word, or null when the index can't answer it: unicode61
 * splits on punctuation, so the word becomes a phrase of its letter/digit runs with a
 * prefix on the last ("eng-2687" → `"eng 2687"*`). A 1-character last run would
 * prefix-match too much, so that phrase is exact ("gpt-4" → `"gpt 4"`).
 */
export function ftsQuery(word: string): string | null {
  const w = wordTokens(word);
  if (!w) return null;
  return `"${w.tokens.join(" ")}"${w.exact ? "" : "*"}`;
}

/** What search needs from the index; a fake stands in for it in tests. */
export interface ContentIndex {
  /** Sessions whose prose holds the word; undefined when the index can't answer. */
  hits(word: string): Set<string> | undefined;
  /** Text around the word's first hit in that session's prose. */
  snippet(sessionId: string, word: string): string | undefined;
}

let reader: { db: Database; ino: number } | null = null;

/**
 * The read-only handle, opened lazily and re-opened when the writer replaced the file
 * (the open handle pins the old inode, so a recreated file always gets a new one).
 */
function readerDb(dbPath = SEARCH_DB): Database | null {
  let ino: number;
  try {
    ino = statSync(dbPath).ino;
  } catch {
    reader?.db.close();
    reader = null;
    return null; // no index yet — every query retries
  }
  if (reader?.ino === ino) return reader.db;
  reader?.db.close();
  reader = null;
  try {
    reader = { db: new Database(dbPath, { readonly: true }), ino };
    return reader.db;
  } catch {
    return null;
  }
}

export const searchIndex: ContentIndex = {
  hits(word) {
    const q = ftsQuery(word);
    const db = q ? readerDb() : null;
    if (!q || !db) return undefined;
    try {
      const rows = db
        .query<{ session_id: string }, [string]>(
          "SELECT DISTINCT r.session_id FROM prose JOIN prose_rows r ON r.fts_rowid = prose.rowid WHERE prose MATCH ?",
        )
        .all(q);
      return new Set(rows.map((r) => r.session_id));
    } catch {
      return undefined; // schema not created yet, or a writer mid-rebuild
    }
  },
  snippet(sessionId, word) {
    const q = ftsQuery(word);
    const db = q ? readerDb() : null;
    if (!q || !db) return undefined;
    try {
      // FTS5's snippet() re-scans the whole row (~1.7ms per 64KB row for a 2-letter
      // prefix); cutting it here is ~20x cheaper for a page of rows.
      const row = db
        .query<{ text: string }, [string, string]>(
          "SELECT text FROM prose WHERE prose MATCH ? AND rowid IN (SELECT fts_rowid FROM prose_rows WHERE session_id = ?) LIMIT 1",
        )
        .get(q, sessionId);
      return row ? cutSnippet(row.text, word) : undefined;
    } catch {
      return undefined;
    }
  },
};

/**
 * ±40 characters around the word's first token-prefix occurrence. undefined when the
 * pattern misses a row FTS matched — unicode61 folds diacritics, this doesn't.
 */
export function cutSnippet(text: string, word: string): string | undefined {
  const w = wordTokens(word);
  if (!w) return undefined;
  const stop = w.exact ? "(?![\\p{L}\\p{N}])" : "";
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${w.tokens.join("[^\\p{L}\\p{N}]+")}${stop}`, "iu").exec(text);
  if (!m) return undefined;
  const start = Math.max(0, m.index - 40);
  const end = Math.min(text.length, m.index + m[0].length + 40);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

/** Percent done while the first build runs (0 before the indexer's first pass); null once built or unreadable. */
export function indexProgress(): number | null {
  const db = readerDb();
  if (!db) return 0;
  try {
    const built = db.query("SELECT 1 FROM meta WHERE key = 'built'").get();
    if (built) return null;
    const p = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'progress'").get();
    return p ? Number(p.value) : 0;
  } catch {
    return null; // a writer that can't build (no FTS5) must not leave "indexing 0%" up forever
  }
}
