// Home helper FIRST so CLAUDE0_HOME is set before config.ts freezes PATHS.dir —
// `liveScripts` now resolves verdicts through the persisted store, which must
// land in the throwaway temp home rather than the real ~/.config/claude0.
import "../../test/helpers/home";
import { CONFIG_DIR } from "../../test/helpers/home";
import { describe, expect, test, beforeEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { parseBackgroundTasks, pendingScripts, liveScripts, isServiceScript, scanAgentScripts, workflowProgress, withWorkflowProgress, endedWorkflows, backgroundLead, screenTotal, withScreenTotals } from "./background-tasks";

// Dead verdicts are terminal AND persisted, so they would otherwise leak between tests.
beforeEach(() => rmSync(join(CONFIG_DIR, "verdicts"), { recursive: true, force: true }));

/** Batched-probe stand-in: alive iff the path satisfies `isAlive`. */
const probeWhere = (isAlive: (p: string) => boolean) => async (paths: string[]) =>
  new Map(paths.map((p) => [p, isAlive(p)]));

const line = (o: unknown) => JSON.stringify(o);

function bashLaunch(id: string, taskId: string | null, cmd = "sleep 99", ts = "2026-07-21T00:00:00Z") {
  const use = line({
    type: "assistant",
    timestamp: ts,
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd, run_in_background: true } }] },
  });
  const resultText = taskId
    ? `Command running in background with ID: ${taskId}. Output is being written to: /tmp/${taskId}.output.`
    : "Permission for this action was denied by the auto mode classifier.";
  const result = line({
    type: "user",
    timestamp: ts,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: resultText }] },
  });
  return [use, result];
}

const notif = (taskId: string, toolUseId: string, status = "completed") =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`;

// Shapes copied from real Claude Code 2.1.319 records (probe Monitors run 2026-11-07).
function monitorLaunch(id: string, taskId: string | null, timeoutMs: number | null = 120000, ts = "2026-11-07T20:38:05.731Z") {
  const use = line({
    type: "assistant",
    timestamp: ts,
    message: {
      content: [{ type: "tool_use", id, name: "Monitor", input: { description: "c1021 write run, one line per chunk", timeout_ms: 1800000, command: "tail -n +1 -F /tmp/w.log | grep --line-buffered chunk" } }],
    },
  });
  const resultText = taskId
    ? `Monitor started (task ${taskId}, expires in 2m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch).`
    : "Permission for this action was denied by the auto mode classifier.";
  const result = line({
    type: "user",
    timestamp: ts,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: resultText }] },
    ...(taskId && timeoutMs !== null && { toolUseResult: { taskId, timeoutMs, persistent: false } }),
  });
  return [use, result];
}
const monitorEvent = (taskId: string, event: string) =>
  line({ type: "user", message: { content: `<task-notification>\n<task-id>${taskId}</task-id>\n<summary>Monitor event: "c1021 write run"</summary>\n<event>${event}</event>\n</task-notification>` } });
const monitorEnded = (taskId: string, toolUseId: string) =>
  line({ type: "user", message: { content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/${taskId}.output</output-file>\n<status>completed</status>\n<summary>Monitor "c1021 write run" stream ended</summary>\n<event>ALL_DONE</event>\n</task-notification>` } });
const taskStop = (id: string, taskId: string) => [
  line({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "TaskStop", input: { task_id: taskId } }] } }),
  line({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify({ message: `Successfully stopped task: ${taskId} (tail -F /tmp/w.log)`, task_id: taskId, task_type: "local_bash" }) }] },
  }),
];

