/**
 * Background tasks a session launched and may still be waiting on — recovered
 * purely from the session's transcript JSONL by pairing task launches against
 * `<task-notification>` records. This is what lets the phone show "waiting on
 * script" for a session that reads `ready` (the turn genuinely ends while a
 * `run_in_background` command runs; skills like pr-triage wait this way for
 * tens of minutes).
 *
 * Detection rules (each validated against the full transcript history on disk):
 * - A candidate is a `tool_use` that runs in the background: Bash with
 *   `run_in_background: true`, any `Workflow` call, or any `Agent` call
 *   (background is the Agent tool's default and the key is often absent).
 * - The paired `tool_result` must CONFIRM a task was created — "Command running
 *   in background with ID: <id>" for Bash, "Async agent launched successfully…
 *   agentId: <id>" for Agent. Without it no notification will ever come: an
 *   Agent result without the confirmation ran synchronously (the result is its
 *   final report), and a Bash launch without it was denied or failed to start.
 *   Gating on the result of a known background tool_use also means a foreground
 *   command that merely PRINTS launch-shaped text can't false-positive.
 * - A foreground command that outlives its timeout is moved to the background by
 *   the harness: a Bash tool_result that OPENS with "Command did not complete
 *   within its Ns timeout and was moved to the background (ID: <id>)", or a user
 *   `!` command's `<bash-stdout>` with that notice at the start of a line — the
 *   stdout keeps whatever the command printed before the timeout. Anchored,
 *   because output quoting the notice (grepping transcripts) contains it mid-line.
 * - The completion arrives as a `<task-notification>` payload in one of three
 *   carriers: a `user` message (session was idle), or a `queue-operation` /
 *   queued_command `attachment` record (session was mid-turn). Paired by
 *   task-id or tool-use-id; unmatched notifications (nested-agent completions
 *   routed to the parent, launches on the far side of a /clear split) are ignored.
 * - A `Monitor` call is a script, confirmed by "Monitor started (task <id>". It
 *   streams one notification per event, so only a notification carrying a
 *   `<status>` (its stream ended, or it was stopped) or an `[Monitor expired`
 *   event ends it. It has no output file to probe while it runs, so its liveness
 *   is its own `timeoutMs` deadline (≤30m) instead of the runner probe.
 * - A successful `TaskStop` result (`{"message":"Successfully stopped task: <id>`)
 *   kills that task: a stopped Monitor gets no notification at all. Only a result
 *   paired with a `TaskStop` tool_use counts, so printed output of that shape can't.
 * - A script launched by one of the session's agents (a fork, a teammate, a subagent)
 *   is recorded in that agent's own transcript, never in the session's: see
 *   `scanAgentScripts`.
 */

import { resolveVerdicts, runnersAlive, type RunnerProbe } from "./runner-verdicts";
import { jsonlLines } from "./jsonl-reader";

export type BackgroundTaskKind = "script" | "agent" | "workflow";
export type BackgroundTaskStatus = "pending" | "completed" | "killed";

export interface BackgroundTask {
  /** Harness task id (`b7cxqdaxr` for Bash, hex agentId for Agent); Workflow launches may lack one. */
  taskId?: string;
  /** The launching tool_use — or the task id for a user `!` command, which has none. */
  toolUseId: string;
  kind: BackgroundTaskKind;
  /** Bash command / Agent description, capped for display. */
  label: string;
  status: BackgroundTaskStatus;
  launchedAt?: string;
  /** The task's output file (from the Bash launch confirmation) — the liveness probe target. */
  outputPath?: string;
  /** A script that keeps running (a server, a tunnel) rather than one Claude waits on — `isServiceScript`. */
  service?: true;
  /** A Monitor's expiry (epoch ms): it is live only before this, and is never runner-probed. */
  deadline?: number;
}

