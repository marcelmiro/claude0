/**
 * Coverage for the subagent drill-in surface (`session-api.ts` subagent functions).
 *
 * Hermetic, repo style: pure fns asserted directly; the I/O fns are handed explicit
 * paths under the redirected CLAUDE0_HOME (so no homedir glob). `../../test/helpers/home`
 * MUST stay the first import — it redirects CLAUDE0_HOME before `config` freezes `PATHS.dir`.
 *
 * The status rule is the validated core (content-shape, NOT `stop_reason`): `done` iff the
 * last conversational record is an `assistant` turn ending in a `text` block. The
 * >64KB-final-record and torn-trailing-line cases exercise `tailRecords`' backward chunked
 * reader through `subagentStatus` (the reader itself is internal).
 */

import "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  subagentsDir,
  isValidAgentId,
  subagentStatus,
  listSubagents,
  getSubagentTranscript,
  capOpeningTurn,
} from "./session-api";
import { PATHS } from "./config";
import type { TranscriptBlock, TranscriptTurn } from "../types";

const WORK = join(PATHS.dir, "subagent-fixtures");

beforeEach(() => {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
});

// --- record/block builders (only the fields subagentStatus/parseTranscript read) ---
const asst = (blocks: unknown[], extra: object = {}) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: blocks, ...extra } });
const usr = (blocks: unknown[]) =>
  JSON.stringify({ type: "user", message: { role: "user", content: blocks } });
const txt = (t: string) => ({ type: "text", text: t });
const think = (t: string) => ({ type: "thinking", thinking: t });
const tuse = (id: string, name: string) => ({ type: "tool_use", id, name, input: {} });
const tres = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "out" });