describe("Monitor tasks", () => {
  test("a confirmed Monitor launch is a pending script whose deadline is launch + timeoutMs", () => {
    const [task] = parseBackgroundTasks(monitorLaunch("toolu_m", "bmon1").join("\n"));
    expect(task).toEqual({
      toolUseId: "toolu_m",
      kind: "script",
      label: "c1021 write run, one line per chunk",
      status: "pending",
      taskId: "bmon1",
      launchedAt: "2026-11-07T20:38:05.731Z",
      deadline: Date.parse("2026-11-07T20:38:05.731Z") + 120000,
    });
  });

  test("a launch record without timeoutMs falls back to the 30m cap", () => {
    const [task] = parseBackgroundTasks(monitorLaunch("toolu_m", "bmon1", null).join("\n"));
    expect(task!.deadline).toBe(Date.parse("2026-11-07T20:38:05.731Z") + 30 * 60 * 1000);
  });

  test("a denied Monitor (no 'Monitor started') yields no task", () => {
    expect(parseBackgroundTasks(monitorLaunch("toolu_m", null).join("\n"))).toEqual([]);
  });

  test("per-event notifications keep it pending; the stream-ended notice completes it", () => {
    const launched = [...monitorLaunch("toolu_m", "bmon1"), monitorEvent("bmon1", "chunk ids-00 attempt 1 failed=0")];
    expect(parseBackgroundTasks(launched.join("\n"))[0]!.status).toBe("pending");
    expect(parseBackgroundTasks([...launched, monitorEnded("bmon1", "toolu_m")].join("\n"))[0]!.status).toBe("completed");
  });

  test("keeps the newest line of the latest event as its progress", () => {
    // Lines that arrive together are batched into one event, oldest first.
    const jsonl = [...monitorLaunch("toolu_m", "bmon1"), monitorEvent("bmon1", "BUILDING"), monitorEvent("bmon1", "DEPLOYING 1/3\nDEPLOYING 2/3\n")];
    expect(parseBackgroundTasks(jsonl.join("\n"))[0]!.lastEvent).toBe("DEPLOYING 2/3");
  });

  test("the expiry event ends it", () => {
    const jsonl = [
      ...monitorLaunch("toolu_m", "bmon1"),
      monitorEvent("bmon1", "[Monitor expired after 45s with no events delivered. Re-arm it if you still need the watch.]"),
    ];
    expect(parseBackgroundTasks(jsonl.join("\n"))[0]!.status).toBe("completed");
  });

  test("a TaskStop of it kills it — a stopped Monitor gets no notification", () => {
    const jsonl = [...monitorLaunch("toolu_m", "bmon1"), ...taskStop("toolu_s", "bmon1")];
    expect(parseBackgroundTasks(jsonl.join("\n"))[0]!.status).toBe("killed");
  });

  test("a foreground command whose output IS a TaskStop result kills nothing", () => {
    const jsonl = [
      ...monitorLaunch("toolu_m", "bmon1"),
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_c", name: "Bash", input: { command: "cat /tmp/stop.json" } }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_c", content: '{"message":"Successfully stopped task: bmon1 (tail -F /tmp/w.log)"}' }] } }),
    ];
    expect(parseBackgroundTasks(jsonl.join("\n"))[0]!.status).toBe("pending");
  });

  test("output that merely quotes a TaskStop result kills nothing", () => {
    const jsonl = [
      ...monitorLaunch("toolu_m", "bmon1"),
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_g", name: "Bash", input: { command: "grep stopped t.jsonl" } }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_g", content: 'x {"message":"Successfully stopped task: bmon1"}' }] } }),
    ];
    expect(parseBackgroundTasks(jsonl.join("\n"))[0]!.status).toBe("pending");
  });

  test("liveScripts: live before its deadline, gone after — never runner-probed", async () => {
    const batches: string[][] = [];
    const probe = async (paths: string[]) => (batches.push(paths), new Map(paths.map((p) => [p, true])));
    const now = Date.now();
    const at = (ms: number) => new Date(ms).toISOString();
    const fresh = parseBackgroundTasks(monitorLaunch("toolu_a", "bfresh", 1800000, at(now - 60_000)).join("\n"));
    const stale = parseBackgroundTasks(monitorLaunch("toolu_b", "bstale", 1800000, at(now - 31 * 60_000)).join("\n"));
    expect((await liveScripts([...fresh, ...stale], probe)).map((t) => t.taskId)).toEqual(["bfresh"]);
    expect(batches.flat()).toEqual([]);
  });
});

