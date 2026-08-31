/**
 * ⏳ script-wait: prefix precedence, the waiting predicate, and the persisted
 * verdict store every caller shares (TUI, monitor and bridge are all short-lived
 * or concurrent, so nothing in-memory can be relied on).
 *
 * Home helper FIRST so CLAUDE0_HOME is set before config.ts freezes PATHS.dir.
 */

import "../../test/helpers/home";
import { CONFIG_DIR } from "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { detectScriptWaits, isWaiting, type ScriptWaitEntry } from "./script-wait";
import { resolveVerdicts, runnersAlive, type ProbeTarget } from "./runner-verdicts";
import { desiredPrefix, stripAllPrefixes, ATTENTION_PREFIX, RUNNING_PREFIX, SCRIPT_PREFIX } from "./notifications";

const VERDICTS_DIR = join(CONFIG_DIR, "verdicts");
const storedKeys = () => readdirSync(VERDICTS_DIR).filter((f) => !f.endsWith(".tmp")).sort();

beforeEach(() => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  rmSync(VERDICTS_DIR, { recursive: true, force: true });
});

// --- prefix helpers -------------------------------------------------------

test("desiredPrefix precedence: ⚡ > 🔄 > ⏳ > none", () => {
  expect(desiredPrefix(true, true, true)).toBe(ATTENTION_PREFIX);
  expect(desiredPrefix(false, true, true)).toBe(RUNNING_PREFIX);
  expect(desiredPrefix(false, false, true)).toBe(SCRIPT_PREFIX);
  expect(desiredPrefix(false, false, false)).toBe("");
  expect(desiredPrefix(false, false)).toBe("");
});

test("stripAllPrefixes strips ⏳ like the others, and stacked prefixes fully", () => {
  expect(stripAllPrefixes("⚡🔄claude0/fix-auth")).toBe("claude0/fix-auth");
  expect(stripAllPrefixes("⏳claude0/fix-auth")).toBe("claude0/fix-auth");
  expect(stripAllPrefixes("⚡claude0")).toBe("claude0");
  expect(stripAllPrefixes("🔄claude0")).toBe("claude0");
  expect(stripAllPrefixes("claude0")).toBe("claude0");
});

// --- isWaiting ------------------------------------------------------------

function entry(pending: ScriptWaitEntry["pending"]): ScriptWaitEntry {
  return { size: 1, mtimeMs: 1, pending, seenAt: 0 };
}

test("no pending scripts → not waiting", () => {
  expect(isWaiting(entry([]), new Map())).toBe(false);
});

test("a live runner means waiting; a dead one does not", () => {
  const e = entry([{ key: "t1", outputPath: "/tmp/t1.output" }]);
  expect(isWaiting(e, new Map([["t1", true]]))).toBe(true);
  expect(isWaiting(e, new Map([["t1", false]]))).toBe(false);
  // No verdict at all (probe failed) must not read as alive.
  expect(isWaiting(e, new Map())).toBe(false);
});

test("unprobeable task (no outputPath) stays visible", () => {
  expect(isWaiting(entry([{ key: "t1" }]), new Map())).toBe(true);
});

test("one live among dead is enough", () => {
  const e = entry([
    { key: "dead", outputPath: "/tmp/dead.output" },
    { key: "live", outputPath: "/tmp/live.output" },
  ]);
  expect(isWaiting(e, new Map([["dead", false], ["live", true]]))).toBe(true);
});

// --- resolveVerdicts (the shared, persisted store) -------------------------

const target = (key: string): ProbeTarget => ({ key, outputPath: `/tmp/${key}.output` });
const probeAll = (alive: boolean) => async (paths: string[]) => new Map(paths.map((p) => [p, alive]));
const boom = async (): Promise<Map<string, boolean>> => {
  throw new Error("probe must not run");
};

test("probes once, then serves a dead verdict from disk forever", async () => {
  expect(await resolveVerdicts([target("t1")], 1000, probeAll(false))).toEqual(new Map([["t1", false]]));
  // Far past the alive TTL — death is terminal, so this must not probe again.
  expect(await resolveVerdicts([target("t1")], 10_000_000, boom)).toEqual(new Map([["t1", false]]));
});

test("an alive verdict is trusted within the TTL, re-probed after", async () => {
  await resolveVerdicts([target("t1")], 1000, probeAll(true));
  expect(await resolveVerdicts([target("t1")], 5000, boom)).toEqual(new Map([["t1", true]]));
  // Past the TTL the runner may have exited — re-probe and record the new verdict.
  expect(await resolveVerdicts([target("t1")], 20_000, probeAll(false))).toEqual(new Map([["t1", false]]));
});

