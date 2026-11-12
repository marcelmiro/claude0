/**
 * Durable inbox state — the authored layer of ADR 0013 (dispositions, done,
 * provenance links) plus an event log, in SQLite via bun:sqlite (no new deps).
 *
 * Why a database where the rest of Claude0 uses files: the inbox is the one
 * domain with genuinely concurrent read-modify-write over SHARED rows — N
 * sidebar panes, the activity refresher, CLI verbs and eventually the bridge
 * all mutate the same disposition. The per-file-per-key pattern (verdicts/,
 * panes/) solves single-fact races but not transactions; the prototype's
 * shared-JSON state needed an in-process serialization chain and still had a
 * lost-write window between processes. WAL + busy_timeout is the textbook
 * answer for local multi-process state.
 *
 * The event log is load-bearing, not telemetry: transition-gated "Needs you"
 * (only observed events admit a row) and Claude0 stats ("cleared today",
 * inbox-zero streaks) both need history, which a snapshot file overwrites.
 *
 * What stays OUT: current activity (status, ages, PR cache) is derived state
 * owned by whoever computes it — it lives in the `snapshot` table as opaque
 * JSON per session, replaced each refresh (fact-holding rows survive the
 * replace — see saveSnapshot). This store never interprets it; schema churn
 * there must not mean migrations here.
 */
import { Database } from "bun:sqlite";
import { PATHS } from "./config";

export type DispositionKind = "snoozed" | "blocked";

export interface DispositionRow {
  sessionId: string;
  kind: DispositionKind;
  /** Wake timestamp (ms) — snoozed only. */
  until: number | null;
  /** Blocked: the free-text reason. Snoozed: the wake prompt the session resumes with, or null
   * for a plain snooze (docs/inbox.md, Daemon and wakes). Future: may hold a session ref (ADR 0013). */
  note: string | null;
  createdAt: number;
  /** A woken snooze already auto-reopened its pane — never spawn twice. */
  autoResumed: boolean;
  /** The portkey device that set a snooze (wake push routes to it) — null = Mac-set. */
  deviceId: string | null;
}