describe("parseBackgroundTasks", () => {
  test("bash launch without notification is a pending script", () => {
    const tasks = parseBackgroundTasks(bashLaunch("toolu_1", "babc123").join("\n"));
    expect(tasks).toEqual([
      {
        toolUseId: "toolu_1",
        kind: "script",
        label: "sleep 99",
        status: "pending",
        taskId: "babc123",
        outputPath: "/tmp/babc123.output",
        launchedAt: "2026-07-21T00:00:00Z",
      },
    ]);
  });

  test("label prefers the tool call's description over the raw command", () => {
    const jsonl = [
      line({
        type: "assistant",
        timestamp: "2026-07-21T00:00:00Z",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "for _ in $(seq 1 180); do gh api …; sleep 30; done", description: "Background wait for Codex review", run_in_background: true },
            },
          ],
        },
      }),
      line({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Command running in background with ID: bwait1." }],
        },
      }),
    ].join("\n");
    expect(parseBackgroundTasks(jsonl)[0]!.label).toBe("Background wait for Codex review");
  });

  test("user-message notification completes the task", () => {
    const jsonl = [
      ...bashLaunch("toolu_1", "babc123"),
      line({ type: "user", message: { content: notif("babc123", "toolu_1") } }),
    ].join("\n");
    expect(parseBackgroundTasks(jsonl)[0]!.status).toBe("completed");
  });

  test("queue-operation carrier (root-level content) pairs by task-id", () => {
    const jsonl = [
      ...bashLaunch("toolu_1", "babc123"),
      line({ type: "queue-operation", operation: "enqueue", content: notif("babc123", "toolu_1") }),
    ].join("\n");
    expect(parseBackgroundTasks(jsonl)[0]!.status).toBe("completed");
  });

  test("queued_command attachment carrier pairs, and killed status sticks", () => {
    const jsonl = [
      ...bashLaunch("toolu_1", "babc123"),
      line({
        type: "attachment",
        attachment: { type: "queued_command", prompt: notif("babc123", "toolu_1", "killed") },
      }),
    ].join("\n");
    expect(parseBackgroundTasks(jsonl)[0]!.status).toBe("killed");
  });

  test("denied bash launch (no task created) yields no task", () => {
    expect(parseBackgroundTasks(bashLaunch("toolu_1", null).join("\n"))).toEqual([]);
  });

  test("foreground bash whose OUTPUT quotes launch text yields no task", () => {
    const jsonl = [
      line({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "grep bg *.jsonl" } }] },
      }),
      line({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "Command running in background with ID: bzzz." },
          ],
        },
      }),
    ].join("\n");
    expect(parseBackgroundTasks(jsonl)).toEqual([]);
  });

  const timeoutNotice = (taskId: string) =>
    `Command did not complete within its 120s timeout and was moved to the background (ID: ${taskId}). Output is being written to: /tmp/${taskId}.output. You will be notified when it completes.`;

  const foregroundBash = (id: string, resultText: string) => [
    line({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "bun run replay.ts", description: "Replay the gap" } }] },
    }),
    line({
      type: "user",
      timestamp: "2026-07-21T00:02:00Z",
      message: { content: [{ type: "tool_result", tool_use_id: id, content: resultText }] },
    }),
  ];

  test("foreground bash that times out into the background is a pending script, completed by its notification", () => {
    const launched = foregroundBash("toolu_1", timeoutNotice("btime01"));
    expect(parseBackgroundTasks(launched.join("\n"))).toEqual([
      {
        toolUseId: "toolu_1",
        kind: "script",
        label: "Replay the gap",
        status: "pending",
        taskId: "btime01",
        outputPath: "/tmp/btime01.output",
        launchedAt: "2026-07-21T00:02:00Z",
      },
    ]);
    const done = [...launched, line({ type: "user", message: { content: notif("btime01", "toolu_1") } })];
    expect(parseBackgroundTasks(done.join("\n"))[0]!.status).toBe("completed");
  });

  test("a user ! command that times out into the background is a pending script labelled with its command", () => {
    const jsonl = [
      line({ type: "user", message: { content: "<bash-input> bash replay.sh replies</bash-input>" } }),
      line({
        type: "user",
        timestamp: "2026-07-21T00:02:00Z",
        message: { content: `<bash-stdout>${timeoutNotice("bbang01")}</bash-stdout><bash-stderr></bash-stderr>` },
      }),
    ].join("\n");
    expect(parseBackgroundTasks(jsonl)).toEqual([
      {
        toolUseId: "bbang01",
        kind: "script",
        label: "bash replay.sh replies",
        status: "pending",
        taskId: "bbang01",
        outputPath: "/tmp/bbang01.output",
        launchedAt: "2026-07-21T00:02:00Z",
      },
    ]);
  });

  test("an api-request-blob replaying a launch's result neither relaunches nor reopens the task", () => {
    const launched = foregroundBash("toolu_1", timeoutNotice("btime02"));
    const replay = line({
      type: "api-request-blob",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: timeoutNotice("btime02") }] },
    });
    const done = [...launched, line({ type: "user", message: { content: notif("btime02", "toolu_1") } }), replay];
    expect(parseBackgroundTasks(done.join("\n")).map((t) => [t.status, t.launchedAt])).toEqual([["completed", "2026-07-21T00:02:00Z"]]);
  });

  test("a user ! command that printed output before timing out is still a pending script", () => {
    const jsonl = [
      line({ type: "user", message: { content: "<bash-input> bun import.ts --push</bash-input>" } }),
      line({
        type: "user",
        message: { content: `<bash-stdout>Retrying in 1,000 ms\n{"status":502}\n${timeoutNotice("bbang02")}</bash-stdout><bash-stderr></bash-stderr>` },
      }),
    ].join("\n");
    expect(parseBackgroundTasks(jsonl).map((t) => [t.taskId, t.label, t.status])).toEqual([["bbang02", "bun import.ts --push", "pending"]]);
  });

  test("a user ! command whose output quotes the timeout notice mid-line yields no task", () => {
    const jsonl = line({ type: "user", message: { content: `<bash-stdout>session.jsonl:${timeoutNotice("bzzz")}</bash-stdout>` } });
    expect(parseBackgroundTasks(jsonl)).toEqual([]);
  });

  test("foreground bash whose OUTPUT quotes the timeout notice yields no task", () => {
    const jsonl = foregroundBash("toolu_1", `session.jsonl:${timeoutNotice("bzzz")}`).join("\n");
    expect(parseBackgroundTasks(jsonl)).toEqual([]);
  });

  test("synchronous Agent call (result is the report, no async confirmation) yields no task", () => {
    const jsonl = [
      line({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_1", name: "Agent", input: { description: "Blind plan review", prompt: "…" } },
          ],
        },
      }),
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Here is my review: fine." }] },
      }),
    ].join("\n");
    expect(parseBackgroundTasks(jsonl)).toEqual([]);
  });

  test("async Agent launch (flag absent — background by default) pairs via agentId", () => {
    const jsonl = [
      line({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { description: "Research X", prompt: "…" } }],
        },
      }),
      line({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "Async agent launched successfully.\nagentId: a1b2c3d4e5f6a7b8c (internal)",
            },
          ],
        },
      }),
      line({ type: "user", message: { content: notif("a1b2c3d4e5f6a7b8c", "toolu_1") } }),
    ].join("\n");
    const tasks = parseBackgroundTasks(jsonl);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.kind).toBe("agent");
    expect(tasks[0]!.status).toBe("completed");
  });

  test("a restart's notice listing several unfinished tasks ends every one of them", () => {
    // Real shape: one notice, one <task-id> per task the previous process left running.
    const orphans = `<task-notification>\n<task-id>bone</task-id>\n<task-id>btwo</task-id>\n<status>failed</status>\n<summary>2 background tasks didn't finish before the previous session ended</summary>\n</task-notification>`;
    const jsonl = [...bashLaunch("toolu_1", "bone"), ...bashLaunch("toolu_2", "btwo"), ...bashLaunch("toolu_3", "bthree"), line({ type: "user", message: { content: orphans } })].join("\n");
    expect(parseBackgroundTasks(jsonl).map((t) => t.status)).toEqual(["completed", "completed", "pending"]);
  });

  test("unmatched notification (nested agent / pre-split launch) is ignored", () => {
    const jsonl = line({ type: "user", message: { content: notif("astray1", "toolu_gone") } });
    expect(parseBackgroundTasks(jsonl)).toEqual([]);
  });

  test("torn lines and empty input never throw", () => {
    expect(parseBackgroundTasks("")).toEqual([]);
    expect(parseBackgroundTasks('{"type":"assistant","message":{"content":[{"type":"tool_use","run_in_background')).toEqual([]);
  });
});

