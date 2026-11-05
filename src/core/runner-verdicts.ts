/**
 * "Is this background task's runner still alive?" — the one place that question is
 * answered, for every process that asks (TUI, monitor, bridge).
 *
 * Three properties drive the design:
 *
 * 1. It is a fact about OTHER processes, so it is inherently cross-process and its
 *    natural home is disk. An in-memory verdict cache only helps a process that
 *    outlives the probe — and the monitor does not: it is a fresh process per tmux
 *    status tick, so it would re-prove the same permanently-dead verdicts every tick.
 * 2. Death is terminal — a runner never revives. So a dead verdict is written once
 *    and never probed again by anyone. An alive verdict re-probes after a short TTL
 *    to notice the runner exiting.
 * 3. The writers run concurrently and each sees a different slice of tasks. So
 *    verdicts are stored one file per task (atomic temp+rename), exactly as
 *    `savePaneSessions` stores one file per pane: independent keys never contend,
 *    which removes the read-modify-write race by construction instead of narrowing
 *    it. A single shared JSON file cannot do this — two callers both re-read before
 *    either writes, and the loser's slice is silently dropped.
 *
 * Verdicts key on the harness task id, which is unique per task, so the store is
 * flat rather than per-session — that is what lets `liveScripts` (which only has
 * tasks, no session id) share it with the session-level parse cache.
 */
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PATHS } from "./config";
import { withDeadline } from "./deadline";

/**
 * lsof lives at /usr/sbin/lsof on macOS and /usr/bin/lsof on Linux, and the monitor
 * runs under tmux's status-command environment whose PATH can lack both dirs — so
 * resolve via PATH first, then the known absolute homes. Resolved once at import: a
 * bare "lsof" that ENOENTs inside the probe would misreport every runner as dead.
 */
export const LSOF =
  Bun.which("lsof") ?? ["/usr/sbin/lsof", "/usr/bin/lsof"].find(existsSync) ?? "lsof";

const VERDICTS_DIR = `${PATHS.dir}/verdicts`;
const ALIVE_TTL_MS = 15_000;
/** Drop verdicts untouched for this long, so a terminal-by-design store stays bounded. */
const PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

/** A task we can probe: its identity, and the output file its runner holds open. */
export interface ProbeTarget {
  key: string;
  outputPath: string;
}

/** Batched liveness probe. Injected in tests; `runnersAlive` is the real one. */
export type RunnerProbe = (outputPaths: string[]) => Promise<Map<string, boolean>>;

interface Verdict {
  ts: number;
  alive: boolean;
}

/** Task ids are alphanumeric in practice; encode anyway so no key can escape the dir. */
const fileFor = (key: string) => `${VERDICTS_DIR}/${encodeURIComponent(key)}`;

/**
 * Whether anything still runs each task: the runner holds an open fd on its output
 * file for its whole life, so `lsof` on that path is a definitive orphan test. A
 * session resumed under a new Claude process orphans its tasks — the transcript then
 * says "pending" forever (seen in real data: a 3-day-old wait on a live pane), and
 * this probe is what catches it.
 *
 * One `lsof` for the whole set, not one per path. `lsof` walks every process's fd
 * table, so it costs ~115ms regardless of how many paths it is asked about — probing
 * serially made the cost scale with the number of orphaned tasks (7 accumulated
 * orphans measured at 807ms; batched, 118ms). It is also the more honest answer: a
 * single consistent snapshot rather than N snapshots smeared across a second.
 *
 * Paths absent from the output read dead, which folds in the missing-file case
 * (tmp pruned, reboot) for free.
 */
