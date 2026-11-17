/**
 * Whether an agent (a subagent, a fork, a teammate or a workflow's agent) has finished,
 * read from the end of its own transcript. Shared by the session's agent list
 * (`listSubagents`) and a workflow's progress (`workflowProgress`).
 */

interface TailRecord {
  type?: string;
  isApiErrorMessage?: boolean;
  message?: { content?: unknown };
}

const TAIL_START = 65536; // 64KB initial window
const TAIL_CAP = 4 * 1024 * 1024; // 4MB ceiling — final records reach ~99KB; this is slack

/**
 * Backward chunked tail-read of a JSONL file: parse the complete records at its END
 * without reading the whole thing. Starts at the last 64KB and doubles the window (up
 * to 4MB) until ≥1 complete record is recovered — a subagent's final record can reach
 * ~99KB, so a fixed window would truncate it and misclassify a done agent as running.
 * When we didn't read from byte 0 the first line is a partial record (dropped); a
 * half-written trailing line is skipped by the per-line try/parse. Returns [] on a
 * missing/unreadable file or when the final record exceeds the 4MB cap.
 */
async function tailRecords(path: string): Promise<TailRecord[]> {
  try {
    const file = Bun.file(path);
    const size = file.size;
    if (!size) return [];
    for (let window = TAIL_START; ; window *= 2) {
      const start = Math.max(0, size - window);
      const text = await file.slice(start, size).text();
      const lines = text.split("\n");
      if (start > 0) lines.shift(); // first line is a partial record — drop it
      const records: TailRecord[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line) as TailRecord);
        } catch {
          // torn trailing fragment (file mid-write) — skip
        }
      }
      if (records.length > 0 || start === 0 || window >= TAIL_CAP) return records;
    }
  } catch {
    return []; // missing/unreadable
  }
}

// A done agent's jsonl is terminal/immutable, so its (size, mtime) never changes again —
// cache that verdict to bound re-reads to still-running agents. `running` is never cached
// (the file is still growing).
const subagentDoneCache = new Map<string, { size: number; mtimeMs: number; status: "done" | "stopped" }>();

/**
 * An agent's status from its OWN jsonl — `done` iff the last conversational record is an
 * `assistant` turn whose last content block is `text` or the agent ended through a tool
 * (see `endedByTool`); `stopped` when the user (or a workflow's stall retry) interrupted
 * it or it died on an API error, leaving no report; else `running`. The text rule was
 * validated against ≈680 agents (0 false positives): this rescues the 22% of done agents
 * whose `stop_reason` is `null`, while a running tail is always a `thinking`-only
 * assistant turn or a `tool_result` user record (a tool-calling turn ends in `tool_use`,
 * never `[…text]`). An agent killed with its parent's process writes no terminal record:
 * the phone reads that from the session's status, not from here.
 */
export async function subagentStatus(jsonlPath: string): Promise<"done" | "running" | "stopped"> {
  let stat: { size: number; mtimeMs: number } | null;
  try {
    stat = await Bun.file(jsonlPath).stat();
  } catch {
    return "running"; // missing/unreadable → not yet terminal
  }
  if (!stat) return "running";
  const cached = subagentDoneCache.get(jsonlPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.status;

  const records = await tailRecords(jsonlPath);
  const convo = records.filter((r) => r.type === "user" || r.type === "assistant");
  const last = convo[convo.length - 1];
  const lastBlocks = tailBlocks(last);
  const endsInText = last?.type === "assistant" && lastBlocks[lastBlocks.length - 1]?.type === "text";
  // An API error is written as an assistant text turn, but the agent left no report.
  const failed = last?.type === "assistant" && last.isApiErrorMessage === true;
  const status = failed || interrupted(last) ? "stopped" : endsInText || endedByTool(convo) ? "done" : "running";
  if (status !== "running") subagentDoneCache.set(jsonlPath, { size: stat.size, mtimeMs: stat.mtimeMs, status });
  return status;
}

type TailBlock = { type?: string; id?: string; name?: string; text?: string; tool_use_id?: string; is_error?: boolean };

function tailBlocks(r: TailRecord | undefined): TailBlock[] {
  const content = r?.message?.content;
  return Array.isArray(content) ? (content as TailBlock[]) : [];
}

// Tools whose successful result ends an agent: current Claude Code ends a subagent with
// `SubagentHandback` (the report is its `message`), and a workflow agent asked for a
// schema with `StructuredOutput`.
const TERMINAL_TOOLS = new Set(["SubagentHandback", "StructuredOutput"]);

/**
 * Whether the transcript ends on a terminal tool's successful result. Parallel calls in
 * one turn are written as consecutive assistant records followed by their results, so
 * the whole trailing run is read, not just the last pair. A later prompt (a resumed
 * agent) or a failed call leaves it running.
 */
function endedByTool(convo: TailRecord[]): boolean {
  let i = convo.length - 1;
  const results: TailBlock[] = [];
  for (; i >= 0 && convo[i]!.type === "user"; i--) {
    const blocks = tailBlocks(convo[i]);
    if (blocks.length === 0 || blocks.some((b) => b.type !== "tool_result")) return false;
    results.push(...blocks);
  }
  const calls: TailBlock[] = [];
  for (; i >= 0 && convo[i]!.type === "assistant"; i--) calls.push(...tailBlocks(convo[i]).filter((b) => b.type === "tool_use"));
  return calls.some(
    (c) => TERMINAL_TOOLS.has(c.name ?? "") && results.some((r) => r.tool_use_id === c.id && !r.is_error),
  );
}

/** The user stopped the agent: its last record is the harness's "[Request interrupted by user" line. */
function interrupted(last: TailRecord | undefined): boolean {
  if (last?.type !== "user") return false;
  const content = last.message?.content;
  const text = typeof content === "string" ? content : tailBlocks(last).find((b) => b.type === "text")?.text;
  return typeof text === "string" && text.startsWith("[Request interrupted by user");
}