const LABEL_CAP = 160;
const BASH_LAUNCH_RE = /Command running in background with ID: (\S+?)\./;
const OUTPUT_PATH_RE = /Output is being written to: (\S+)/;
const TIMEOUT_NOTICE = String.raw`Command did not complete within its \d+s timeout and was moved to the background \(ID: (\w+)\)`;
const TIMEOUT_LAUNCH_RE = new RegExp(`^${TIMEOUT_NOTICE}`);
const BANG_TIMEOUT_LAUNCH_RE = new RegExp(`(?:^<bash-stdout>|\n)${TIMEOUT_NOTICE}`);
const BASH_INPUT_RE = /<bash-input>([\s\S]*?)<\/bash-input>/;
const AGENT_LAUNCH_RE = /Async agent launched successfully[\s\S]*?agentId: (\w+)/;
const NOTIF_TASK_ID_RE = /<task-id>(\S+?)<\/task-id>/;
const NOTIF_TOOL_USE_RE = /<tool-use-id>(\S+?)<\/tool-use-id>/;
const NOTIF_STATUS_RE = /<status>(\w+)<\/status>/;
const MONITOR_LAUNCH_RE = /^Monitor started \(task (\w+)/;
const MONITOR_EXPIRED = "[Monitor expired";
/** Claude Code's cap on a Monitor's `timeoutMs`, used when the launch record omits it. */
const MONITOR_MAX_MS = 30 * 60 * 1000;
const TASK_STOP_RE = /^\{"message":"Successfully stopped task: (\w+)/;

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text ?? "") : ""))
    .join("\n");
}

/** Parse one transcript's background tasks, launch-order preserved. Never throws. */
export function parseBackgroundTasks(jsonl: string | string[]): BackgroundTask[] {
  const parser = taskLineParser();
  for (const line of typeof jsonl === "string" ? jsonl.split("\n") : jsonl) parser.feed(line);
  return parser.tasks();
}

/**
 * Same parse fed straight from disk via the streaming line reader, so a multi-MB
 * live transcript never materializes as one contiguous string (macOS malloc keeps
 * large freed blocks, so repeated full-file reads ratchet a long-lived process's
 * RSS permanently). Throws on a missing/unreadable file — exactly like the
 * `file.text()` it replaces — so callers' catch paths return their empty defaults
 * WITHOUT caching a partial parse as if it were complete.
 */
export async function parseBackgroundTasksFile(path: string): Promise<BackgroundTask[]> {
  const parser = taskLineParser();
  for await (const line of jsonlLines(path)) parser.feed(line);
  return parser.tasks();
}