describe("liveScripts", () => {
  test("a pending task whose runner is dead (orphaned by a resume) is dropped", async () => {
    const jsonl = [
      ...bashLaunch("toolu_1", "bdead1", "gh pr checks --watch"),
      ...bashLaunch("toolu_2", "blive2", "gh pr checks --watch"),
    ].join("\n");
    const live = await liveScripts(parseBackgroundTasks(jsonl), probeWhere((p) => p.includes("blive2")));
    expect(live.map((t) => t.taskId)).toEqual(["blive2"]);
  });

  test("a dead verdict is terminal — the probe is never re-run for that task", async () => {
    const jsonl = bashLaunch("toolu_1", "bdead9").join("\n");
    let calls = 0;
    const probe = async (paths: string[]) => (calls += 1, new Map(paths.map((p) => [p, false])));
    const tasks = parseBackgroundTasks(jsonl);
    await liveScripts(tasks, probe);
    await liveScripts(tasks, probe);
    expect(calls).toBe(1);
  });

  test("all tasks are probed in ONE batched call, not one call each", async () => {
    const jsonl = [
      ...bashLaunch("toolu_1", "bone"),
      ...bashLaunch("toolu_2", "btwo"),
      ...bashLaunch("toolu_3", "bthree"),
    ].join("\n");
    const batches: string[][] = [];
    const probe = async (paths: string[]) => (batches.push(paths), new Map(paths.map((p) => [p, true])));
    const live = await liveScripts(parseBackgroundTasks(jsonl), probe);
    expect(live).toHaveLength(3);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  test("a pending task without an output path can't be probed and stays visible", async () => {
    // Hand-built task: launch confirmation without the output-path sentence.
    const jsonl = [
      line({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "x", run_in_background: true } },
          ],
        },
      }),
      line({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Command running in background with ID: bnopath." }],
        },
      }),
    ].join("\n");
    const live = await liveScripts(parseBackgroundTasks(jsonl), probeWhere(() => false));
    expect(live.map((t) => t.taskId)).toEqual(["bnopath"]);
  });
});

describe("pendingScripts", () => {

  test("keeps pending scripts only — agents and completed scripts excluded", () => {
    const jsonl = [
      ...bashLaunch("toolu_1", "bdone1"),
      line({ type: "user", message: { content: notif("bdone1", "toolu_1") } }),
      ...bashLaunch("toolu_2", "bwait2", "gh pr checks --watch"),
      line({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_3", name: "Agent", input: { description: "bg agent" } }] },
      }),
      line({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_3", content: "Async agent launched successfully. agentId: abc123abc123abc12" },
          ],
        },
      }),
    ].join("\n");
    const pending = pendingScripts(parseBackgroundTasks(jsonl));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.taskId).toBe("bwait2");
    expect(pending[0]!.label).toBe("gh pr checks --watch");
  });
});

// --- isServiceScript: real labels and commands from transcripts on disk ---

test("isServiceScript: servers and tunnels are services, by label", () => {
  for (const label of [
    "Run the ink dev server on port 3000",
    "Start Next.js dev server on :3000 (prod supabase)",
    "Open the SSM port-forward to the Libretto QA API",
    "Open the Maestro RDS tunnel in the background",
    "Open Maestro Postgres and ClickHouse tunnels",
    "Run local production server on :3002 (background)",
    "Start embedded Postgres 18 on port 5439",
    "Restart embedded Postgres for the test re-run",
  ]) expect(isServiceScript(label, "")).toBe(true);
});

test("isServiceScript: a port-binding, tunnel or dev-server command is a service whatever its label", () => {
  for (const command of [
    "CLAUDE0_BRIDGE_FIXTURES=1 CLAUDE0_BRIDGE_TOKEN=design-token CLAUDE0_BRIDGE_HOST=127.0.0.2 CLAUDE0_BRIDGE_PORT=8481 bun run bin/claude0.ts bridge",
    "cd apps/dashboard && bun run dev --port 3001",
    "aws ssm start-session --target i-0abc --document-name AWS-StartPortForwardingSession",
    "ssh -N -L 5432:db.internal:5432 bastion",
    "bunx vite --host",
    "bun run convex:dev",
    "ngrok http 3000",
    'S=/tmp/lab; CLAUDE0_BRIDGE_HOST=127.0.0.3 CLAUDE0_BRIDGE_PORT=8482 exec bun run bin/claude0.ts bridge > $S/labbridge.log 2>&1',
  ]) expect(isServiceScript("Restart fixtures bridge for the prototype", command)).toBe(true);
});