export const runnersAlive: RunnerProbe = async (outputPaths) => {
  const verdicts = new Map<string, boolean>(outputPaths.map((p) => [p, false]));
  if (outputPaths.length === 0) return verdicts;

  // `lsof` reports resolved paths, so a target recorded under a symlinked root
  // (on macOS `/tmp` is a symlink to `/private/tmp`) would never match its own
  // output and a live runner would silently read dead. Match on the resolved form.
  // A path that cannot be resolved no longer exists — its runner is gone.
  const byResolved = new Map<string, string[]>();
  await Promise.all(
    outputPaths.map(async (p) => {
      try {
        const resolved = await realpath(p);
        const same = byResolved.get(resolved);
        if (same) same.push(p);
        else byResolved.set(resolved, [p]);
      } catch {}
    }),
  );
  if (byResolved.size === 0) return verdicts;

  try {
    // `--` guards a path that starts with a dash.
    const proc = Bun.spawn([LSOF, "-F", "n", "--", ...byResolved.keys()], {
      stdout: "pipe",
      stderr: "ignore",
    });
    // Read before awaiting exit so a large fd list can't fill the pipe and deadlock.
    // The exit code is deliberately unused: one missing path makes `lsof` exit
    // non-zero while still correctly reporting every other path, so the verdicts have
    // to come from the output itself.
    const out = await new Response(proc.stdout).text();
    // EOF above means lsof closed stdout and is done — `exited` is only reaping. Bun can
    // lose a child's exit under concurrent spawn churn, leaving this await pending forever,
    // so bound it and keep the (already complete) output either way.
    await withDeadline(proc.exited, 2000, "lsof exit").catch(() => {});
    for (const line of out.split("\n")) {
      if (!line.startsWith("n")) continue;
      for (const p of byResolved.get(line.slice(1)) ?? []) verdicts.set(p, true);
    }
  } catch {
    // lsof unavailable/failed — treat as dead rather than badge forever.
  }
  return verdicts;
};

async function readVerdict(key: string): Promise<Verdict | null> {
  try {
    const v = JSON.parse(await Bun.file(fileFor(key)).text());
    return typeof v?.ts === "number" && typeof v?.alive === "boolean" ? v : null;
  } catch {
    return null; // absent, in-flight, or corrupt — probe again
  }
}

async function writeVerdict(key: string, verdict: Verdict): Promise<void> {
  const dest = fileFor(key);
  const tmp = `${dest}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(verdict));
    await rename(tmp, dest);
  } catch {}
}

/** Bound directory growth. Only runs when something was probed, so it is off the hot path. */
async function prune(now: number): Promise<void> {
  try {
    const files = await readdir(VERDICTS_DIR);
    await Promise.all(
      files.map(async (f) => {
        if (f.endsWith(".tmp")) return; // in-flight atomic write
        const v = await readVerdict(decodeURIComponent(f));
        if (v && now - v.ts > PRUNE_MS) await unlink(`${VERDICTS_DIR}/${f}`).catch(() => {});
      }),
    );
  } catch {}
}

/**
 * Liveness for each target, probing only what the store can't already answer.
 *
 * Each resolved verdict is written to its own file, so concurrent callers holding
 * different task sets never overwrite each other — see the note at the top of this
 * file for why a single shared JSON file cannot give that guarantee.
 */
export async function resolveVerdicts(
  targets: ProbeTarget[],
  now: number = Date.now(),
  probe: RunnerProbe = runnersAlive,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (targets.length === 0) return out;

  const stale: ProbeTarget[] = [];
  await Promise.all(
    targets.map(async (t) => {
      const v = await readVerdict(t.key);
      // A dead verdict is trusted forever; an alive one only within the TTL.
      if (v && (!v.alive || now - v.ts < ALIVE_TTL_MS)) out.set(t.key, v.alive);
      else stale.push(t);
    }),
  );
  if (stale.length === 0) return out;

  const probed = await probe(stale.map((t) => t.outputPath));
  await mkdir(VERDICTS_DIR, { recursive: true }).catch(() => {});
  await Promise.all(
    stale.map(async (t) => {
      const alive = probed.get(t.outputPath) ?? false;
      out.set(t.key, alive);
      await writeVerdict(t.key, { ts: now, alive });
    }),
  );
  await prune(now);
  return out;
}