/** The line-by-line parsing core shared by the string and streaming entry points. */
function taskLineParser(): { feed: (line: string) => void; tasks: () => BackgroundTask[] } {
  const byToolUse = new Map<string, BackgroundTask>();
  const byTaskId = new Map<string, BackgroundTask>();
  // Background tool_uses awaiting their tool_result, so the launch can be confirmed
  // and labelled. Also drives the line prefilter (a result line carries its use's id).
  const candidates = new Map<string, { name: string; label: string; command: string }>();
  // Foreground Bash calls, in case one times out into the background.
  const foregroundBash = new Map<string, { label: string; command: string }>();
  // TaskStop calls, so only their own results can kill a task.
  const stops = new Set<string>();
  // A `!` command's input and output are separate records; the output carries no command.
  let lastBashInput = "";

  const launch = (toolUseId: string, kind: BackgroundTaskKind, label: string, command: string, taskId: string | undefined, text: string, ts: string | undefined): BackgroundTask => {
    const task: BackgroundTask = { toolUseId, kind, label, status: "pending" };
    if (kind === "script" && isServiceScript(label, command)) task.service = true;
    if (taskId) {
      task.taskId = taskId;
      byTaskId.set(taskId, task);
    }
    // Strip the sentence's trailing period — the path itself ends in ".output".
    const outputPath = text.match(OUTPUT_PATH_RE)?.[1]?.replace(/\.$/, "");
    if (outputPath) task.outputPath = outputPath;
    if (ts) task.launchedAt = ts;
    byToolUse.set(toolUseId, task);
    return task;
  };

  const feed = (line: string): void => {
    // Cheap prefilter — a launch's tool_result may not contain any fixed marker
    // text, so lines carrying a known candidate tool_use id also pass.
    if (
      !line.includes("run_in_background") &&
      !line.includes("task-notification") &&
      !line.includes('"name":"Workflow"') &&
      !line.includes('"name":"Agent"') &&
      !line.includes('"name":"Monitor"') &&
      !line.includes('"name":"TaskStop"') &&
      !line.includes("Successfully stopped task") &&
      !line.includes('"name":"Bash"') &&
      !line.includes("<bash-input>") &&
      !line.includes("moved to the background")
    ) {
      let carries = false;
      for (const id of candidates.keys()) {
        if (line.includes(id)) {
          carries = true;
          break;
        }
      }
      if (!carries) return;
    }
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // torn/partial line
    }
    // Claude Code's copy of an API request: it replays already-logged messages, untimestamped.
    if (rec["type"] === "api-request-blob") return;
    const content = (rec["message"] as { content?: unknown } | undefined)?.content;
    const ts = typeof rec["timestamp"] === "string" ? (rec["timestamp"] as string) : undefined;

    if (Array.isArray(content)) {
      for (const block of content as Record<string, unknown>[]) {
        if (block["type"] === "tool_use") {
          const name = String(block["name"] ?? "");
          const input = (block["input"] ?? {}) as Record<string, unknown>;
          const isCandidate =
            input["run_in_background"] === true ||
            name === "Workflow" ||
            name === "Monitor" ||
            (name === "Agent" && input["run_in_background"] !== false);
          if (!isCandidate) {
            if (name === "TaskStop") stops.add(String(block["id"]));
            if (name === "Bash") {
              foregroundBash.set(String(block["id"]), {
                label: String(input["description"] ?? input["command"] ?? name).slice(0, LABEL_CAP),
                command: String(input["command"] ?? ""),
              });
            }
            continue;
          }
          // Description first: it's the model's own human label ("Background wait for
          // Codex review"), far more readable on a phone than the shell loop it runs.
          candidates.set(String(block["id"]), {
            name,
            label: String(input["description"] ?? input["command"] ?? name).slice(0, LABEL_CAP),
            command: String(input["command"] ?? ""),
          });
        } else if (block["type"] === "tool_result") {
          const toolUseId = String(block["tool_use_id"] ?? "");
          const text = blockText(block["content"]);
          const use = candidates.get(toolUseId);
          if (!use) {
            const fg = foregroundBash.get(toolUseId);
            const timedOut = text.match(TIMEOUT_LAUNCH_RE);
            if (fg && timedOut) launch(toolUseId, "script", fg.label, fg.command, timedOut[1], text, ts);
            const stopped = stops.has(toolUseId) ? byTaskId.get(text.match(TASK_STOP_RE)?.[1] ?? "") : undefined;
            if (stopped) stopped.status = "killed";
            continue;
          }
          candidates.delete(toolUseId);
          if (use.name === "Monitor") {
            const started = text.match(MONITOR_LAUNCH_RE);
            if (!started) continue; // denied / failed to start
            const timeoutMs = (rec["toolUseResult"] as { timeoutMs?: unknown } | undefined)?.timeoutMs;
            const task = launch(toolUseId, "script", use.label, use.command, started[1], text, ts);
            task.deadline = (ts ? Date.parse(ts) : 0) + (typeof timeoutMs === "number" ? timeoutMs : MONITOR_MAX_MS);
            continue;
          }
          const bash = text.match(BASH_LAUNCH_RE);
          const agent = text.match(AGENT_LAUNCH_RE);
          if (use.name === "Bash" && !bash) continue; // denied / failed to start
          if (use.name === "Agent" && !agent) continue; // ran synchronously
          const kind = use.name === "Bash" ? "script" : use.name === "Agent" ? "agent" : "workflow";
          launch(toolUseId, kind, use.label, use.command, bash?.[1] ?? agent?.[1], text, ts);
        }
      }
    }

    if (typeof content === "string") {
      const input = content.match(BASH_INPUT_RE)?.[1];
      if (input !== undefined) lastBashInput = input.trim();
      const taskId = content.match(BANG_TIMEOUT_LAUNCH_RE)?.[1];
      if (taskId) launch(taskId, "script", lastBashInput.slice(0, LABEL_CAP), lastBashInput, taskId, content, ts);
    }

    const attachment = rec["attachment"] as { prompt?: unknown } | undefined;
    const notifText =
      blockText(content) +
      (typeof rec["content"] === "string" ? (rec["content"] as string) : "") +
      (typeof attachment?.prompt === "string" ? attachment.prompt : "");
    if (notifText.includes("<task-notification>")) {
      const taskId = notifText.match(NOTIF_TASK_ID_RE)?.[1];
      const toolUseId = notifText.match(NOTIF_TOOL_USE_RE)?.[1];
      const task = (taskId && byTaskId.get(taskId)) || (toolUseId && byToolUse.get(toolUseId)) || undefined;
      const status = notifText.match(NOTIF_STATUS_RE)?.[1];
      // A Monitor's per-event notifications carry no <status>; only its end does.
      const ends = task?.deadline === undefined || status !== undefined || notifText.includes(MONITOR_EXPIRED);
      if (task && ends) task.status = status === "killed" ? "killed" : "completed";
    }
  };

  return { feed, tasks: () => [...byToolUse.values()] };
}