test("isServiceScript: a run routed through a server, an infra preview or a vite build is a wait", () => {
  // Real launches the classifier once filed as services, landing their session in Needs You.
  expect(isServiceScript("Play call 185845 through the real server at the call's own pace", "node run.mjs")).toBe(false);
  expect(isServiceScript("Replay one recorded call through the real server on its SAY NOW copy", "node run3.mjs")).toBe(false);
  expect(isServiceScript("Preview the prod stack read-only to confirm the new schedule", "pulumi preview --stack prod")).toBe(false);
  expect(isServiceScript("Run typecheck, the full test suite and the build", "npm run typecheck; npm test; npx vite build")).toBe(false);
  // …while a preview server on a port stays a service.
  expect(isServiceScript("Start the preview of main e7146a0 on port 8796", "node boot.mjs")).toBe(true);
});

test("isServiceScript: a client's port flag, an org named like a tool, or a hyphenated noun is not a service", () => {
  expect(isServiceScript(
    "Create tf738_parity DB and restore local schema",
    "createdb -h 127.0.0.1 -p 54322 -U postgres tf738_parity; pg_dump -s -n public \"$L/postgres\" > $S/schema.sql",
  )).toBe(false);
  expect(isServiceScript(
    "Push the Evos, Ngrok Core and Minitap lists with their wide country filters",
    "awk -F'\\t' '$1 ~ /^(evos-7ed6|ngrok-61ef|minitap-e3b4)$/' all_apollo_lists.tsv > three_lists.tsv",
  )).toBe(false);
  expect(isServiceScript("Verify server-ledger fix on device", 'bash "$S/diagnose-insession.sh" 2>&1')).toBe(false);
  expect(isServiceScript(
    "Run a marker command through the live route",
    "T=$(systemctl --user show -p EnvironmentFiles --value claude0-bridge | cut -d' ' -f1)",
  )).toBe(false);
});

test("isServiceScript: only a bare PORT= binds a port — a client's *_PORT= setting does not", () => {
  // A ClickHouse backfill whose client CLICKHOUSE_PORT= setting used to file it as a service.
  expect(isServiceScript(
    "c=$(aws secretsmanager get-secret-value --secret-id maestro/canary/clickhouse) && CLICKHOUSE_HOST=127.0.0.1 CLICKHOUSE_PORT=8124",
    "CLICKHOUSE_HOST=127.0.0.1 CLICKHOUSE_PORT=8124 MAESTRO_ENV=canary bun apps/aws/scripts/repair-dispositions.ts --out /tmp/all.jsonl > /tmp/dry.log 2>&1",
  )).toBe(false);
  expect(isServiceScript("Start the app", "PORT=3000 bun app.ts")).toBe(true);
  expect(isServiceScript("Start the app", "cd web && PORT=3000 bun app.ts")).toBe(true);
});

test("isServiceScript: waits stay waits, even when they name a service", () => {
  for (const label of [
    "Wait for CI to settle on new HEAD",
    "Background-wait for Codex review on HEAD",
    "Wait for the Trigger.dev preview deploy to finish",
    "Poll GitHub Actions status once after 8 min",
    "Watch detached reconcile driver pid 10527; exits when driver exits",
    "Monitor the deploy to prod",
    "sleep 99",
  ]) expect(isServiceScript(label, "")).toBe(false);
  expect(isServiceScript("Wait for the dev server to answer", "until curl -sf localhost:3000; do sleep 2; done")).toBe(false);
  expect(isServiceScript("Wait for CI to settle on new HEAD", "gh pr checks 42 --watch")).toBe(false);
});

test("a background launch carries the service flag from its label or command", () => {
  const tasks = parseBackgroundTasks([
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "PORT=8481 bun run bin/claude0.ts bridge", description: "Restart fixtures bridge", run_in_background: true } },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "gh pr checks 42 --watch", description: "Wait for CI", run_in_background: true } },
    ] } }),
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "t1", content: "Command running in background with ID: b1. Output is being written to: /tmp/b1.output." },
      { type: "tool_result", tool_use_id: "t2", content: "Command running in background with ID: b2. Output is being written to: /tmp/b2.output." },
    ] } }),
  ]);
  expect(tasks.map((t) => [t.taskId, t.service])).toEqual([["b1", true], ["b2", undefined]]);
});