export interface InboxEvent {
  id: number;
  sessionId: string;
  at: number;
  type: string;
  meta: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dispositions(
  session_id   TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK(kind IN ('snoozed','blocked')),
  until        INTEGER,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  auto_resumed INTEGER NOT NULL DEFAULT 0,
  device_id    TEXT
);
CREATE TABLE IF NOT EXISTS archived(
  session_id  TEXT PRIMARY KEY,
  archived_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  at         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  meta       TEXT
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, at);
CREATE TABLE IF NOT EXISTS links(
  child_id   TEXT PRIMARY KEY,
  parent_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK(kind IN ('fork','handoff')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot(
  session_id TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export class InboxStore {
  readonly db: Database;

  constructor(path: string = `${PATHS.dir}/inbox.db`) {
    this.db = new Database(path, { create: true });
    // WAL: concurrent readers + one writer; busy_timeout instead of SQLITE_BUSY
    // throws when the refresher's write overlaps a verb.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    // Column-existence-guarded ALTER (not a blanket try/catch, which would also
    // swallow disk-full/corruption errors): DBs created before device_id existed
    // get the column added; CREATE IF NOT EXISTS never rewrites an existing table.
    const cols = this.db.query("PRAGMA table_info(dispositions)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "device_id")) {
      this.db.exec("ALTER TABLE dispositions ADD COLUMN device_id TEXT");
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * PRAGMA data_version: bumps when ANOTHER connection commits — a free
   * change-poll for long-lived readers (own writes refresh explicitly).
   */
  dataVersion(): number {
    return (this.db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
  }

  private event(sessionId: string, at: number, type: string, meta?: unknown): void {
    this.db
      .query("INSERT INTO events(session_id, at, type, meta) VALUES (?, ?, ?, ?)")
      .run(sessionId, at, type, meta === undefined ? null : JSON.stringify(meta));
  }

  // ── verbs (each refuses invalid targets, mirrors ADR semantics) ──────────

  /** Park until `until`. Re-snoozing re-arms the wake auto-reopen and replaces the wake prompt. */
  snooze(
    sessionId: string,
    until: number,
    now: number,
    deviceId: string | null = null,
    wakePrompt: string | null = null,
  ): boolean {
    return this.db.transaction(() => {
      if (this.isArchived(sessionId)) return false;
      this.db
        .query(
          `INSERT INTO dispositions(session_id, kind, until, note, created_at, auto_resumed, device_id)
           VALUES (?, 'snoozed', ?, ?, ?, 0, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             kind='snoozed', until=excluded.until, note=excluded.note,
             created_at=excluded.created_at, auto_resumed=0, device_id=excluded.device_id`,
        )
        .run(sessionId, until, wakePrompt, now, deviceId);
      this.event(sessionId, now, "snooze", wakePrompt ? { until, wakePrompt } : { until });
      return true;
    })();
  }

  block(sessionId: string, note: string, now: number): boolean {
    return this.db.transaction(() => {
      if (this.isArchived(sessionId)) return false;
      this.db
        .query(
          `INSERT INTO dispositions(session_id, kind, until, note, created_at, auto_resumed)
           VALUES (?, 'blocked', NULL, ?, ?, 0)
           ON CONFLICT(session_id) DO UPDATE SET
             kind='blocked', until=NULL, note=excluded.note,
             created_at=excluded.created_at, auto_resumed=0, device_id=NULL`,
        )
        .run(sessionId, note, now);
      this.event(sessionId, now, "block", { note });
      return true;
    })();
  }

  /**
   * Drop the disposition (reply observed, or explicit unpark). Returns the
   * kind it had, so callers can mark "woken from snooze" — or null if none.
   */
  clearDisposition(sessionId: string, now: number, reason: string): DispositionKind | null {
    return this.db.transaction(() => {
      const prev = this.db
        .query("SELECT kind FROM dispositions WHERE session_id = ?")
        .get(sessionId) as { kind: DispositionKind } | null;
      if (!prev) return null;
      this.db.query("DELETE FROM dispositions WHERE session_id = ?").run(sessionId);
      this.event(sessionId, now, "unpark", { reason, was: prev.kind });
      return prev.kind;
    })();
  }

  /** Done. Clears any disposition; idempotent-refuses a second archive. */
  archive(sessionId: string, now: number): boolean {
    return this.db.transaction(() => {
      if (this.isArchived(sessionId)) return false;
      this.db.query("DELETE FROM dispositions WHERE session_id = ?").run(sessionId);
      this.db.query("INSERT INTO archived(session_id, archived_at) VALUES (?, ?)").run(sessionId, now);
      this.event(sessionId, now, "archive");
      return true;
    })();
  }

  /** Undo done — back to Needs you (pane resurrection is NOT this store's job). */
  unarchive(sessionId: string, now: number): boolean {
    return this.db.transaction(() => {
      const hit = this.db.query("DELETE FROM archived WHERE session_id = ? RETURNING session_id").get(sessionId);
      if (!hit) return false;
      this.event(sessionId, now, "unarchive");
      return true;
    })();
  }

  /**
   * Claim the wake auto-reopen for this snooze stretch — at most one caller
   * wins (the WHERE is the lock), so overlapping wakers can't double-spawn a
   * pane. Returns false when already claimed. A re-snooze re-arms the claim.
   */
  markAutoResumed(sessionId: string, now: number): boolean {
    const hit = this.db
      .query(
        "UPDATE dispositions SET auto_resumed = 1 WHERE session_id = ? AND kind = 'snoozed' AND auto_resumed = 0",
      )
      .run(sessionId).changes;
    if (!hit) return false;
    this.event(sessionId, now, "auto_resume");
    return true;
  }

  /**
   * An OBSERVED status transition (running→ready/waiting) — the event that
   * records when a session hands control back to the user.
   */
  transition(sessionId: string, now: number, from: string | null, to: string): void {
    this.event(sessionId, now, "transition", { from, to });
  }

  // ── reads ────────────────────────────────────────────────────────────────

  isArchived(sessionId: string): boolean {
    return !!this.db.query("SELECT 1 FROM archived WHERE session_id = ?").get(sessionId);
  }

  dispositions(): Map<string, DispositionRow> {
    const rows = this.db
      .query("SELECT session_id, kind, until, note, created_at, auto_resumed, device_id FROM dispositions")
      .all() as Array<{
      session_id: string;
      kind: DispositionKind;
      until: number | null;
      note: string | null;
      created_at: number;
      auto_resumed: number;
      device_id: string | null;
    }>;
    return new Map(
      rows.map((r) => [
        r.session_id,
        {
          sessionId: r.session_id,
          kind: r.kind,
          until: r.until,
          note: r.note,
          createdAt: r.created_at,
          autoResumed: !!r.auto_resumed,
          deviceId: r.device_id,
        },
      ]),
    );
  }

  /** sessionId → archivedAt. Full history; callers window it (24h = RECENT). */
  archivedAt(): Map<string, number> {
    const rows = this.db.query("SELECT session_id, archived_at FROM archived").all() as Array<{
      session_id: string;
      archived_at: number;
    }>;
    return new Map(rows.map((r) => [r.session_id, r.archived_at]));
  }

  /**
   * The newest event for a session, meta parsed. Drives the refresher's
   * preserve rule: a row restored by explicit user action (unarchive, manual
   * unpark) has neither disposition nor pane, and would otherwise vanish on
   * the next snapshot replace.
   */
  latestEvent(sessionId: string): { type: string; meta: unknown } | null {
    const r = this.db
      .query("SELECT type, meta FROM events WHERE session_id = ? ORDER BY at DESC, id DESC LIMIT 1")
      .get(sessionId) as { type: string; meta: string | null } | null;
    if (!r) return null;
    let meta: unknown = null;
    try {
      meta = r.meta === null ? null : JSON.parse(r.meta);
    } catch {}
    return { type: r.type, meta };
  }

  events(sessionId?: string, limit = 100): InboxEvent[] {
    const rows = (
      sessionId
        ? this.db.query("SELECT * FROM events WHERE session_id = ? ORDER BY at DESC, id DESC LIMIT ?").all(sessionId, limit)
        : this.db.query("SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?").all(limit)
    ) as Array<{ id: number; session_id: string; at: number; type: string; meta: string | null }>;
    return rows.map((r) => ({ id: r.id, sessionId: r.session_id, at: r.at, type: r.type, meta: r.meta }));
  }

  /**
   * Reply observed: the parked/archived overlay no longer describes reality.
   * Drops any disposition and archive in one transaction — the single
   * implementation of the "reply observed" rule for discovery's gate.
   * Returns the disposition kind cleared (drives the ↺ marker), null if none.
   */
  replyObserved(sessionId: string, now: number): DispositionKind | null {
    return this.db.transaction(() => {
      const was = this.clearDisposition(sessionId, now, "reply");
      this.unarchive(sessionId, now);
      return was;
    })();
  }

  // ── provenance (forward-compat, ADR 0013 follow-up) ──────────────────────

  link(childId: string, parentId: string, kind: "fork" | "handoff", now: number): void {
    this.db
      .query(
        `INSERT INTO links(child_id, parent_id, kind, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(child_id) DO NOTHING`,
      )
      .run(childId, parentId, kind, now);
  }

  parentOf(childId: string): { parentId: string; kind: "fork" | "handoff" } | null {
    const r = this.db.query("SELECT parent_id, kind FROM links WHERE child_id = ?").get(childId) as
      | { parent_id: string; kind: "fork" | "handoff" }
      | null;
    return r ? { parentId: r.parent_id, kind: r.kind } : null;
  }

  // ── snapshot (opaque derived-activity cache, replaced per tick) ──────────

  saveSnapshot(rows: Array<{ sessionId: string; data: string }>, now: number): void {
    this.db.transaction(() => {
      // Not a blind DELETE-all: a bridge verb can write a fact + seed a snapshot
      // row DURING a discovery tick — after the tick loaded its preserve inputs,
      // before this save — and a wholesale wipe would strand that fact invisibly
      // (composeSessions has nothing to overlay it onto). Keeping fact-holding
      // rows here makes the replace atomic with the fact tables, closing the
      // read-compute-write race in the one place every writer goes through.
      // Archived is recency-bounded to the 24h RECENT window so History-aged ids
      // don't pin snapshot rows forever.
      this.db
        .query(
          `DELETE FROM snapshot
           WHERE session_id NOT IN (SELECT session_id FROM dispositions)
             AND session_id NOT IN (SELECT session_id FROM archived WHERE archived_at > ?)`,
        )
        .run(now - 86_400_000);
      const ins = this.db.query(
        "INSERT OR REPLACE INTO snapshot(session_id, data, updated_at) VALUES (?, ?, ?)",
      );
      for (const r of rows) ins.run(r.sessionId, r.data, now);
    })();
  }

  /**
   * Insert a snapshot row for a session discovery has never seen — a verb
   * (snooze/block/archive) on such an id writes a fact composeSessions has no
   * row to overlay onto, so the session would vanish from the inbox instead of
   * filing under Parked/Done. INSERT OR IGNORE keeps discovery the snapshot's
   * owner: an existing row is never touched, and saveSnapshot's fact-keeping
   * delete carries the seeded row (its disposition/archived fact) across
   * replaces atomically — even one whose tick was already mid-flight.
   * updated_at is 0, not now: it feeds the inboxStale probe, which measures the
   * DAEMON's last tick — a bridge-side seed must not mask a dead daemon.
   */
  seedSnapshotRow(sessionId: string, data: string): void {
    this.db
      .query("INSERT OR IGNORE INTO snapshot(session_id, data, updated_at) VALUES (?, ?, 0)")
      .run(sessionId, data);
  }

  loadSnapshot(): Array<{ sessionId: string; data: string; updatedAt: number }> {
    const rows = this.db.query("SELECT session_id, data, updated_at FROM snapshot").all() as Array<{
      session_id: string;
      data: string;
      updated_at: number;
    }>;
    return rows.map((r) => ({ sessionId: r.session_id, data: r.data, updatedAt: r.updated_at }));
  }

  // ── kv (tiny shared prefs, e.g. parked-expanded) ─────────────────────────

  getKV(key: string): string | null {
    const r = this.db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | null;
    return r?.value ?? null;
  }

  setKV(key: string, value: string): void {
    this.db
      .query("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  /** Wipe everything — seed/test helper, never called in normal operation. */
  reset(): void {
    this.db.exec("DELETE FROM dispositions; DELETE FROM archived; DELETE FROM events; DELETE FROM snapshot; DELETE FROM kv;");
  }
}
