/**
 * Coverage for the Impl 2.5 handoff surface (`session-api.ts`).
 *
 * Hermetic, repo style: pure fns asserted directly + temp-HOME real-fs (no
 * `mock.module`). `../../test/helpers/home` MUST stay the first import — it redirects
 * CLAUDE0_HOME before `config`/`hook-events` freeze `PATHS.dir`/`EVENTS_DIR`.
 *
 * Scope note: the transcript ASSEMBLY is tested via the pure `buildSessionTranscript`
 * (the I/O path resolution uses `homedir()`, which tests can't redirect — matching how
 * `sessions.ts`'s homedir glob is left untested). The senders are thin effectful
 * wrappers over tmux; per repo convention (cf. `tmux.test.ts` covering only the pure
 * `questionAnswerKeys`, not `answerQuestion`) their gate logic is covered by the pure
 * predicate/resolver tests plus the hermetic no-pane short-circuit. The status/question
 * happy paths past a live pane are the plan's manual live checks.
 */

import "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  pickPane,
  paneFromCommandLine,
  hasOpenQuestion,
  buildSessionTranscript,
  pendingToolFields,
  transcriptRevAt,
  slimTurns,
  composeMessageSteps,
  buildSendPlan,
  inputPending,
  flattenStyled,
  shellModeInput,
  parseQueuedPending,
  getTranscript,
  sendMessage,
  answerSessionQuestion,
  clarifySessionQuestion,
  interruptSession,
  clearPaneInput,
  readContextUsage,
  pickerCursorText,
  cursorMatches,
  parseModeMenu,
  modeDowns,
  parseStatusline,
  extractConfirmation,
  isModelArg,
  isEffortArg,
  MODEL_ARGS,
  EFFORT_ARGS,
  restoreSession,
} from "./session-api";
import { parseTranscript } from "./transcript";
import { EVENTS_DIR } from "./hook-events";
import { PENDING_DIR, DECISIONS_DIR } from "./approval";
import { deadPid } from "../../test/helpers/dead-pid";
import { PATHS } from "./config";
import { fixture } from "../../test/helpers/fixture";
import type { PendingToolCall } from "./jsonl-reader";

beforeEach(() => {
  rmSync(EVENTS_DIR, { recursive: true, force: true });
  mkdirSync(EVENTS_DIR, { recursive: true });
  mkdirSync(PATHS.dir, { recursive: true });
  rmSync(join(PATHS.dir, "panes"), { recursive: true, force: true });
  rmSync(PENDING_DIR, { recursive: true, force: true });
  rmSync(DECISIONS_DIR, { recursive: true, force: true });
});