/**
 * The scripts a session is waiting on per the TRANSCRIPT — launched, no notification
 * yet. Agents/workflows are excluded: running subagents are already surfaced from the
 * `subagents/` directory, and a workflow's child agents appear there too. Callers that
 * render should use `liveScripts` — the transcript can lie (an orphaned task's
 * notification never arrives); the runner-liveness probe is what makes it honest.
 */
export function pendingScripts(tasks: BackgroundTask[]): BackgroundTask[] {
  return tasks.filter((t) => t.kind === "script" && t.status === "pending");
}

// A script Claude launched to keep running (a dev server, a tunnel) rather than to wait
// on. The label (the model-written description) names it, or the command binds a port,
// opens a tunnel or runs a dev server. A label that opens with a wait verb is a wait
// even when it names a service ("Wait for the preview deploy").
const SERVICE_NOUN = /\b(dev server|server(?!-)|serve|tunnels?|port[- ]forward|ssm|vite|next dev|localhost|proxy|preview|embedded postgres)\b|\bon port \d+/i;
const SERVICE_COMMAND = /(?<![A-Z0-9_])PORT=\d+|--port[ =]\d+|\bssm start-session\b|-L \d+:|\b(vite|next dev|serve)\b|\bngrok (http|tcp|tls|start)\b|\brun dev\b|\bconvex[: ]dev\b|(?:^|\s)bridge\s*(?:$|[;&|>])/;
const WAIT_VERB = /^\s*(background[- ])?(wait|poll|watch|monitor)\b/i;

/**
 * Whether a background script is a long-lived service rather than a wait. Only inbox
 * placement uses it: a wait holds its session in Running, a service doesn't.
 */
export function isServiceScript(label: string, command: string): boolean {
  if (WAIT_VERB.test(label)) return false;
  return SERVICE_NOUN.test(label) || SERVICE_COMMAND.test(command);
}

/** The verdict-store key for a task: the harness task id, or the tool use it came from. */
export function taskKey(task: BackgroundTask): string {
  return task.taskId ?? task.toolUseId;
}

/**
 * `pendingScripts` filtered to tasks whose runner is actually alive — what every
 * rendering surface uses (the rule is `taskLive`). Note the flip side of trusting
 * the probe: an intentionally-infinite background daemon shows for as long as it
 * truly runs — a true statement.
 *
 * Verdicts come from the shared persisted store, so a task already known to be dead
 * costs no probe here no matter which process asks (see `runner-verdicts.ts`).
 */
export async function liveScripts(
  tasks: BackgroundTask[],
  probe: RunnerProbe = runnersAlive,
): Promise<BackgroundTask[]> {
  const pending = pendingScripts(tasks);
  const now = Date.now();
  const verdicts = await resolveVerdicts(
    pending.filter((t) => t.outputPath).map((t) => ({ key: taskKey(t), outputPath: t.outputPath! })),
    now,
    probe,
  );
  return pending.filter((t) => taskLive(t, verdicts.get(taskKey(t)), now));
}

/**
 * The one liveness rule for a pending task, shared by `liveScripts` and `liveTasks`
 * (`core/script-wait.ts`) so the phone and the ⏳/inbox placement can't disagree: a
 * Monitor is live until its deadline; any other task by its runner verdict, and one
 * without an outputPath can't be probed and counts as live.
 */
export function taskLive(task: { deadline?: number; outputPath?: string }, verdict: boolean | undefined, now: number): boolean {
  if (task.deadline !== undefined) return now < task.deadline;
  return !task.outputPath || verdict === true;
}

/** A pending script one of the session's agents launched; `src` is the agent transcript, relative to the projects dir. */
export type AgentScript = BackgroundTask & { src: string };

/** A session's agent-launched pending scripts, current up to the `newest` agent-transcript mtime. */
export interface AgentScripts {
  newest: number;
  pending: AgentScript[];
}