test("verdicts survive across processes — a fresh caller pays no probe", async () => {
  await resolveVerdicts([target("t1"), target("t2")], 1000, probeAll(false));
  // Simulates the next `display-popup` launch: nothing in memory, everything on disk.
  expect(await resolveVerdicts([target("t1"), target("t2")], 2000, boom)).toEqual(
    new Map([["t1", false], ["t2", false]]),
  );
});

test("only unknown targets are probed, and they go in one batch", async () => {
  await resolveVerdicts([target("known")], 1000, probeAll(false));
  const batches: string[][] = [];
  const probe = async (paths: string[]) => (batches.push(paths), new Map(paths.map((p) => [p, false])));
  await resolveVerdicts([target("known"), target("newA"), target("newB")], 2000, probe);
  expect(batches).toHaveLength(1);
  expect(batches[0].sort()).toEqual(["/tmp/newA.output", "/tmp/newB.output"]);
});

test("concurrent callers merge instead of evicting each other's verdicts", async () => {
  // The TUI and the monitor hold different candidate sets. Neither may drop the other's.
  await Promise.all([
    resolveVerdicts([target("tui1"), target("tui2")], 1000, probeAll(false)),
    resolveVerdicts([target("mon1"), target("mon2")], 1000, probeAll(false)),
  ]);
  // Neither slice may have been erased by the other's write.
  expect(storedKeys()).toEqual(["mon1", "mon2", "tui1", "tui2"]);
});

test("verdicts untouched for over a week are pruned", async () => {
  await resolveVerdicts([target("old")], 1000, probeAll(false));
  const eightDays = 8 * 24 * 60 * 60 * 1000;
  await resolveVerdicts([target("new")], eightDays, probeAll(false));
  expect(storedKeys()).toEqual(["new"]);
});

test("a corrupt verdict file degrades to a re-probe rather than throwing", async () => {
  mkdirSync(VERDICTS_DIR, { recursive: true });
  writeFileSync(join(VERDICTS_DIR, "t1"), "{not json");
  expect(await resolveVerdicts([target("t1")], 1000, probeAll(true))).toEqual(new Map([["t1", true]]));
});

test("no targets → no probe, no store write", async () => {
  expect(await resolveVerdicts([], 1000, boom)).toEqual(new Map());
});

// --- runnersAlive (the real lsof probe) -----------------------------------

test("runnersAlive: a file nothing holds open reads dead, and never throws", async () => {
  const path = join(CONFIG_DIR, "nobody-holds-this.output");
  writeFileSync(path, "x");
  expect(await runnersAlive([path])).toEqual(new Map([[path, false]]));
});

test("runnersAlive: a missing path reads dead without aborting the batch", async () => {
  // lsof exits non-zero when any path is missing, so verdicts must come from its
  // output, not its exit code — otherwise one stale path blinds the whole batch.
  const held = join(CONFIG_DIR, "held.output");
  writeFileSync(held, "x");
  const proc = Bun.spawn(["/bin/sh", "-c", `exec 9>>"${held}"; sleep 5`], { stdout: "ignore", stderr: "ignore" });
  try {
    const verdicts = await runnersAlive([join(CONFIG_DIR, "gone-abc.output"), held]);
    expect(verdicts.get(join(CONFIG_DIR, "gone-abc.output"))).toBe(false);
    expect(verdicts.get(held)).toBe(true);
  } finally {
    proc.kill();
    await proc.exited;
  }
});

test("runnersAlive: a live runner under a symlinked root still reads alive", async () => {
  // On macOS /tmp is a symlink to /private/tmp and lsof reports the resolved path.
  // Matching raw strings would report this live runner as dead.
  const real = join(CONFIG_DIR, "symlinked.output");
  writeFileSync(real, "x");
  const viaSymlink = real.startsWith("/private/") ? real.slice("/private".length) : real;
  const proc = Bun.spawn(["/bin/sh", "-c", `exec 9>>"${real}"; sleep 5`], { stdout: "ignore", stderr: "ignore" });
  try {
    expect((await runnersAlive([viaSymlink])).get(viaSymlink)).toBe(true);
  } finally {
    proc.kill();
    await proc.exited;
  }
});

test("runnersAlive: empty input does not spawn anything", async () => {
  expect(await runnersAlive([])).toEqual(new Map());
});

// --- detectScriptWaits: the per-session transcript-parse cache ------------

const PROJECTS = join(CONFIG_DIR, "projects");

/** Write a transcript whose only content is one pending background script. */
function transcript(sessionId: string, taskId: string): void {
  mkdirSync(join(PROJECTS, "proj"), { recursive: true });
  writeFileSync(
    join(PROJECTS, "proj", `${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "sleep 99", run_in_background: true } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/${taskId}.output.`,
            },
          ],
        },
      }),
    ].join("\n"),
  );
}