describe("scanAgentScripts", () => {
  const PROJECTS = join(CONFIG_DIR, "agent-scan");
  const SESSION = join(PROJECTS, "repo", "sess.jsonl");
  const agentFile = (name: string, lines: string[], mtimeS: number, proj = "repo") => {
    const subs = join(PROJECTS, proj, "sess", "subagents");
    mkdirSync(subs, { recursive: true });
    writeFileSync(join(subs, name), lines.join("\n"));
    utimesSync(join(subs, name), mtimeS, mtimeS);
  };
  const ids = (scan: Awaited<ReturnType<typeof scanAgentScripts>>) =>
    scan?.pending.map((t) => `${t.src.replace("/sess/subagents/", ":")}:${t.taskId}`).sort();
  beforeEach(() => rmSync(PROJECTS, { recursive: true, force: true }));

  test("a session with no agent transcripts scans to undefined", async () => {
    expect(await scanAgentScripts(SESSION)).toBeUndefined();
  });

  test("collects each agent's pending scripts, skipping finished ones and non-agent files", async () => {
    agentFile("agent-a1.jsonl", bashLaunch("toolu_1", "bwait"), 1000);
    agentFile("agent-a2.jsonl", [...bashLaunch("toolu_2", "bdone"), line({ type: "user", message: { content: notif("bdone", "toolu_2") } })], 1000);
    agentFile("aside_question-x.jsonl", bashLaunch("toolu_3", "baside"), 1000);
    expect(ids(await scanAgentScripts(SESSION))).toEqual(["repo:agent-a1.jsonl:bwait"]);
  });

  test("an agent's workflow is left out: with no runner probe, a notice routed to the parent would leave it pending forever", async () => {
    agentFile("agent-a1.jsonl", [...bashLaunch("toolu_1", "bwait"), ...workflowLaunch("toolu_w", "wagent")], 1000);
    expect(ids(await scanAgentScripts(SESSION))).toEqual(["repo:agent-a1.jsonl:bwait"]);
  });

  test("unchanged files return the previous scan itself; only a modified file is re-parsed", async () => {
    agentFile("agent-a1.jsonl", bashLaunch("toolu_1", "bone"), 1000);
    agentFile("agent-a2.jsonl", bashLaunch("toolu_2", "btwo"), 1000);
    const first = await scanAgentScripts(SESSION);
    expect(await scanAgentScripts(SESSION, first)).toBe(first!);

    // a1 is rewritten WITHOUT its mtime moving past the scan: it must not be re-read.
    agentFile("agent-a1.jsonl", bashLaunch("toolu_1", "bstale"), 1000);
    agentFile("agent-a2.jsonl", bashLaunch("toolu_2", "bnew"), 2000);
    const second = await scanAgentScripts(SESSION, first);
    expect(ids(second)).toEqual(["repo:agent-a1.jsonl:bone", "repo:agent-a2.jsonl:bnew"]);
    expect(second!.newest).toBe(2_000_000);
  });

  test("finds agent transcripts under another project dir than the session's transcript", async () => {
    // A session that moved into a worktree: the agent's file lands under the worktree's
    // project dir, the transcript stays in the base repo's.
    agentFile("agent-a1.jsonl", bashLaunch("toolu_1", "bworktree"), 1000, "repo--worktrees-x");
    agentFile("agent-a2.jsonl", bashLaunch("toolu_2", "bother"), 1000, "repo");
    writeFileSync(join(PROJECTS, "repo", "other.jsonl"), ""); // another session's dir is not swept in
    mkdirSync(join(PROJECTS, "repo", "other", "subagents"), { recursive: true });
    writeFileSync(join(PROJECTS, "repo", "other", "subagents", "agent-a3.jsonl"), bashLaunch("toolu_3", "bforeign").join("\n"));
    expect(ids(await scanAgentScripts(SESSION))).toEqual(["repo--worktrees-x:agent-a1.jsonl:bworktree", "repo:agent-a2.jsonl:bother"]);
  });

  test("a deleted agent transcript takes its scripts with it", async () => {
    agentFile("agent-a1.jsonl", bashLaunch("toolu_1", "bone"), 1000);
    const first = await scanAgentScripts(SESSION);
    rmSync(join(PROJECTS, "repo", "sess", "subagents", "agent-a1.jsonl"));
    expect(ids(await scanAgentScripts(SESSION, first))).toEqual([]);
  });
});

// Shapes copied from a real Claude Code workflow launch and completion (2026-11-16).
function workflowLaunch(id: string, taskId: string | null, runDir = "/p/sess/subagents/workflows/wf_1") {
  const use = line({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Workflow", input: { scriptPath: "/p/sess/workflows/scripts/judge-wf_1.js" } }] },
  });
  const resultText = taskId
    ? `Workflow launched in background. Task ID: ${taskId}\nSummary: Three judges rate every call\nTranscript dir: ${runDir}\nScript file: /p/sess/workflows/scripts/judge-wf_1.js\nRun ID: wf_1\n\nYou will be notified when it completes. Use /workflows to watch live progress.`
    : "Permission for this action was denied by the auto mode classifier.";
  const result = line({
    type: "user",
    timestamp: "2026-11-16T20:41:37.603Z",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: resultText }] },
    ...(taskId && { toolUseResult: { status: "async_launched", taskId, taskType: "local_workflow", workflowName: "judge-vigil", runId: "wf_1", transcriptDir: runDir } }),
  });
  return [use, result];
}