/**
 * The pending scripts a session's agents launched, read from the agents' own transcripts
 * (`<proj>/<sessionId>/subagents/agent-*.jsonl`: forks, teammates and subagents all write
 * there). The session's own transcript never records these launches, so without this a
 * session whose fork stopped to wait on its own script reads as having no background
 * work at all.
 *
 * Every project dir is searched, not just the transcript's: an agent's file lands under
 * the project dir of the session's cwd at launch, and a session that moved into a
 * worktree keeps its transcript in the base repo's dir.
 *
 * "Pending" here is weaker than in the session's transcript: once the agent has stopped,
 * the harness delivers the script's completion notice to the PARENT, so the agent's file
 * says pending forever. Only the runner probe (`taskLive`) makes these honest — every
 * script carries an output path or a Monitor deadline, so each one resolves. A Monitor
 * whose end notice went to the parent shows until its deadline (≤30m).
 *
 * Incremental against `prev`: only files modified after `prev.newest` are re-parsed, the
 * rest keep their tasks, so a steady-state call costs one stat per agent file (<2ms for
 * 91 files). Returns `prev` itself when nothing changed, and undefined when the session
 * has no agent transcripts.
 */
export async function scanAgentScripts(transcriptPath: string, prev?: AgentScripts): Promise<AgentScripts | undefined> {
  const [, dir, sessionId] = transcriptPath.match(/^(.*)\/[^/]+\/([A-Za-z0-9-]+)\.jsonl$/) ?? [];
  if (!dir || !sessionId) return prev;
  const files: { name: string; mtimeMs: number }[] = [];
  try {
    const names = await Array.fromAsync(new Bun.Glob(`*/${sessionId}/subagents/agent-*.jsonl`).scan({ cwd: dir }));
    await Promise.all(
      names.map(async (name) => {
        try {
          files.push({ name, mtimeMs: (await Bun.file(`${dir}/${name}`).stat()).mtimeMs });
        } catch {
          // vanished between the scan and the stat
        }
      }),
    );
  } catch {
    // unreadable projects dir — no agent transcripts
  }
  const present = new Set(files.map((f) => f.name));
  const changed = files.filter((f) => f.mtimeMs > (prev?.newest ?? -1));
  if (prev ? changed.length === 0 && prev.pending.every((t) => present.has(t.src)) : files.length === 0) return prev;
  const reparsed = new Set(changed.map((f) => f.name));
  const pending = (prev?.pending ?? []).filter((t) => present.has(t.src) && !reparsed.has(t.src));
  for (const { name } of changed) {
    try {
      for (const t of pendingScripts(await parseBackgroundTasksFile(`${dir}/${name}`))) pending.push({ ...t, src: name });
    } catch {
      // unreadable agent transcript — no tasks from it
    }
  }
  return { newest: Math.max(prev?.newest ?? -1, ...files.map((f) => f.mtimeMs)), pending };
}

// `scanAgentScripts` state for a long-lived caller (the bridge), per session transcript.
const agentCache = new Map<string, AgentScripts>();

/** A transcript's agent-launched pending scripts, incrementally cached in this process. */
export async function agentScriptsAt(transcriptPath: string): Promise<AgentScript[]> {
  const scan = await scanAgentScripts(transcriptPath, agentCache.get(transcriptPath));
  if (scan) agentCache.set(transcriptPath, scan);
  return scan?.pending ?? [];
}

// Per-transcript cache keyed by (size, mtime) — launch and notification are both
// transcript records, so an unchanged file means an unchanged answer. Shared by the
// detail view and the sessions-list badge, so a change costs one scan total. Caches the
// RAW tasks, not the filtered view: the liveness probe must run per read — a runner
// can die while the file (and thus this cache entry) sits still.
const pathCache = new Map<string, { size: number; mtimeMs: number; tasks: BackgroundTask[] }>();

/**
 * Cached live pending scripts for a transcript file and the agents it launched
 * (runner-probed). [] on unreadable.
 */
export async function pendingScriptsAt(path: string): Promise<BackgroundTask[]> {
  try {
    const file = Bun.file(path);
    const stat = await file.stat();
    if (!stat) return [];
    let hit = pathCache.get(path);
    if (!hit || hit.size !== stat.size || hit.mtimeMs !== stat.mtimeMs) {
      hit = { size: stat.size, mtimeMs: stat.mtimeMs, tasks: await parseBackgroundTasksFile(path) };
      pathCache.set(path, hit);
    }
    return liveScripts([...hit.tasks, ...(await agentScriptsAt(path))]);
  } catch {
    return [];
  }
}
