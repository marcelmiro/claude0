/**
 * Claude native session-status reader (headless).
 *
 * Claude Code maintains its OWN authoritative status at
 * `~/.claude/sessions/<pid>.json` (`status` = `busy|shell|idle|waiting`). It flips to
 * `idle` ~1.5s after a turn ends — including the revert/interrupt cases that emit
 * NO hook, where the event model's `UserPromptSubmit → running` edge latches and
 * strands a session at "running" forever. Reading this file de-latches that and,
 * more broadly, aligns Claude0's displayed status to Claude's own. It's the PRIMARY
 * source for live sessions, with the event model then the scraper as fallbacks.
 *
 * Status mapping (verified empirically): busy→running, idle→ready, waiting→waiting,
 * shell→ready (the turn is over but a background shell still runs; claude0 shows that
 * as ⏳ beside a ready status, never as a running turn — ADR 26).
 *
 * NOTE on the home root: Claude writes to the REAL home (`homedir()`), not Claude0's
 * `CLAUDE0_HOME` test seam (config.ts:4-6). This reader intentionally diverges from
 * that seam and takes a `dir` arg for test isolation, because the target dir is
 * Claude's, not Claude0's. A future CLAUDE0_HOME-based integration test will NOT reach
 * `nativeStatus()` — that's expected, point it at `dir` instead.
 *
 * Headless: no blessed/ui imports (enforced by boundary.test.ts). All IO in
 * try/catch returning empty defaults — never crash the TUI.
 */

import { homedir } from "os";
import { Glob } from "bun";
import type { SessionStatus } from "./status";

const DEFAULT_DIR = `${homedir()}/.claude/sessions`;

// Claude's `status` → Claude0's SessionStatus. Anything else → skip (null).
function mapStatus(status: unknown): SessionStatus | null {
  switch (status) {
    case "busy":
      return "running";
    case "idle":
    case "shell":
      return "ready";
    case "waiting":
      return "waiting";
    default:
      return null;
  }
}

// process.kill(pid, 0) probes liveness without signalling. Single-user macOS:
// only ESRCH (dead) can throw — EPERM (alive, foreign-owned) cannot arise — so
// a throw cleanly means "dead".
function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every readable `<pid>.json` in `dir`, parsed. Malformed files are skipped. */
async function scanRecords(dir: string): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  try {
    for await (const file of new Glob("*.json").scan({ cwd: dir, absolute: true })) {
      try {
        records.push(JSON.parse(await Bun.file(file).text()));
      } catch {
        // Malformed/unreadable file — skip without poisoning other entries.
      }
    }
  } catch {
    // Missing dir or scan failure — return whatever we have (empty).
  }
  return records;
}

/**
 * Scan `dir` for `<pid>.json` files and build sessionId → status. Keeps only
 * `kind === "interactive"` entries with a live pid and a known `status`. On
 * duplicate sessionId, newest `updatedAt` wins. Pure on `dir` for tests.
 */
export async function loadNativeStatuses(
  dir: string = DEFAULT_DIR,
): Promise<Map<string, SessionStatus>> {
  const result = new Map<string, SessionStatus>();
  const updatedAtBySession = new Map<string, number>();
  for (const parsed of await scanRecords(dir)) {
    if (parsed?.kind !== "interactive") continue;
    const sessionId = parsed?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) continue;
    const status = mapStatus(parsed?.status);
    if (!status) continue;
    if (!pidAlive(parsed?.pid)) continue;

    const updatedAt = typeof parsed?.updatedAt === "number" ? parsed.updatedAt : 0;
    const prev = updatedAtBySession.get(sessionId);
    if (prev !== undefined && prev >= updatedAt) continue;
    updatedAtBySession.set(sessionId, updatedAt);
    result.set(sessionId, status);
  }
  return result;
}

/**
 * Parent sessionId → the sessionId of the parked job running in its pane.
 *
 * A parked job is a SEPARATE Claude session (`kind:"bg"`, own pid, own
 * transcript, own `tasks/` dir) that renders into the parent pane's viewport.
 * The parent session goes idle for its whole duration, so anything Claude0 asks
 * about the pane's session — status, pending scripts, the transcript — answers
 * for the wrong half of what's on screen. The two files join exactly: the
 * parent carries `parkedJobId`, the job carries the matching `jobId` alongside
 * its full `sessionId` (`parkedJobId` is only the id's 8-char stem, so the
 * join must go through the job's own file rather than prefix-matching).
 *
 * Only live-pid jobs are returned: once the job process exits, its transcript's
 * pending entries are orphans that no notification will ever retire.
 */