describe("Workflow tasks", () => {
  test("a confirmed launch is a pending workflow named by its workflowName, carrying its run dir", () => {
    const [task] = parseBackgroundTasks(workflowLaunch("toolu_w", "wz3osit4v"));
    expect(task).toEqual({
      toolUseId: "toolu_w",
      kind: "workflow",
      label: "judge-vigil",
      status: "pending",
      taskId: "wz3osit4v",
      launchedAt: "2026-11-16T20:41:37.603Z",
      runDir: "/p/sess/subagents/workflows/wf_1",
    });
    expect(pendingScripts([task!])).toEqual([task!]);
  });

  test("a denied launch is no task", () => {
    expect(parseBackgroundTasks(workflowLaunch("toolu_w", null))).toEqual([]);
  });

  test("its notification completes it with the outcome from <usage>, dated by the first copy", () => {
    const usage = "<usage><agent_count>495</agent_count><agents_done>487</agents_done><agents_error>8</agents_error><agents_skipped>0</agents_skipped><duration_ms>5362144</duration_ms></usage>";
    const notice = notif("wdone", "toolu_w").replace("</task-notification>", `${usage}\n</task-notification>`);
    const [task] = parseBackgroundTasks([
      ...workflowLaunch("toolu_w", "wdone"),
      line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-11-16T22:10:59.811Z", content: notice }),
      line({ type: "user", timestamp: "2026-11-16T22:11:30.000Z", message: { content: notice } }),
    ]);
    expect(task).toMatchObject({
      status: "completed",
      endedAt: "2026-11-16T22:10:59.811Z",
      outcome: { done: 487, failed: 8, durationMs: 5362144 },
    });
  });

  test("a TaskStop kills it and dates its end", () => {
    const stop = taskStop("toolu_s", "wstop").map((l) => l.replace('"type":"user"', '"type":"user","timestamp":"2026-11-14T20:07:00.000Z"'));
    const [task] = parseBackgroundTasks([...workflowLaunch("toolu_w", "wstop"), ...stop]);
    expect(task).toMatchObject({ status: "killed", endedAt: "2026-11-14T20:07:00.000Z" });
    expect(task!.outcome).toBeUndefined();
  });

  test("endedWorkflows lists ended workflows newest first, never pending ones or scripts", () => {
    const tasks = parseBackgroundTasks([
      ...workflowLaunch("toolu_a", "wa"),
      line({ type: "user", timestamp: "2026-11-16T10:00:00Z", message: { content: notif("wa", "toolu_a") } }),
      ...workflowLaunch("toolu_b", "wb"),
      line({ type: "user", timestamp: "2026-11-16T12:00:00Z", message: { content: notif("wb", "toolu_b") } }),
      ...workflowLaunch("toolu_c", "wc"),
      ...bashLaunch("toolu_d", "bd"),
      line({ type: "user", message: { content: notif("bd", "toolu_d") } }),
    ]);
    expect(endedWorkflows(tasks).map((t) => t.taskId)).toEqual(["wb", "wa"]);
  });

  test("liveScripts keeps a pending workflow without probing (it has no output file)", async () => {
    const tasks = parseBackgroundTasks(workflowLaunch("toolu_w", "wlive"));
    const probe = async () => {
      throw new Error("probed");
    };
    expect((await liveScripts(tasks, probe)).map((t) => t.taskId)).toEqual(["wlive"]);
  });
});