// Write an agent's jsonl + meta under WORK/<stem>/subagents; the matching transcript path
// is WORK/<stem>.jsonl (subagentsDir strips the `.jsonl` and appends `/subagents`).
function writeAgent(stem: string, agentId: string, jsonl: string, meta: object | null) {
  const dir = join(WORK, stem, "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), jsonl);
  if (meta) writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
}

// --- subagentsDir (pure) -------------------------------------------------------

test("subagentsDir: derives <sessionId>/subagents from a transcript path", () => {
  expect(subagentsDir("/x/proj/abc.jsonl")).toBe("/x/proj/abc/subagents");
  expect(subagentsDir("/x/proj/abc")).toBe("/x/proj/abc/subagents"); // tolerates a missing suffix
});

// --- isValidAgentId (traversal guard) ------------------------------------------

test("isValidAgentId: accepts hex stems, rejects traversal / `.` / `_`", () => {
  expect(isValidAgentId("a1b2c3")).toBe(true);
  expect(isValidAgentId("agent-x")).toBe(true);
  expect(isValidAgentId("../etc")).toBe(false);
  expect(isValidAgentId("a/b")).toBe(false);
  expect(isValidAgentId("a.b")).toBe(false);
  expect(isValidAgentId("aside_question-1")).toBe(false);
  expect(isValidAgentId("")).toBe(false);
});

// --- subagentStatus (content-shape rule, NOT stop_reason) ----------------------

test("subagentStatus: assistant ending in a text block → done (even after thinking)", async () => {
  const p = join(WORK, "done.jsonl");
  writeFileSync(p, asst([think("reasoning"), txt("All set.")]) + "\n");
  expect(await subagentStatus(p)).toBe("done");
});

test("subagentStatus: done regardless of stop_reason (null AND end_turn)", async () => {
  const withNull = join(WORK, "n.jsonl");
  writeFileSync(withNull, asst([txt("done")], { stop_reason: null }) + "\n");
  const withEnd = join(WORK, "e.jsonl");
  writeFileSync(withEnd, asst([txt("done")], { stop_reason: "end_turn" }) + "\n");
  expect(await subagentStatus(withNull)).toBe("done"); // the 22% null-stop_reason rescue
  expect(await subagentStatus(withEnd)).toBe("done");
});

test("subagentStatus: thinking-only assistant tail → running", async () => {
  const p = join(WORK, "r1.jsonl");
  writeFileSync(p, asst([txt("hi")]) + "\n" + asst([think("still going")]) + "\n");
  expect(await subagentStatus(p)).toBe("running");
});

test("subagentStatus: tool_result user tail → running", async () => {
  const p = join(WORK, "r2.jsonl");
  writeFileSync(p, asst([txt("call"), tuse("1", "Bash")]) + "\n" + usr([tres("1")]) + "\n");
  expect(await subagentStatus(p)).toBe("running");
});

test("subagentStatus: tool-calling assistant tail (ends in tool_use) → running", async () => {
  const p = join(WORK, "r3.jsonl");
  writeFileSync(p, asst([txt("let me"), tuse("1", "Bash")]) + "\n");
  expect(await subagentStatus(p)).toBe("running");
});

test("subagentStatus: empty file / missing file → running", async () => {
  const empty = join(WORK, "empty.jsonl");
  writeFileSync(empty, "");
  expect(await subagentStatus(empty)).toBe("running");
  expect(await subagentStatus(join(WORK, "nope.jsonl"))).toBe("running");
});

test("subagentStatus: recovers a final record exceeding 64KB (window doubling) → done", async () => {
  const p = join(WORK, "big.jsonl");
  // Final record ~80KB > the 64KB initial window — a fixed window would see only a
  // newline-less fragment and misclassify; the backward reader must double to recover it.
  writeFileSync(p, asst([txt("start")]) + "\n" + asst([txt("x".repeat(80_000))]) + "\n");
  expect(await subagentStatus(p)).toBe("done");
});

test("subagentStatus: skips a torn trailing line, uses the prior complete record", async () => {
  const p = join(WORK, "torn.jsonl");
  // Complete final record, then a half-written line (file mid-write) with no newline.
  writeFileSync(p, asst([txt("complete final")]) + "\n" + '{"type":"assistant","message":{"role":"assi');
  expect(await subagentStatus(p)).toBe("done");
});

// --- listSubagents -------------------------------------------------------------

test("listSubagents: reads fields + per-agent status, sorted by (spawnDepth, description)", async () => {
  const tx = join(WORK, "sess.jsonl");
  writeAgent("sess", "bbb", asst([txt("done work")]) + "\n", {
    agentType: "Explore",
    description: "zeta task",
    spawnDepth: 1,
  });
  writeAgent("sess", "aaa", asst([txt("a"), tuse("1", "Bash")]) + "\n", {
    agentType: "general-purpose",
    description: "alpha task",
  }); // no spawnDepth → defaults to depth 1 for the sort
  const list = await listSubagents([tx]);
  // (depth ?? 1) ties → description alpha < zeta. A done agent's jsonl is immutable, so
  // its mtime is its completion instant — surfaced as finishedAt; running agents omit it.
  expect(list).toEqual([
    { agentId: "aaa", agentType: "general-purpose", description: "alpha task", status: "running" },
    {
      agentId: "bbb",
      agentType: "Explore",
      description: "zeta task",
      status: "done",
      spawnDepth: 1,
      finishedAt: expect.any(String),
    },
  ]);
});

test("listSubagents: missing dir → []", async () => {
  expect(await listSubagents([join(WORK, "no-such-session.jsonl")])).toEqual([]);
});

test("listSubagents: corrupt meta is skipped, valid siblings still returned", async () => {
  const tx = join(WORK, "s2.jsonl");
  writeAgent("s2", "ok1", asst([txt("done")]) + "\n", { agentType: "x", description: "ok" });
  const dir = join(WORK, "s2", "subagents");
  writeFileSync(join(dir, "agent-bad.meta.json"), "{not json");
  writeFileSync(join(dir, "agent-bad.jsonl"), asst([txt("done")]) + "\n");
  expect((await listSubagents([tx])).map((a) => a.agentId)).toEqual(["ok1"]);
});

// --- getSubagentTranscript (guard + unresolvable session) ----------------------

test("getSubagentTranscript: rejects a traversal agentId (guard) → null", async () => {
  expect(await getSubagentTranscript("any-session", "../../etc/passwd")).toBeNull();
  expect(await getSubagentTranscript("any-session", "a/b")).toBeNull();
});

test("getSubagentTranscript: unresolvable session → null", async () => {
  expect(await getSubagentTranscript("never-existed-uuid-zzz", "abc")).toBeNull();
});

// --- capOpeningTurn (~2KB cap on the task brief) -------------------------------

const block = (t: string): TranscriptBlock => ({ type: "text", text: t });

test("capOpeningTurn: truncates a >2KB opening user block, leaves the body untouched", () => {
  const turns: TranscriptTurn[] = [
    { role: "user", content: [block("u".repeat(5000))] },
    { role: "assistant", content: [block("a".repeat(5000))] },
  ];
  capOpeningTurn(turns);
  const first = turns[0]!.content[0] as Extract<TranscriptBlock, { type: "text" }>;
  expect(first.text.length).toBeLessThanOrEqual(2048 + "… (truncated)".length);
  expect(first.text.endsWith("… (truncated)")).toBe(true);
  const body = turns[1]!.content[0] as Extract<TranscriptBlock, { type: "text" }>;
  expect(body.text.length).toBe(5000); // assistant body untouched
});

test("capOpeningTurn: opening assistant turn (no leading user) untouched", () => {
  const turns: TranscriptTurn[] = [{ role: "assistant", content: [block("a".repeat(5000))] }];
  capOpeningTurn(turns);
  const first = turns[0]!.content[0] as Extract<TranscriptBlock, { type: "text" }>;
  expect(first.text.length).toBe(5000);
});