const CACHE = join(CONFIG_DIR, "script-wait.json");
const readCache = () => JSON.parse(readFileSync(CACHE, "utf-8"));

test("a live runner makes the session wait; a dead one does not", async () => {
  rmSync(PROJECTS, { recursive: true, force: true });
  rmSync(CACHE, { force: true });
  transcript("sessA", "blive");
  expect(await detectScriptWaits(["sessA"], probeAll(true), PROJECTS)).toEqual(new Set(["sessA"]));

  rmSync(VERDICTS_DIR, { recursive: true, force: true });
  expect(await detectScriptWaits(["sessA"], probeAll(false), PROJECTS)).toEqual(new Set());
});

test("an unchanged cycle rewrites nothing — the TUI polls at 3s and the monitor per tick", async () => {
  rmSync(PROJECTS, { recursive: true, force: true });
  rmSync(CACHE, { force: true });
  transcript("sessA", "bdead");
  await detectScriptWaits(["sessA"], probeAll(false), PROJECTS);
  const before = statSync(CACHE).mtimeMs;
  await Bun.sleep(10);
  await detectScriptWaits(["sessA"], probeAll(false), PROJECTS);
  expect(statSync(CACHE).mtimeMs).toBe(before);
});

test("sessions the caller didn't ask about keep their cache entries", async () => {
  rmSync(PROJECTS, { recursive: true, force: true });
  rmSync(CACHE, { force: true });
  transcript("sessA", "ba");
  transcript("sessB", "bb");
  // Stands in for the monitor and the TUI arriving with different candidate sets.
  await detectScriptWaits(["sessA"], probeAll(false), PROJECTS);
  await detectScriptWaits(["sessB"], probeAll(false), PROJECTS);
  expect(Object.keys(readCache()).sort()).toEqual(["sessA", "sessB"]);
});

test("fields from an older cache shape are dropped rather than copied forward", async () => {
  rmSync(PROJECTS, { recursive: true, force: true });
  transcript("sessA", "bdead");
  // The pre-split shape carried per-entry `verdicts`; those now live in their own store.
  const { size, mtimeMs } = statSync(join(PROJECTS, "proj", "sessA.jsonl"));
  writeFileSync(
    CACHE,
    JSON.stringify({
      sessA: { size, mtimeMs, pending: [{ key: "bdead", outputPath: "/tmp/bdead.output" }], verdicts: { bdead: { ts: 1, alive: false } } },
    }),
  );
  await detectScriptWaits(["sessA"], probeAll(false), PROJECTS);
  expect(Object.keys(readCache().sessA).sort()).toEqual(["mtimeMs", "pending", "seenAt", "size"]);
});

test("a changed transcript is re-parsed", async () => {
  rmSync(PROJECTS, { recursive: true, force: true });
  rmSync(CACHE, { force: true });
  transcript("sessA", "bfirst");
  await detectScriptWaits(["sessA"], probeAll(false), PROJECTS);
  expect(readCache().sessA.pending[0].key).toBe("bfirst");
  transcript("sessA", "bsecond");
  await detectScriptWaits(["sessA"], probeAll(false), PROJECTS);
  expect(readCache().sessA.pending[0].key).toBe("bsecond");
});

// --- parked jobs: the wait lives in the JOB's transcript, the badge on the pane ---

test("a parked job's live script makes its PARENT session wait", async () => {
  rmSync(PROJECTS, { recursive: true, force: true });
  rmSync(CACHE, { force: true });
  transcript("job", "bjob");
  // The parent's own transcript is quiet — a parked job's turns land in the job's.
  writeFileSync(join(PROJECTS, "proj", "parent.jsonl"), "");
  const jobs = new Map([["parent", "job"]]);

  expect(await detectScriptWaits(["parent"], probeAll(true), PROJECTS, jobs)).toEqual(new Set(["parent"]));
  // The job id itself is never returned — callers badge the pane's session.
  expect(await detectScriptWaits(["parent"], probeAll(true), PROJECTS, jobs).then((s) => s.has("job"))).toBe(false);

  rmSync(VERDICTS_DIR, { recursive: true, force: true });
  expect(await detectScriptWaits(["parent"], probeAll(false), PROJECTS, jobs)).toEqual(new Set());
});

test("without a parked job the parent's own transcript still decides", async () => {
  rmSync(PROJECTS, { recursive: true, force: true });
  rmSync(CACHE, { force: true });
  transcript("solo", "bsolo");
  expect(await detectScriptWaits(["solo"], probeAll(true), PROJECTS, new Map())).toEqual(new Set(["solo"]));
});