export async function parkedJobSessions(
  dir: string = DEFAULT_DIR,
): Promise<Map<string, string>> {
  const records = await scanRecords(dir);
  const jobSessions = new Map<string, string>();
  for (const r of records) {
    if (r?.kind !== "bg" || !pidAlive(r?.pid)) continue;
    if (typeof r?.jobId === "string" && typeof r?.sessionId === "string" && r.sessionId) {
      jobSessions.set(r.jobId, r.sessionId);
    }
  }

  const result = new Map<string, string>();
  for (const r of records) {
    if (r?.kind !== "interactive" || typeof r?.sessionId !== "string") continue;
    const job = typeof r?.parkedJobId === "string" ? jobSessions.get(r.parkedJobId) : undefined;
    if (job) result.set(r.sessionId, job);
  }
  return result;
}

/**
 * The session id Claude currently owns for a given live PID, from its
 * `<pid>.json` native file — or null when absent/malformed/non-interactive.
 *
 * This is the ONLY correct id for a `--fork-session` pane. A fork's SessionStart
 * hook fires with the PARENT (resume-source) id — the fork's own id isn't minted
 * yet and no second SessionStart follows — so Claude0's hook-owned pane map is
 * permanently wrong for forks, aliasing the fork onto its parent's status/name.
 * The native file, keyed by the fork's own pid, carries the real id. No
 * pid-liveness check: the caller passes the pid of a process it just saw in `ps`.
 * Pure on `dir` for tests (points at Claude's home, not Claude0's — see the note on
 * `loadNativeStatuses`).
 */
export async function nativeSessionIdByPid(
  pid: number,
  dir: string = DEFAULT_DIR,
): Promise<string | null> {
  try {
    const parsed = JSON.parse(await Bun.file(`${dir}/${pid}.json`).text());
    if (parsed?.kind !== "interactive") return null;
    const sessionId = parsed?.sessionId;
    return typeof sessionId === "string" && sessionId ? sessionId : null;
  } catch {
    return null;
  }
}

/**
 * Fold the three status sources into a verdict + its provenance. Order is
 * native › event-sourced › scraper, with ONE exception.
 *
 * Native status answers for a SESSION; Claude0 displays a PANE. Those diverge when
 * the pane parks a job (`parkedJobs`): the job runs as its own `kind:"bg"`
 * session, renders into the parent's viewport, and leaves the parent session
 * honestly `idle` — so its `<pid>.json` sits unchanged, sometimes for hours,
 * while the pane visibly churns. Every reader then sees a fresh-looking,
 * permanently-wrong "ready": no 🔄 prefix, and — because attention fires on
 * transitions — no turn-complete notification when the work does land.
 * `ready` is the *absence* of activity, so it's the one verdict that survives
 * this; a spinner anchored above the pane's prompt is positive evidence of the
 * opposite, and wins that contradiction. Deliberately narrow: a native
 * `waiting`/`running` still beats the scraper, and a scraper `ready` never
 * overrides native.
 */
export function resolveStatus(
  native: SessionStatus | null,
  eventStatus: SessionStatus | null,
  scraper: SessionStatus,
): { status: SessionStatus; source: "native" | "event" | "scraper" } {
  if (native === "ready" && scraper === "running") return { status: "running", source: "scraper" };
  if (native) return { status: native, source: "native" };
  if (eventStatus) return { status: eventStatus, source: "event" };
  return { status: scraper, source: "scraper" };
}

// Short module-level TTL cache keyed off the default dir so one refresh cycle's
// per-pane lookups collapse into a single scan.
const TTL_MS = 1000;
let cache: Map<string, SessionStatus> | null = null;
let cacheAt = 0;

/**
 * Native status for a single session, or null when absent (older Claude,
 * non-interactive, dead pid, unknown status, or the brief pre-write window).
 * Callers fall back to event ?? scraper on null.
 */
export async function nativeStatus(sessionId: string): Promise<SessionStatus | null> {
  const now = Date.now();
  if (!cache || now - cacheAt > TTL_MS) {
    cache = await loadNativeStatuses();
    cacheAt = now;
  }
  return cache.get(sessionId) ?? null;
}
