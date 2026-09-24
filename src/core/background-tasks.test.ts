// Home helper FIRST so CLAUDE0_HOME is set before config.ts freezes PATHS.dir —
// `liveScripts` now resolves verdicts through the persisted store, which must
// land in the throwaway temp home rather than the real ~/.config/claude0.
import "../../test/helpers/home";
import { CONFIG_DIR } from "../../test/helpers/home";
import { describe, expect, test, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { parseBackgroundTasks, pendingScripts, liveScripts } from "./background-tasks";

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
