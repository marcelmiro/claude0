/**
 * "Is this session waiting on a background script?" — the ⏳ badge, for every caller.
 *
 * Two caches sit behind the answer, split by what they actually key on:
 *  - this file: the per-session TRANSCRIPT PARSE, keyed by (size, mtime). A full
 *    transcript read only happens when a candidate's transcript changes.
 *  - `runner-verdicts.ts`: the per-task LIVENESS verdict, keyed by task id. Shared
 *    with `liveScripts`, which has tasks but no session id.
 *
 * Both are on disk because none of the callers outlive the work: the monitor is a
 * fresh process per tmux status tick, and the TUI is a fresh process per
 * `display-popup` open. Steady-state cost per call is one stat per candidate session,
 * and one `lsof` for all genuinely-live runners every ~15s.
 *
 * Note the two use different concurrency strategies, deliberately. Verdicts get one
 * file per task because a lost verdict costs a fresh ~115ms `lsof` and is a fact about
 * a process that may since have exited. This file stays a single JSON document under
 * last-write-wins: it is a pure memo of the transcript, so the worst a lost entry can
 * do is force one re-read that reproduces exactly the same answer.
 */
import { parseBackgroundTasksFile, pendingScripts, taskKey } from "./background-tasks";
import { resolveVerdicts, runnersAlive, type ProbeTarget, type RunnerProbe } from "./runner-verdicts";
import { resolveTranscriptPath } from "./last-turn";
import { parkedJobSessions } from "./session-state";
import { PATHS, writeAtomic } from "./config";

const CACHE_PATH = `${PATHS.dir}/script-wait.json`;
/** Drop entries untouched for this long, so the file tracks recent sessions only. */
const PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How stale `seenAt` may get before a read refreshes it. Only pruning consumes it, at
 * week granularity, so re-stamping it on every call would rewrite the whole file every
 * few seconds — the TUI polls at 3s and the monitor once per tmux status tick.
 */
const SEEN_REFRESH_MS = 60 * 60 * 1000;

export interface ScriptWaitEntry {
  size: number;
  mtimeMs: number;
  /** Pending scripts per the transcript: identity, probe target, and whether it's a service (`isServiceScript`). */
  pending: Array<{ key: string; outputPath?: string; service?: boolean }>;
  /** Last time a caller looked this session up — drives age-based pruning. */
  seenAt: number;
}

type ScriptWaitCache = Record<string, ScriptWaitEntry>;

async function loadCache(): Promise<ScriptWaitCache> {
  try {
    return JSON.parse(await Bun.file(CACHE_PATH).text());
  } catch {
    return {};
  }
}

/** Every probeable task across `entries`, deduped so one task is probed once. */
function probeTargets(entries: ScriptWaitEntry[]): ProbeTarget[] {
  const byKey = new Map<string, ProbeTarget>();
  for (const entry of entries) {
    for (const t of entry.pending) {
      if (t.outputPath) byKey.set(t.key, { key: t.key, outputPath: t.outputPath });
    }
  }
  return [...byKey.values()];
}

/**
 * An entry's pending scripts that are still running, given already-resolved verdicts.
 * A task without an outputPath can't be probed and counts as live (same posture as
 * `liveScripts`).
 */
export function liveTasks(entry: ScriptWaitEntry, verdicts: Map<string, boolean>): ScriptWaitEntry["pending"] {
  return entry.pending.filter((t) => !t.outputPath || verdicts.get(t.key) === true);
}

/** `wait` = the session waits on a live script; `service` = every live script is a service. */
export type ScriptWait = "wait" | "service";

export function waitKind(live: ScriptWaitEntry["pending"]): ScriptWait | null {
  if (live.length === 0) return null;
  return live.every((t) => t.service) ? "service" : "wait";
}

/**
 * The subset of `sessionIds` with a live background script (the ⏳ mark), each with
 * its `waitKind` — only inbox placement reads the kind.
 *
 * Entries for other sessions are preserved, not pruned: the TUI and the monitor both
 * call this with their own candidate sets, and dropping "everything the current
 * caller didn't ask about" would have them evicting each other's parse caches on
 * every cycle. Stale entries age out instead.
 */
export async function detectScriptWaits(
  sessionIds: string[],
  probe: RunnerProbe = runnersAlive,
  projectsDir?: string,
  jobs?: Map<string, string>,
): Promise<Map<string, ScriptWait>> {
  const now = Date.now();
  const cache = await loadCache();
  const current = new Map<string, ScriptWaitEntry>();
  let dirty = false;

  // A parked job's script runs in the parent's pane but is recorded in the JOB's
  // transcript, and the parent's own transcript goes quiet for the duration — so
  // asking only about the parent's session id misses the wait entirely. Parse both
  // and credit the job's verdict to the parent, since the pane is what gets badged.
  const jobBySession = jobs ?? (await parkedJobSessions());
  const lookupIds = [...new Set(sessionIds.flatMap((id) => {
    const job = jobBySession.get(id);
    return job ? [id, job] : [id];
  }))];

  for (const id of lookupIds) {
    try {
      const path = await resolveTranscriptPath(id, projectsDir);
      if (!path) continue;
      const stat = await Bun.file(path).stat();
      if (!stat) continue;
      let entry = cache[id];
      if (!entry || entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) {
        const tasks = await parseBackgroundTasksFile(path);
        entry = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          pending: pendingScripts(tasks).map((t) => ({
            key: taskKey(t),
            outputPath: t.outputPath,
            ...(t.service && { service: true }),
          })),
          seenAt: now,
        };
        dirty = true;
      }
      current.set(id, entry);
    } catch {
      // unreadable transcript — no verdict, no ⏳
    }
  }
  if (current.size === 0) return new Map();

  // One probe round for every candidate session at once, so the batched `lsof` gets
  // the whole set rather than one call per session.
  const verdicts = await resolveVerdicts(probeTargets([...current.values()]), now, probe);
  const out = new Map<string, ScriptWait>();
  for (const id of sessionIds) {
    const job = jobBySession.get(id);
    const entries = [current.get(id), job ? current.get(job) : undefined];
    const kind = waitKind(entries.flatMap((e) => (e ? liveTasks(e, verdicts) : [])));
    if (kind) out.set(id, kind);
  }

  // Re-read before writing: concurrent callers each hold a different slice, and a
  // caller must never drop entries it simply didn't ask about.
  try {
    const merged = await loadCache();
    for (const [id, entry] of current) {
      // An entry written by an older cache shape has no `seenAt`; treat it as
      // maximally stale so it gets stamped now rather than pruned on this same pass.
      const prevSeen = typeof entry.seenAt === "number" ? entry.seenAt : 0;
      const seenAt = now - prevSeen > SEEN_REFRESH_MS ? now : prevSeen;
      if (seenAt !== entry.seenAt) dirty = true;
      // Rebuild rather than spread, so fields from an older cache shape die out
      // instead of being copied forward forever.
      merged[id] = { size: entry.size, mtimeMs: entry.mtimeMs, pending: entry.pending, seenAt };
    }
    for (const [id, entry] of Object.entries(merged)) {
      if (now - (entry.seenAt ?? 0) > PRUNE_MS) {
        delete merged[id];
        dirty = true;
      }
    }
    if (dirty) writeAtomic(CACHE_PATH, JSON.stringify(merged));
  } catch {
    // Unwritable cache — the verdicts above are still correct for this call.
  }
  return out;
}