describe("workflowProgress", () => {
  const RUN = join(CONFIG_DIR, "wf-run");
  const fresh = () => {
    rmSync(RUN, { recursive: true, force: true });
    mkdirSync(RUN, { recursive: true });
  };
  // One agent of the run: its meta (with the phase) and a transcript, done or still going.
  const agent = (id: string, phase: string | null, done: boolean, startedAt: number) => {
    writeFileSync(join(RUN, `agent-${id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", ...(phase && { workflowPhase: phase }) }));
    utimesSync(join(RUN, `agent-${id}.meta.json`), startedAt / 1000, startedAt / 1000);
    const records = [line({ type: "assistant", message: { content: [{ type: "tool_use", id: `so-${id}`, name: "StructuredOutput", input: {} }] } })];
    if (done) records.push(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `so-${id}`, content: "Structured output provided successfully" }] } }));
    writeFileSync(join(RUN, `agent-${id}.jsonl`), records.join("\n") + "\n");
  };

  test("counts finished agents, names the newest agent's phase, and dates the last finish", async () => {
    fresh();
    agent("a1", "Review", true, 1_000_000);
    agent("a2", "Review", false, 2_000_000);
    agent("a3", "Verify", false, 3_000_000);
    utimesSync(join(RUN, "agent-a1.jsonl"), 1_500, 1_500);
    expect(await workflowProgress(RUN)).toEqual({ phase: "Verify", done: 1, lastAt: 1_500_000 });
  });

  test("before any agent finishes lastAt is 0, and a phaseless run has no phase", async () => {
    fresh();
    agent("a1", null, false, 1_000_000);
    expect(await workflowProgress(RUN)).toEqual({ done: 0, lastAt: 0 });
  });

  test("a missing run dir is null, and withWorkflowProgress leaves that task bare", async () => {
    rmSync(RUN, { recursive: true, force: true });
    expect(await workflowProgress(RUN)).toBeNull();
    const tasks = parseBackgroundTasks(workflowLaunch("toolu_w", "wx", RUN));
    expect(await withWorkflowProgress(tasks)).toEqual(tasks);
  });

  test("withWorkflowProgress measures quiet from the launch until an agent finishes", async () => {
    fresh();
    agent("a1", "Judge", false, 1_000_000);
    const tasks = parseBackgroundTasks(workflowLaunch("toolu_w", "wx", RUN));
    const [withProgress] = await withWorkflowProgress(tasks);
    expect(withProgress!.progress).toEqual({ phase: "Judge", done: 0, lastAt: Date.parse(tasks[0]!.launchedAt!) });
    expect(tasks[0]!.progress).toBeUndefined(); // the cached task is not mutated
  });
});

describe("backgroundLead", () => {
  const script = (label: string, service?: true) => ({ toolUseId: label, kind: "script" as const, label, status: "pending" as const, ...(service && { service }) });

  test("a workflow leads, then a wait, then a service", async () => {
    const wf = { ...parseBackgroundTasks(workflowLaunch("toolu_w", "wlead", "/nonexistent/run"))[0]! };
    expect(await backgroundLead([script("dev server", true), script("Wait for CI"), wf])).toEqual({ kind: "workflow", label: "judge-vigil", launchedAt: "2026-11-16T20:41:37.603Z" });
    expect(await backgroundLead([script("dev server", true), script("Wait for CI")])).toEqual({ kind: "wait", label: "Wait for CI" });
    expect(await backgroundLead([script("dev server", true)])).toEqual({ kind: "service", label: "dev server" });
    const agent = (label: string) => ({ toolUseId: label, kind: "agent" as const, label, status: "pending" as const });
    expect(await backgroundLead([script("Wait for CI"), agent("Review auth")])).toMatchObject({ kind: "wait" });
    expect(await backgroundLead([script("dev server", true), agent("Review auth"), agent("Trace cookies")])).toEqual({ kind: "agents", label: "Trace cookies", count: 2 });
    expect(await backgroundLead([])).toBeUndefined();
  });
  test("a stalled workflow leads over a newer healthy one", async () => {
    const run = join(CONFIG_DIR, "wf-lead-stalled");
    rmSync(run, { recursive: true, force: true });
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "agent-a1.meta.json"), "{}");
    writeFileSync(join(run, "agent-a1.jsonl"), line({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }) + "\n");
    const hourAgo = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(join(run, "agent-a1.jsonl"), hourAgo, hourAgo);
    const stalled = { ...parseBackgroundTasks(workflowLaunch("toolu_s", "wstall", run))[0]!, label: "stalled-run" };
    const healthy = { ...parseBackgroundTasks(workflowLaunch("toolu_h", "whealthy", "/nonexistent/run"))[0]!, label: "healthy-run" };
    expect(await backgroundLead([stalled, healthy])).toMatchObject({ kind: "workflow", label: "stalled-run", progress: { done: 1 } });
  });
});

describe("screenTotal", () => {
  // Claude Code's footer row for a running workflow, in its widest layout.
  const footer = (name: string, done: number, total: number) => `  ◯ ${name}  \x1b[32m▰▰▰▰▱▱▱▱\x1b[0m  ${done}/${total} · 12m03s · ↓ 1.2M tokens`;
  const screen = (...rows: string[]) => ["❯ ", "────────", ...rows, ""].join("\n");

  test("reads the total off the named workflow's row", () => {
    expect(screenTotal(screen(footer("judge-vigil", 91, 165)), "judge-vigil", 91)).toBe(165);
    expect(screenTotal(screen(footer("review-auth", 3, 12), footer("judge-vigil", 91, 165)), "review-auth", 3)).toBe(12);
  });

  test("a truncated name matches by prefix", () => {
    expect(screenTotal(screen(footer("judge-vi…", 91, 165)), "judge-vigil", 91)).toBe(165);
  });

  test("gives up quietly: no row, no N/M, two rows for one name, or a total below done", () => {
    expect(screenTotal(screen(), "judge-vigil", 91)).toBeUndefined();
    expect(screenTotal(screen("  ◯ judge-vigil  ▰▰▰▱  12m03s · ↓ 1.2M tokens"), "judge-vigil", 91)).toBeUndefined();
    expect(screenTotal(screen(footer("judge-vigil", 91, 165), footer("judge-vigil", 4, 165)), "judge-vigil", 91)).toBeUndefined();
    expect(screenTotal(screen(footer("judge-vigil", 91, 165)), "judge-vigil", 200)).toBeUndefined();
    expect(screenTotal(screen(footer("other-run", 91, 165)), "judge-vigil", 91)).toBeUndefined();
  });

  test("withScreenTotals attaches it to running workflows only, as copies", () => {
    const wf = { ...parseBackgroundTasks(workflowLaunch("toolu_w", "wst"))[0]!, label: "judge-vigil", progress: { done: 91, lastAt: 1 } };
    const [withTotal] = withScreenTotals([wf], screen(footer("judge-vigil", 91, 165)));
    expect(withTotal!.progress).toEqual({ done: 91, lastAt: 1, total: 165 });
    expect(wf.progress).toEqual({ done: 91, lastAt: 1 });
    expect(withScreenTotals([wf], "")[0]).toBe(wf);
  });
});