/** Seed the event log so `pendingToolCall(id)` surfaces an open AskUserQuestion. */
function seedQuestionEvent(id: string, toolUseId: string): void {
  writeFileSync(
    join(EVENTS_DIR, `${id}.jsonl`),
    JSON.stringify({
      session_id: id,
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: toolUseId,
      tool_input: {
        questions: [
          { question: "Pick", header: "H", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
        ],
      },
    }) + "\n",
  );
}

// --- pickPane (the resolver) ---------------------------------------------------

test("pickPane: returns the live pane mapped to the session", () => {
  expect(pickPane("s1", { "%1": "s1", "%2": "s2" }, new Set(["%1", "%2"]))).toBe("%1");
});

test("pickPane: session absent from the map → null", () => {
  expect(pickPane("nope", { "%1": "s1" }, new Set(["%1"]))).toBeNull();
});

test("pickPane: mapped pane is stale/not-live → null", () => {
  expect(pickPane("s1", { "%9": "s1" }, new Set(["%1"]))).toBeNull();
});

test("pickPane: picks the right session's pane among several", () => {
  const map = { "%1": "s1", "%2": "s2", "%3": "s3" };
  expect(pickPane("s2", map, new Set(["%1", "%2", "%3"]))).toBe("%2");
});

test("pickPane: two live panes for one session → last-written wins", () => {
  expect(pickPane("s1", { "%1": "s1", "%2": "s1" }, new Set(["%1", "%2"]))).toBe("%2");
});

// --- paneFromCommandLine (the guarded --resume fallback) -----------------------

test("paneFromCommandLine: matches a --resume process by id, maps its TTY to a pane", () => {
  const procs = [{ sessionId: "s1", tty: "ttys013" }];
  const panes = [{ paneId: "%651", tty: "/dev/ttys013" }]; // ps strips /dev/, tmux keeps it
  expect(paneFromCommandLine("s1", procs, panes, {})).toBe("%651");
});

test("paneFromCommandLine: no process carries this id → null", () => {
  expect(paneFromCommandLine("nope", [{ sessionId: "s1", tty: "ttys013" }], [{ paneId: "%651", tty: "/dev/ttys013" }], {})).toBeNull();
});

test("paneFromCommandLine: process matches but its TTY has no live pane → null", () => {
  expect(paneFromCommandLine("s1", [{ sessionId: "s1", tty: "ttys999" }], [{ paneId: "%651", tty: "/dev/ttys013" }], {})).toBeNull();
});

test("paneFromCommandLine: stale-id guard — pane hook-claimed by ANOTHER session → null", () => {
  // /clear case: the process command line still says --resume OLD, but the pane now
  // hosts NEW (hook map). The command-line OLD id must NOT resolve onto this pane.
  const procs = [{ sessionId: "old", tty: "ttys013" }];
  const panes = [{ paneId: "%651", tty: "/dev/ttys013" }];
  expect(paneFromCommandLine("old", procs, panes, { "%651": "new" })).toBeNull();
});

test("paneFromCommandLine: hook map agrees (or is silent) → returns the pane", () => {
  const procs = [{ sessionId: "s1", tty: "ttys013" }];
  const panes = [{ paneId: "%651", tty: "/dev/ttys013" }];
  expect(paneFromCommandLine("s1", procs, panes, { "%651": "s1" })).toBe("%651"); // same id, fine
  expect(paneFromCommandLine("s1", procs, panes, { "%2": "other" })).toBe("%651"); // unrelated entry
});

// --- pure predicates -----------------------------------------------------------

test("hasOpenQuestion: AskUserQuestion+question→true; Bash/null→false", () => {
  const ask: PendingToolCall = {
    name: "AskUserQuestion",
    toolUseId: "t",
    question: { question: "q", header: "h", options: [{ label: "a" }], multiSelect: false, toolUseId: "t" },
  };
  expect(hasOpenQuestion(ask)).toBe(true);
  expect(hasOpenQuestion({ name: "Bash", toolUseId: "t", command: "ls" })).toBe(false);
  expect(hasOpenQuestion(null)).toBe(false);
});

// --- buildSessionTranscript (the assembly logic) -------------------------------

test("buildSessionTranscript: ordered turns + last assistant, no pending", () => {
  const turns = parseTranscript(fixture("transcripts/approved-tool.jsonl"));
  const t = buildSessionTranscript(turns, null);
  expect(t.turns.map((x) => x.role)).toEqual(["user", "assistant", "assistant", "user", "assistant"]);
  expect(t.lastAssistant).toBe("Done. Created `/tmp/spike-perm-test.txt`.");
  expect(t.pendingTool).toBeUndefined();
  expect(t.openQuestion).toBeUndefined();
});

test("buildSessionTranscript: AskUserQuestion pending → openQuestion derived from it (A3)", () => {
  const turns = parseTranscript(fixture("transcripts/askuserquestion.jsonl"));
  const ask: PendingToolCall = {
    name: "AskUserQuestion",
    toolUseId: "t",
    question: { question: "q", header: "h", options: [{ label: "Apple" }, { label: "Banana" }], multiSelect: false, toolUseId: "t" },
  };
  const t = buildSessionTranscript(turns, ask);
  expect(t.pendingTool).toBe(ask);
  expect(t.openQuestion?.options.map((o) => o.label)).toEqual(["Apple", "Banana"]);
});

test("buildSessionTranscript: non-question pending → pendingTool set, no openQuestion", () => {
  const pending: PendingToolCall = { name: "Bash", toolUseId: "t", command: "ls" };
  const t = buildSessionTranscript([], pending);
  expect(t.pendingTool).toBe(pending);
  expect(t.openQuestion).toBeUndefined();
});

test("getTranscript: unknown session → empty turns, no throw", async () => {
  const t = await getTranscript("never-existed-uuid-xyz");
  expect(t.turns).toEqual([]);
  expect(t.lastAssistant).toBeUndefined();
});

// --- pendingToolFields (shared by the full response and the ?rev= fast path) ----

test("pendingToolFields: null → empty object (no keys to overwrite a client merge)", () => {
  expect(pendingToolFields(null)).toEqual({});
});

test("pendingToolFields: question pending → pendingTool + openQuestion(s)", () => {
  const q = { question: "q", header: "h", options: [{ label: "A" }], multiSelect: false, toolUseId: "t" };
  const ask: PendingToolCall = { name: "AskUserQuestion", toolUseId: "t", question: q, questions: [q] };
  const f = pendingToolFields(ask);
  expect(f.pendingTool).toBe(ask);
  expect(f.openQuestion).toBe(q);
  expect(f.openQuestions).toEqual([q]);
});

test("pendingToolFields: non-question pending → pendingTool only", () => {
  const pending: PendingToolCall = { name: "Bash", toolUseId: "t", command: "ls" };
  const f = pendingToolFields(pending);
  expect(f.pendingTool).toBe(pending);
  expect(f.openQuestion).toBeUndefined();
  expect(f.openQuestions).toBeUndefined();
});

test("transcriptRevAt: unknown session → null", async () => {
  expect(await transcriptRevAt("never-existed-uuid-xyz")).toBeNull();
});

// --- slimTurns (payload trimming for the bridge) -------------------------------

test("slimTurns: drops thinking + tool_result, keeps text + tool_use", () => {
  const turns = [
    {
      role: "assistant" as const,
      content: [
        { type: "thinking" as const, text: "secret reasoning" },
        { type: "text" as const, text: "hello" },
        { type: "tool_use" as const, id: "1", name: "Bash", input: { command: "ls" } },
        { type: "tool_result" as const, tool_use_id: "1", content: "x".repeat(50000) },
      ],
    },
  ];
  const [t] = slimTurns(turns);
  expect(t!.content.map((b) => b.type)).toEqual(["text", "tool_use"]);
});

test("slimTurns: tool_use input trimmed to the capped chip fields", () => {
  const long = "echo " + "a".repeat(500);
  const turns = [
    {
      role: "assistant" as const,
      content: [
        {
          type: "tool_use" as const,
          id: "1",
          name: "Bash",
          input: { command: long, description: "List files", timeout: 9999, content: "x".repeat(9000) },
        },
      ],
    },
  ];
  const block = slimTurns(turns)[0]!.content[0] as { type: "tool_use"; input: Record<string, string> };
  expect(Object.keys(block.input)).toEqual(["command", "description"]); // timeout/content dropped
  expect(block.input.command.length).toBeLessThanOrEqual(201); // 200 + "…"
  expect(block.input.command.endsWith("…")).toBe(true);
});

test("slimTurns: Agent/WebFetch/Skill chips get their describing fields; empty strings dropped", () => {
  const turns = [
    {
      role: "assistant" as const,
      content: [
        {
          type: "tool_use" as const,
          id: "a",
          name: "Agent",
          input: { description: "Trace the cookie path", subagent_type: "Explore", prompt: "p".repeat(5000) },
        },
        { type: "tool_use" as const, id: "w", name: "WebFetch", input: { url: "https://x.y/z", prompt: "" } },
        { type: "tool_use" as const, id: "s", name: "Skill", input: { skill: "code-review", args: "HEAD~1" } },
      ],
    },
  ];
  const [agent, fetch, skill] = slimTurns(turns)[0]!.content as Array<{ input: Record<string, string> }>;
  expect(agent!.input).toEqual({ description: "Trace the cookie path", subagent_type: "Explore" });
  expect(fetch!.input).toEqual({ url: "https://x.y/z" });
  expect(skill!.input).toEqual({ skill: "code-review", args: "HEAD~1" });
});

test("slimTurns: tool_result (next user turn) is folded into its tool_use as a summary", () => {
  const turns = [
    {
      role: "assistant" as const,
      content: [
        { type: "tool_use" as const, id: "ok", name: "Bash", input: { command: "bun test" } },
        { type: "tool_use" as const, id: "bad", name: "Bash", input: { command: "tsc" } },
        { type: "tool_use" as const, id: "open", name: "Bash", input: { command: "sleep 9" } },
      ],
    },
    {
      role: "user" as const,
      content: [
        { type: "tool_result" as const, tool_use_id: "ok", content: "\n  12 pass\n 0 fail\n\n" },
        {
          type: "tool_result" as const,
          tool_use_id: "bad",
          is_error: true,
          content: [{ type: "text", text: "src/x.ts(4,2): error TS2322 " + "y".repeat(300) + "\nmore" }],
        },
      ],
    },
  ];
  const out = slimTurns(turns);
  expect(out).toHaveLength(1); // the result-only user turn is still dropped
  const [ok, bad, open] = out[0]!.content as Array<{ result?: { ok: boolean; head: string; lines: number } }>;
  expect(ok!.result).toEqual({ ok: true, head: "12 pass", lines: 2 });
  expect(bad!.result!.ok).toBe(false);
  expect(bad!.result!.lines).toBe(2);
  expect(bad!.result!.head.length).toBe(121); // 120 + "…"
  expect(open!.result).toBeUndefined(); // no result yet — still running or never returned
});

test("slimTurns: answered AskUserQuestion → qa pairs + question lifted into description", () => {
  const turns = [
    {
      role: "assistant" as const,
      content: [
        {
          type: "tool_use" as const,
          id: "q1",
          name: "AskUserQuestion",
          input: { questions: [{ question: "Which storage?" }, { question: "Block until live?" }] },
        },
      ],
    },
    {
      role: "user" as const,
      content: [
        {
          type: "tool_result" as const,
          tool_use_id: "q1",
          content:
            'Your questions have been answered: "Which storage?"="HttpOnly cookie", "Block until live?"="Yes, block". You can now continue with these answers in mind.',
        },
      ],
    },
  ];
  const block = slimTurns(turns)[0]!.content[0] as {
    input: Record<string, string>;
    qa?: Array<{ q: string; a: string }>;
  };
  expect(block.qa).toEqual([
    { q: "Which storage?", a: "HttpOnly cookie" },
    { q: "Block until live?", a: "Yes, block" },
  ]);
  expect(block.input.description).toBe("Which storage?");
});

test("slimTurns: declined/unparseable AskUserQuestion → no qa, chip fallback keeps the result", () => {
  const turns = [
    {
      role: "assistant" as const,
      content: [
        { type: "tool_use" as const, id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Pick one" }] } },
      ],
    },
    {
      role: "user" as const,
      content: [
        { type: "tool_result" as const, tool_use_id: "q1", is_error: true, content: "User declined to answer" },
      ],
    },
  ];
  const block = slimTurns(turns)[0]!.content[0] as {
    qa?: unknown;
    result?: { ok: boolean; head: string; lines: number };
    input: Record<string, string>;
  };
  expect(block.qa).toBeUndefined();
  expect(block.result).toEqual({ ok: false, head: "User declined to answer", lines: 1 });
  expect(block.input.description).toBe("Pick one");
});

test("slimTurns: the turn timestamp rides along", () => {
  const out = slimTurns([{ role: "user", content: [{ type: "text", text: "hi" }], at: "2026-08-25T10:00:00.000Z" }]);
  expect(out[0]!.at).toBe("2026-08-25T10:00:00.000Z");
});

test("slimTurns: a turn emptied only by stripping is dropped; genuinely-empty kept", () => {
  const stripped = slimTurns([
    { role: "assistant", content: [{ type: "thinking", text: "x" }] },
  ]);
  expect(stripped).toEqual([]);
  const empty = slimTurns([{ role: "user", content: [] }]);
  expect(empty).toEqual([{ role: "user", content: [] }]);
});

test("slimTurns: keeps the byte-free image marker alongside text", () => {
  const [t] = slimTurns([
    { role: "user", content: [{ type: "text", text: "[Image #1] look" }, { type: "image" }] },
  ]);
  expect(t!.content).toEqual([{ type: "text", text: "[Image #1] look" }, { type: "image" }]);
});

test("slimTurns: per-turn flags (queued, compactSummary, command, bash, teammate) survive the rebuild", () => {
  const out = slimTurns([
    { role: "user", content: [{ type: "text", text: "queued msg" }], queued: true },
    { role: "user", content: [{ type: "text", text: "summary" }], compactSummary: true },
    { role: "user", content: [], command: "/pr-triage" },
    { role: "user", content: [{ type: "text", text: "plain" }] },
    { role: "user", content: [], bash: { command: "git pull", stdout: "ok", stderr: "" } },
    { role: "user", content: [], teammate: [{ id: "p0-ui", summary: "2 findings", body: "{}" }] },
  ]);
  expect(out[0]!.queued).toBe(true);
  expect(out[1]!.compactSummary).toBe(true);
  expect(out[2]).toEqual({ role: "user", content: [], command: "/pr-triage" });
  expect(out[3]).toEqual({ role: "user", content: [{ type: "text", text: "plain" }] });
  expect(out[4]).toEqual({
    role: "user",
    content: [],
    bash: { command: "git pull", stdout: "ok", stderr: "" },
  });
  expect(out[5]).toEqual({
    role: "user",
    content: [],
    teammate: [{ id: "p0-ui", summary: "2 findings", body: "{}" }],
  });
});

// --- composeMessageSteps (keystroke sequence for a message) ---------------------

test("composeMessageSteps: text-only → literal + enter (no paste)", () => {
  expect(composeMessageSteps("hello", [])).toEqual([
    { kind: "literal", text: "hello" },
    { kind: "enter" },
  ]);
});

test("composeMessageSteps: image-only → paste + enter (no literal)", () => {
  expect(composeMessageSteps("", ["/u/a.png"])).toEqual([
    { kind: "paste", text: "/u/a.png" },
    { kind: "enter" },
  ]);
});

test("composeMessageSteps: image + caption → paste, space-prefixed caption, enter", () => {
  expect(composeMessageSteps("what is this", ["/u/a.png"])).toEqual([
    { kind: "paste", text: "/u/a.png" },
    { kind: "literal", text: " what is this" }, // leading space separates from [Image #N]
    { kind: "enter" },
  ]);
});

test("composeMessageSteps: multiple images paste in order before the single terminal enter", () => {
  const steps = composeMessageSteps("", ["/u/a.png", "/u/b.png"]);
  expect(steps).toEqual([
    { kind: "paste", text: "/u/a.png" },
    { kind: "paste", text: "/u/b.png" },
    { kind: "enter" },
  ]);
});

test("composeMessageSteps: whitespace-only caption is dropped", () => {
  expect(composeMessageSteps("   ", ["/u/a.png"])).toEqual([
    { kind: "paste", text: "/u/a.png" },
    { kind: "enter" },
  ]);
});

// --- buildSendPlan (full tmux send sequence + draft-preserving guard) -----------
// These lock down HOW we drive Claude Code's prompt over tmux: the keystroke ORDER
// and, critically, that a Mac-side draft is cut (C-u, via the `stash` step) BEFORE our
// message and yanked back (C-y, via `restore`) AFTER it — never combined into one turn,
// and never touched when there's no draft to preserve.

test("buildSendPlan: text-only, no draft → just the coalescing-safe text step", () => {
  expect(buildSendPlan("hello", [], false)).toEqual([{ kind: "text", text: "hello" }]);
});

test("buildSendPlan: text-only WITH draft → stash, text, restore (in that order)", () => {
  expect(buildSendPlan("hello", [], true)).toEqual([
    { kind: "stash" }, // C-u: cut the Mac draft first so it can't ride along
    { kind: "text", text: "hello" },
    { kind: "restore" }, // C-y: put the draft back after our message submits
  ]);
});

test("buildSendPlan: image-only, no draft → paste then verify-retry submit", () => {
  expect(buildSendPlan("", ["/u/a.png"], false)).toEqual([
    { kind: "paste", text: "/u/a.png" },
    { kind: "submit" }, // composeMessageSteps' terminal `enter` becomes the retry submit
  ]);
});

test("buildSendPlan: image + caption WITH draft → stash wraps paste/literal/submit, then restore", () => {
  expect(buildSendPlan("what is this", ["/u/a.png"], true)).toEqual([
    { kind: "stash" },
    { kind: "paste", text: "/u/a.png" },
    { kind: "literal", text: " what is this" },
    { kind: "submit" },
    { kind: "restore" },
  ]);
});

test("buildSendPlan: draft guard is symmetric — stash is first iff restore is last", () => {
  for (const [text, imgs] of [
    ["hi", []],
    ["", ["/u/a.png"]],
    ["cap", ["/u/a.png", "/u/b.png"]],
  ] as const) {
    const withDraft = buildSendPlan(text, [...imgs], true);
    const noDraft = buildSendPlan(text, [...imgs], false);
    // present together or not at all
    expect(withDraft[0]).toEqual({ kind: "stash" });
    expect(withDraft[withDraft.length - 1]).toEqual({ kind: "restore" });
    expect(noDraft.some((s) => s.kind === "stash" || s.kind === "restore")).toBe(false);
    // the body between the guards is exactly the no-draft plan
    expect(withDraft.slice(1, -1)).toEqual(noDraft);
  }
});

// --- inputPending (submit-verification for image messages) ---------------------

test("inputPending: true while the prompt still holds the unsent message", () => {
  const cap = ["⏺ earlier reply", "❯ [Image #1] what color", "────", "  0/1000k (0%)"].join("\n");
  expect(inputPending(cap)).toBe(true);
});

test("inputPending: false once the input cleared (last ❯ line empty)", () => {
  // An earlier ❯ echo of the submitted message must NOT count — only the LAST ❯ line does.
  const cap = ["❯ [Image #1] what color", "  ⎿ [Image #1]", "⏺ Purple.", "❯ ", "────"].join("\n");
  expect(inputPending(cap)).toBe(false);
});

// --- flattenStyled (ghost-text discrimination on styled captures) ---------------
// Lab capture (VM pane, CC queued-message ghost): the EMPTY input box renders the
// held message dim — `❯ ESC[2mcommit that batchESC[0m` — which a plain capture
// flattens into a phantom draft (killInput then "fails" on an already-empty box).

test("flattenStyled drops a dim queued-message ghost; inputPending reads the box empty", () => {
  const cap = [
    "\x1b[38;5;246m✻\x1b[39m \x1b[38;5;246mBrewed for 38s\x1b[39m",
    "\x1b[38;5;244m" + "─".repeat(80),
    "\x1b[39m❯ \x1b[2mcommit that batch\x1b[0m",
    "\x1b[38;5;244m" + "─".repeat(80),
    "\x1b[39m  \x1b[38;5;246m⏸ manual mode on\x1b[39m",
  ].join("\n");
  expect(inputPending(flattenStyled(cap, true))).toBe(false);
  // The undropped view keeps the text (what a plain capture used to show).
  expect(inputPending(flattenStyled(cap, false))).toBe(true);
});

test("flattenStyled keeps real typed input (never rendered dim)", () => {
  const cap = ["\x1b[38;5;244m" + "─".repeat(80), "\x1b[39m❯ commit that batch", "\x1b[38;5;244m" + "─".repeat(80)].join("\n");
  expect(inputPending(flattenStyled(cap, true))).toBe(true);
});

test("flattenStyled: dim ended by SGR 22 (normal intensity), not only full reset", () => {
  expect(flattenStyled("❯ \x1b[2mghost\x1b[22m typed", true)).toBe("❯  typed");
});

test("flattenStyled: dim persists across a wrapped line until reset", () => {
  expect(flattenStyled("❯ \x1b[2mlong ghost\nwrapped tail\x1b[0m end", true)).toBe("❯ \n end");
});

test("flattenStyled: extended-color sub-params never read as dim", () => {
  // 38;2;r;g;b (truecolor) and 38;5;2 (256-color) both contain a literal "2"
  // param that is a color component, not SGR dim — text after them must survive
  // the dropDim view, and a component of 22 must not end a real dim span.
  expect(flattenStyled("\x1b[38;2;255;199;153mheader\x1b[39m\n❯ typed draft", true)).toBe("header\n❯ typed draft");
  expect(flattenStyled("\x1b[48;5;2mstatus\x1b[0m\n❯ typed draft", true)).toBe("status\n❯ typed draft");
  expect(flattenStyled("❯ \x1b[2mghost \x1b[38;5;22mstill ghost\x1b[0m typed", true)).toBe("❯  typed");
});

test("flattenStyled strips OSC 8 hyperlinks without eating following text", () => {
  const cap = "\x1b]8;id=1;https://example.com\x1b\\/rc\x1b]8;;\x1b\\ tail";
  expect(flattenStyled(cap, true)).toBe("/rc tail");
});

test("flattenStyled(…, false) preserves the dim shell-mode hint for shellModeInput", () => {
  const cap = ["! ", "  \x1b[2m! for shell mode\x1b[0m"].join("\n");
  expect(shellModeInput(flattenStyled(cap, false))).toEqual({ text: "" });
});

// --- shellModeInput (send-path shell-mode guard) --------------------------------
// Capture shapes taken from a live pane: in shell mode the input line renders `! …`
// where `❯` would be, with the "! for shell mode" hint under the input box.

const RULE = "─".repeat(40);

test("shellModeInput: empty shell prompt (the lingering queued-bang shape)", () => {
  const cap = ["⏺ done.", RULE, "! ", RULE, "  ! for shell mode"].join("\n");
  expect(shellModeInput(cap)).toEqual({ text: "" });
});

test("shellModeInput: shell prompt holding a Mac-side draft", () => {
  const cap = [RULE, "! echo hi there", RULE, "  ! for shell mode"].join("\n");
  expect(shellModeInput(cap)).toEqual({ text: "echo hi there" });
});

test("shellModeInput: null on a normal ❯ prompt, even after echoed bang output", () => {
  // Output lines starting with "!" (and echoed ❯ lines) sit ABOVE the live prompt —
  // neither may read as shell mode when the `❯` input is live.
  const cap = ["❯ !ls -la", "!remember: legacy syntax", "⏺ ok", RULE, "❯ ", RULE, "  0/200k (0%)"].join("\n");
  expect(shellModeInput(cap)).toBe(null);
});

test("shellModeInput: a bare ! output line without the hint is not shell mode", () => {
  const cap = ["⏺ running", "! some stray output line", RULE, "  esc to interrupt"].join("\n");
  expect(shellModeInput(cap)).toBe(null);
});

test("shellModeInput: null on a spinner capture with no prompt at all", () => {
  expect(shellModeInput("✶ Deliberating… (3s · 1.2k tokens)")).toBe(null);
});

test("inputPending is blind to a shell-mode draft (why the guard is its own step)", () => {
  // Shell mode has no live ❯ line, so inputPending reports "no draft" while a command
  // sits half-typed in the shell prompt — the draft guard alone would type right into
  // it. shellModeInput sees it and the send path aborts before inputPending is consulted.
  const cap = [RULE, "! rm -rf build", RULE, "  ! for shell mode"].join("\n");
  expect(inputPending(cap)).toBe(false);
  expect(shellModeInput(cap)).toEqual({ text: "rm -rf build" });
});

// --- notification rows (❯ ⧉ …) below the statusline -----------------------------
// Live capture (lead-scoring pane): Claude Code renders background-task notifications
// as `❯ ⧉  <task> · Enter to open · x to dismiss` BELOW the statusline — the one ❯
// line that sits under the live input. Reading it as a draft made killInput "fail"
// forever and every phone send abort with draft-stash-failed.

const NOTIF_ROW = "❯ ⧉  dial-priority-score · Enter to open · x to dismiss";

test("inputPending: false with a notification row below an empty prompt", () => {
  const cap = ["⏺ done.", RULE, "❯ ", RULE, "  346.9k/1000k (34%) • main", NOTIF_ROW].join("\n");
  expect(inputPending(cap)).toBe(false);
});

test("inputPending: a real draft above a notification row still reads pending", () => {
  const cap = [RULE, "❯ half-typed draft", RULE, "  ⏸ manual mode on", NOTIF_ROW].join("\n");
  expect(inputPending(cap)).toBe(true);
});

test("shellModeInput: notification row doesn't mask a live shell prompt", () => {
  // The row starts with ❯, which the bottom-up scan used to read as "normal prompt
  // live" — returning null and letting a plain send execute as bash.
  const cap = [RULE, "! rm -rf build", RULE, "  ! for shell mode", NOTIF_ROW].join("\n");
  expect(shellModeInput(cap)).toEqual({ text: "rm -rf build" });
});

test("inputPending: false on the queued-messages placeholder (hint text, not a draft)", () => {
  // Real pane capture while a message sits in the input queue: the queued message echoes
  // as its own ❯ line above the separator, and the (empty) input renders placeholder hint
  // text. Misreading it as a draft made sends wrap in stash/restore, and the restore C-y
  // yanked stale kill-ring content into the prompt.
  const cap = [
    "  ❯ MID-TURN-MSG please also say the word guava",
    "────",
    "❯ Press up to edit queued messages",
    "────",
    "  32.5k/200k (16%) •  • Haiku 4.5",
  ].join("\n");
  expect(inputPending(cap)).toBe(false);
});

// --- parseQueuedPending (replay of queue-operation records) --------------------

const qop = (operation: string, content: string | null) =>
  JSON.stringify({ type: "queue-operation", operation, content, timestamp: "t" });

test("parseQueuedPending: enqueue/dequeue is FIFO, remove deletes by content", () => {
  expect(parseQueuedPending([qop("enqueue", "a"), qop("enqueue", "b")].join("\n"))).toEqual([
    "a",
    "b",
  ]);
  // dequeue carries content:null — it shifts the head.
  expect(
    parseQueuedPending([qop("enqueue", "a"), qop("enqueue", "b"), qop("dequeue", null)].join("\n")),
  ).toEqual(["b"]);
  // remove (mid-turn consumption) deletes the matching entry, wherever it sits.
  expect(
    parseQueuedPending([qop("enqueue", "a"), qop("enqueue", "b"), qop("remove", "a")].join("\n")),
  ).toEqual(["b"]);
});

test("parseQueuedPending: popAll drains everything; task-notifications never surface", () => {
  expect(
    parseQueuedPending([qop("enqueue", "a"), qop("enqueue", "b"), qop("popAll", "a"), qop("popAll", "b")].join("\n")),
  ).toEqual([]);
  // A queued task-notification must be REPLAYED (a dequeue shifts whatever is at the
  // head) but filtered from the survivors — it's harness plumbing, not a user message.
  expect(
    parseQueuedPending(
      [qop("enqueue", "<task-notification>\n<task-id>b1</task-id>"), qop("enqueue", "real msg"), qop("dequeue", null)].join("\n"),
    ),
  ).toEqual(["real msg"]);
});

test("parseQueuedPending: an enqueued teams delivery never surfaces as the user's queued message", () => {
  const delivery =
    'Another Claude session sent a message:\n<agent-message from="x">report</agent-message>';
  expect(
    parseQueuedPending([qop("enqueue", delivery), qop("enqueue", "real msg")].join("\n")),
  ).toEqual(["real msg"]);
});

test("parseQueuedPending: tolerates torn lines and unknown ops", () => {
  const raw = [qop("enqueue", "kept"), '{"type":"queue-operation","operation":"enq', qop("compact", "x")].join("\n");
  expect(parseQueuedPending(raw)).toEqual(["kept"]);
});

test("parseQueuedPending: a desync survivor delivered later is not queued", () => {
  const userRec = (text: string) =>
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
  const attachRec = (text: string) =>
    JSON.stringify({ type: "attachment", attachment: { type: "queued_command", commandMode: "prompt", prompt: text } });
  // Real-history shape: Claude's dequeue took the NEWER entry (the op is content-less,
  // the replay can't tell and shifts the head instead), then `remove` consumed the older
  // one — so the modelled queue keeps "new msg" forever, though it landed as a user record.
  expect(
    parseQueuedPending(
      [qop("enqueue", "old msg"), qop("enqueue", "new msg"), qop("dequeue", null), qop("remove", "old msg"), userRec("new msg")].join("\n"),
    ),
  ).toEqual([]);
  // Mid-turn consumption lands as a queued_command attachment — also delivery evidence.
  expect(
    parseQueuedPending([qop("enqueue", "a"), qop("enqueue", "b"), qop("dequeue", null), attachRec("b")].join("\n")),
  ).toEqual([]);
  // A later queue-operation on identical re-sent text is NOT delivery.
  expect(
    parseQueuedPending([qop("enqueue", "again"), qop("dequeue", null), qop("enqueue", "again")].join("\n")),
  ).toEqual(["again"]);
  // A genuinely queued message (landed nowhere yet) still surfaces.
  expect(parseQueuedPending([qop("enqueue", "still waiting")].join("\n"))).toEqual(["still waiting"]);
});

// --- readContextUsage (token usage for the status-bar readout) -----------------

const txLine = (usage: object) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", usage } });

test("readContextUsage: sums input + cache_creation + cache_read of the LAST assistant turn", async () => {
  const path = join(PATHS.dir, "usage-a.jsonl");
  writeFileSync(
    path,
    [
      txLine({ input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
      txLine({ input_tokens: 552, cache_creation_input_tokens: 365, cache_read_input_tokens: 177862 }),
    ].join("\n") + "\n",
  );
  const u = await readContextUsage(path);
  expect(u).toEqual({ tokens: 178779, size: 200_000, percent: 89 });
});

test("readContextUsage: infers the 1M window when usage exceeds 200k", async () => {
  const path = join(PATHS.dir, "usage-b.jsonl");
  writeFileSync(path, txLine({ input_tokens: 250_000, cache_read_input_tokens: 0 }) + "\n");
  const u = await readContextUsage(path);
  expect(u?.size).toBe(1_000_000);
  expect(u?.percent).toBe(25);
});

test("readContextUsage: missing file / no usage → null", async () => {
  expect(await readContextUsage(join(PATHS.dir, "nope.jsonl"))).toBeNull();
  const empty = join(PATHS.dir, "usage-empty.jsonl");
  writeFileSync(empty, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
  expect(await readContextUsage(empty)).toBeNull();
});

// --- rewind picker parsing (calibrated against live claude 2.1.x capture-pane) --

const PICKER_STAGE1 = `
  Rewind
  Restore the code and/or conversation to the point before…
    Reply with exactly the word: ALPHA
    No code changes
    Reply with exactly the word: BETA
    No code changes
  ❯ Reply with exactly the word: GAMMA
    No code changes
    (current)
  Enter to continue · Esc to cancel`;

const MENU_NO_CODE = `
  Rewind
  ❯ 1. Restore conversation
    2. Summarize from here
    3. Summarize up to here`;

const MENU_WITH_CODE = `
  Rewind
  ❯ 1. Restore code and conversation
    2. Restore conversation
    3. Restore code
    4. Summarize from here
    5. Summarize up to here`;

test("pickerCursorText: reads the selected (❯) checkpoint, ignoring the footer", () => {
  expect(pickerCursorText(PICKER_STAGE1)).toBe("Reply with exactly the word: GAMMA");
  expect(pickerCursorText("no picker here")).toBeNull();
});

test("cursorMatches: truncated cursor text is accepted as a prefix of the full message", () => {
  expect(cursorMatches("Reply with exactly the word: GA…", "Reply with exactly the word: GAMMA")).toBe(true);
  expect(cursorMatches("Reply with exactly the word: GAMMA", "Reply with exactly the word: GAMMA")).toBe(true);
  expect(cursorMatches("Totally different", "Reply with exactly the word: GAMMA")).toBe(false);
  expect(cursorMatches("ab", "abcdef")).toBe(false); // too short to trust
});

test("parseModeMenu: extracts numbered restore options", () => {
  expect(parseModeMenu(MENU_WITH_CODE)).toEqual([
    { num: 1, label: "Restore code and conversation" },
    { num: 2, label: "Restore conversation" },
    { num: 3, label: "Restore code" },
    { num: 4, label: "Summarize from here" },
    { num: 5, label: "Summarize up to here" },
  ]);
});

test("modeDowns: maps a requested mode to Down-presses for both menu layouts", () => {
  // no code changed → only conversation is offered (option 1)
  expect(modeDowns(parseModeMenu(MENU_NO_CODE), "conversation")).toBe(0);
  expect(modeDowns(parseModeMenu(MENU_NO_CODE), "both")).toBe(0); // falls back to conversation
  // code changed → both=option1, conversation=option2
  expect(modeDowns(parseModeMenu(MENU_WITH_CODE), "both")).toBe(0);
  expect(modeDowns(parseModeMenu(MENU_WITH_CODE), "conversation")).toBe(1);
  expect(modeDowns([], "conversation")).toBe(-1); // menu not found → caller aborts
});

// --- send/answer no-pane short-circuit (hermetic: never reaches tmux) ----------

test("sendMessage: no pane mapping → no-pane, sends nothing", async () => {
  const r = await sendMessage("ghost-session", "hi");
  expect(r).toEqual({ ok: false, reason: "no-pane" });
});

test("answerSessionQuestion: no open question → no-question (gates before the pane check)", async () => {
  const r = await answerSessionQuestion("ghost-session", [0]);
  expect(r).toEqual({ ok: false, reason: "no-question" });
});

test("answerSessionQuestion: open question, no hook holding, no pane → no-pane (send-keys fallback)", async () => {
  const id = "q-nopane";
  seedQuestionEvent(id, "tuq_1");
  // No pending question file → decideQuestion returns false → falls through to the pane
  // path, which has no mapping for this ghost session.
  const r = await answerSessionQuestion(id, [0]);
  expect(r).toEqual({ ok: false, reason: "no-pane" });
});

test("answerSessionQuestion: hook holding → decideQuestion resolves via the file channel, no pane needed", async () => {
  const id = "q-intercept";
  seedQuestionEvent(id, "tuq_1");
  // Simulate the question-hook holding this question.
  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(
    join(PENDING_DIR, `${id}.json`),
    JSON.stringify({ sessionId: id, kind: "question", tool_use_id: "tuq_1" }),
  );
  const r = await answerSessionQuestion(id, [1]);
  expect(r).toEqual({ ok: true });
  // A question decision was written carrying the selected label (keyed by question text).
  const dec = JSON.parse(readFileSync(join(DECISIONS_DIR, `${id}.json`), "utf8"));
  expect(dec.kind).toBe("question");
  expect(dec.tool_use_id).toBe("tuq_1");
  expect(dec.answers).toEqual({ Pick: "B" });
});

test("answerSessionQuestion: toolUseId mismatch → stale-question, current question untouched", async () => {
  const id = "q-stale";
  seedQuestionEvent(id, "tuq_current");
  // Hook holding the CURRENT question — a stale phone card (rendered for an earlier,
  // already-resolved question) must not consume it with selections the user made
  // against different options.
  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(
    join(PENDING_DIR, `${id}.json`),
    JSON.stringify({ sessionId: id, kind: "question", tool_use_id: "tuq_current" }),
  );
  expect(await answerSessionQuestion(id, [0], "tuq_stale")).toEqual({ ok: false, reason: "stale-question" });
  expect(existsSync(join(DECISIONS_DIR, `${id}.json`))).toBe(false);
});

test("answerSessionQuestion: matching toolUseId → answers via the file channel as before", async () => {
  const id = "q-pinned";
  seedQuestionEvent(id, "tuq_1");
  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(
    join(PENDING_DIR, `${id}.json`),
    JSON.stringify({ sessionId: id, kind: "question", tool_use_id: "tuq_1" }),
  );
  expect(await answerSessionQuestion(id, [1], "tuq_1")).toEqual({ ok: true });
  const dec = JSON.parse(readFileSync(join(DECISIONS_DIR, `${id}.json`), "utf8"));
  expect(dec.tool_use_id).toBe("tuq_1");
  expect(dec.answers).toEqual({ Pick: "B" });
});

test("answerSessionQuestion: abandoned hold (hook process gone) → send-keys fallback, no decision written", async () => {
  const id = "q-abandoned";
  seedQuestionEvent(id, "tuq_1");
  // The hook registered a hold, then died without cleaning up (killed mid-block), so the
  // question fell through to the on-screen widget. Writing a decision here would be read
  // by nobody: the answer must take the pane path (no mapping here → no-pane).
  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(
    join(PENDING_DIR, `${id}.json`),
    JSON.stringify({ sessionId: id, kind: "question", tool_use_id: "tuq_1", ts: Date.now(), pid: await deadPid() }),
  );
  expect(await answerSessionQuestion(id, [1])).toEqual({ ok: false, reason: "no-pane" });
  expect(existsSync(join(DECISIONS_DIR, `${id}.json`))).toBe(false);
});

test("clarifySessionQuestion: abandoned hold → pane path (no decision written into the void)", async () => {
  const id = "q-clarify-abandoned";
  seedQuestionEvent(id, "tuq_1");
  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(
    join(PENDING_DIR, `${id}.json`),
    JSON.stringify({ sessionId: id, kind: "question", tool_use_id: "tuq_1", ts: Date.now(), pid: await deadPid() }),
  );
  // The hook died, so the question fell through to the on-screen picker: clarify must
  // drive the pane (no mapping here → no-pane), never write a decision nobody reads.
  expect(await clarifySessionQuestion(id)).toEqual({ ok: false, reason: "no-pane" });
  expect(existsSync(join(DECISIONS_DIR, `${id}.json`))).toBe(false);
});

test("clarifySessionQuestion: no open question → no-question", async () => {
  expect(await clarifySessionQuestion("ghost-session")).toEqual({ ok: false, reason: "no-question" });
});

test("clarifySessionQuestion: open question but no hook holding → pane path (native widget)", async () => {
  const id = "q-clarify-native";
  seedQuestionEvent(id, "tuq_1");
  // No pending file → declineQuestion returns false → drive the native picker's own
  // chat row instead (no mapping in this fixture → no-pane).
  expect(await clarifySessionQuestion(id)).toEqual({ ok: false, reason: "no-pane" });
});

test("clarifySessionQuestion: hook holding → writes a clarify decision, no pane needed", async () => {
  const id = "q-clarify";
  seedQuestionEvent(id, "tuq_1");
  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(
    join(PENDING_DIR, `${id}.json`),
    JSON.stringify({ sessionId: id, kind: "question", tool_use_id: "tuq_1" }),
  );
  expect(await clarifySessionQuestion(id)).toEqual({ ok: true });
  const dec = JSON.parse(readFileSync(join(DECISIONS_DIR, `${id}.json`), "utf8"));
  expect(dec.kind).toBe("question");
  expect(dec.tool_use_id).toBe("tuq_1");
  expect(dec.clarify).toBe(true);
  expect(dec.answers).toBeUndefined();
});

test("interruptSession: no pane mapping → no-pane, sends nothing", async () => {
  const r = await interruptSession("ghost-session");
  expect(r).toEqual({ ok: false, reason: "no-pane" });
});

test("clearPaneInput: no pane mapping → no-pane, sends nothing", async () => {
  const r = await clearPaneInput("ghost-session");
  expect(r).toEqual({ ok: false, reason: "no-pane" });
});

// --- model/effort switcher: pure parsers (statusline + confirmation + allowlists) ---

test("parseStatusline: full line → 1M-Opus arg key + effort level", () => {
  expect(parseStatusline("0/1000k (0%) • master • Opus 5 (1M context) • high")).toEqual({
    model: "opus[1m]",
    effort: "high",
  });
});

test("parseStatusline: non-1M Opus → base 'opus' (not the menu's opus[1m])", () => {
  // bare `/model opus` yields "Opus 5" with no "1M context"; not offered in the menu, so it
  // simply won't pre-mark anything — but must NOT be mistaken for the 1M variant.
  expect(parseStatusline("0/1000k (0%) • main • Opus 5 • medium").model).toBe("opus");
});

test("parseStatusline: previous Opus is its own arg key, not the current one", () => {
  // "Opus 4.8" must not mark the Opus row — the `opus` alias now resolves to Opus 5.
  expect(parseStatusline("0/1000k (0%) • main • Opus 4.8 (1M context) • high").model).toBe(
    "claude-opus-4-8[1m]",
  );
  expect(parseStatusline("• b • Opus 4.8").model).toBe("claude-opus-4-8");
});

test("parseStatusline: missing effort segment → model only, no effort", () => {
  expect(parseStatusline("12.3k/200k (6%) • feat/x • Sonnet 5")).toEqual({ model: "sonnet" });
});

test("parseStatusline: every family maps to its arg key", () => {
  expect(parseStatusline("• b • Opus 5 (1M context)").model).toBe("opus[1m]");
  expect(parseStatusline("• b • Sonnet 5").model).toBe("sonnet");
  expect(parseStatusline("• b • Haiku 4.5").model).toBe("haiku");
  expect(parseStatusline("• b • Fable 5").model).toBe("fable");
});

test("parseStatusline: 'Default' renders as 1M Opus → resolves to opus[1m]", () => {
  // Claude's statusline shows the resolved model; Default and Opus both render "Opus 5 (1M context)".
  expect(parseStatusline("0/1000k (0%) • main • Opus 5 (1M context) • medium").model).toBe("opus[1m]");
});

test("parseStatusline: garbled/foreign line → {} (no throw)", () => {
  expect(parseStatusline("some unrelated text with no bullets")).toEqual({});
  expect(parseStatusline("")).toEqual({});
});

test("parseStatusline: effort takes the trailing segment (last match wins)", () => {
  // even if an earlier segment coincidentally equals a level word, the last one is the effort
  expect(parseStatusline("0/1k (0%) • high • Opus 4.8 • max").effort).toBe("max");
});

test("extractConfirmation: model set globally", () => {
  const cap = "❯ /model sonnet\n  ⎿  Set model to Sonnet 5 and saved as your default for new sessions\n";
  expect(extractConfirmation(cap)).toBe(
    "Set model to Sonnet 5 and saved as your default for new sessions",
  );
});

test("extractConfirmation: effort set globally", () => {
  const cap = "  ⎿  Set effort level to high (saved as your default for new sessions): Balanced";
  expect(extractConfirmation(cap)).toBe(
    "Set effort level to high (saved as your default for new sessions): Balanced",
  );
});

test("extractConfirmation: ultracode reports session-only scope verbatim", () => {
  const cap =
    "  ⎿  Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration\n";
  expect(extractConfirmation(cap)).toBe(
    "Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration",
  );
});

test("extractConfirmation: wrapped continuation line is joined, not truncated", () => {
  const cap =
    "  ⎿  Set model to Opus 4.8 (1M context) (default) and saved as your default\n     for new sessions\n";
  expect(extractConfirmation(cap)).toBe(
    "Set model to Opus 4.8 (1M context) (default) and saved as your default for new sessions",
  );
});

test("extractConfirmation: no confirmation present → null", () => {
  expect(extractConfirmation("❯ \n  0/1000k (0%) • main • Opus 4.8 • medium\n")).toBeNull();
});

test("restoreSession: missing repo dir short-circuits to no-repo (no tmux)", async () => {
  const r = await restoreSession(
    "00000000-0000-4000-8000-000000000000",
    join(PATHS.dir, "does-not-exist-repo"),
  );
  expect(r).toEqual({ ok: false, reason: "no-repo" });
});

test("restoreSession: real repo dir but unknown session → no-transcript (no tmux)", async () => {
  // PATHS.dir exists (temp HOME); a random session id has no transcript under ~/.claude/projects.
  const r = await restoreSession("11111111-1111-4111-8111-111111111111", PATHS.dir);
  expect(r).toEqual({ ok: false, reason: "no-transcript" });
});

test("isModelArg/isEffortArg: allowlist members pass, others reject", () => {
  for (const m of MODEL_ARGS) expect(isModelArg(m)).toBe(true);
  for (const e of EFFORT_ARGS) expect(isEffortArg(e)).toBe(true);
  expect(isModelArg("gpt4")).toBe(false);
  expect(isModelArg("")).toBe(false);
  expect(isModelArg("opus ")).toBe(false);
  expect(isEffortArg("extreme")).toBe(false);
  expect(isEffortArg("")).toBe(false);
});
