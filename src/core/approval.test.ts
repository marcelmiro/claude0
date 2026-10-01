/**
 * Approval IPC round-trip (Inc6/Inc7). Pins the fs contract that the blocking
 * `pretooluse.sh` relies on: decision-file writes, pending enrichment from the
 * logged PreToolUse event, and dead-session reaping.
 *
 * `home` helper first — freezes PENDING_DIR/DECISIONS_DIR/EVENTS_DIR under temp HOME.
 */

import "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import {
  decideApproval,
  decideQuestion,
  declineQuestion,
  buildAnswersMap,
  listPendingApprovals,
  questionHeld,
  reapDeadSessionFiles,
  PENDING_DIR,
  DECISIONS_DIR,
} from "./approval";
import { EVENTS_DIR, eventLogPath } from "./hook-events";
import { deadPid } from "../../test/helpers/dead-pid";
import type { HookEvent } from "../types";
import type { PendingQuestion } from "./jsonl-reader";

/** Minimal PendingQuestion for the answers-map tests. */
function q(question: string, labels: string[], multiSelect = false): PendingQuestion {
  return { question, header: "H", options: labels.map((label) => ({ label })), multiSelect, toolUseId: "tu_q" };
}

beforeEach(() => {
  for (const dir of [EVENTS_DIR, PENDING_DIR, DECISIONS_DIR]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
});

test("decideApproval(allow) writes a decision file with no reason", () => {
  decideApproval("sess-a", "allow");
  const payload = JSON.parse(readFileSync(`${DECISIONS_DIR}/sess-a.json`, "utf8"));
  expect(payload.sessionId).toBe("sess-a");
  expect(payload.decision).toBe("allow");
  expect(payload.reason).toBeUndefined();
  expect(typeof payload.ts).toBe("number");
});

test("decideApproval(deny, reason) records the reason", () => {
  decideApproval("sess-b", "deny", { reason: "not allowed here" });
  const payload = JSON.parse(readFileSync(`${DECISIONS_DIR}/sess-b.json`, "utf8"));
  expect(payload.decision).toBe("deny");
  expect(payload.reason).toBe("not allowed here");
});

test("decideApproval records kind:approval + tool_use_id when supplied", () => {
  decideApproval("sess-tu", "allow", { toolUseId: "tu_42" });
  const payload = JSON.parse(readFileSync(`${DECISIONS_DIR}/sess-tu.json`, "utf8"));
  expect(payload.kind).toBe("approval");
  expect(payload.tool_use_id).toBe("tu_42");
});

test("buildAnswersMap: single-select → label; multi-select → comma-joined; multi-question", () => {
  const questions = [q("Pick a fruit", ["Apple", "Banana", "Cherry"]), q("Toppings", ["Nuts", "Sauce"], true)];
  expect(buildAnswersMap(questions, [2, [0, 1]])).toEqual({
    "Pick a fruit": "Cherry",
    Toppings: "Nuts,Sauce",
  });
});

test("decideQuestion writes a matching question decision and returns true", () => {
  const id = "q-hold";
  writeFileSync(
    `${PENDING_DIR}/${id}.json`,
    JSON.stringify({ sessionId: id, kind: "question", tool_use_id: "tu_q" }),
  );
  expect(decideQuestion(id, "tu_q", { Pick: "B" })).toBe(true);
  const dec = JSON.parse(readFileSync(`${DECISIONS_DIR}/${id}.json`, "utf8"));
  expect(dec.kind).toBe("question");
  expect(dec.tool_use_id).toBe("tu_q");
  expect(dec.answers).toEqual({ Pick: "B" });
});

test("decideQuestion returns false (no channel) when no hook is holding — drives the send-keys fallback", () => {
  // No pending file at all.
  expect(decideQuestion("q-absent", "tu_q", { Pick: "B" })).toBe(false);
  // Pending file exists but tool_use_id mismatches → still false (stale hold).
  const id = "q-mismatch";
  writeFileSync(
    `${PENDING_DIR}/${id}.json`,
    JSON.stringify({ sessionId: id, kind: "question", tool_use_id: "tu_other" }),
  );
  expect(decideQuestion(id, "tu_q", { Pick: "B" })).toBe(false);
  expect(existsSync(`${DECISIONS_DIR}/${id}.json`)).toBe(false);
});

test("declineQuestion writes a clarify decision (no answers) and returns true", () => {
  const id = "q-decline";
  writeFileSync(
    `${PENDING_DIR}/${id}.json`,
    JSON.stringify({ sessionId: id, kind: "question", tool_use_id: "tu_q" }),
  );
  expect(declineQuestion(id, "tu_q")).toBe(true);
  const dec = JSON.parse(readFileSync(`${DECISIONS_DIR}/${id}.json`, "utf8"));
  expect(dec.kind).toBe("question");
  expect(dec.tool_use_id).toBe("tu_q");
  expect(dec.clarify).toBe(true);
  expect(dec.answers).toBeUndefined();
});

test("a hold whose hook process is gone is dead: no decision, marker reaped, decline rejected", async () => {
  const pid = await deadPid();
  for (const [id, act] of [
    ["q-dead-answer", () => decideQuestion("q-dead-answer", "tu_q", { Pick: "B" })],
    ["q-dead-decline", () => declineQuestion("q-dead-decline", "tu_q")],
  ] as const) {
    writeFileSync(
      `${PENDING_DIR}/${id}.json`,
      JSON.stringify({ sessionId: id, kind: "question", tool_use_id: "tu_q", ts: Date.now(), pid }),
    );
    expect(act()).toBe(false);
    expect(existsSync(`${DECISIONS_DIR}/${id}.json`)).toBe(false);
    // Reaped, so the phantom hold isn't re-reported on the next poll.
    expect(existsSync(`${PENDING_DIR}/${id}.json`)).toBe(false);
  }
});

test("a hold from a live hook still answers via the file channel", () => {
  const id = "q-live";
  writeFileSync(
    `${PENDING_DIR}/${id}.json`,
    JSON.stringify({ sessionId: id, kind: "question", tool_use_id: "tu_q", ts: Date.now(), pid: process.pid }),
  );
  expect(decideQuestion(id, "tu_q", { Pick: "B" })).toBe(true);
});

test("questionHeld: only a live question hold counts — not an approval hold, not a dead hook", async () => {
  const hold = (id: string, kind: string, pid: number) =>
    writeFileSync(
      `${PENDING_DIR}/${id}.json`,
      JSON.stringify({ sessionId: id, kind, tool_use_id: "tu", ts: Date.now(), pid }),
    );
  hold("qh-live", "question", process.pid);
  hold("qh-approval", "approval", process.pid);
  hold("qh-dead", "question", await deadPid());
  expect(questionHeld("qh-live")).toBe(true);
  expect(questionHeld("qh-approval")).toBe(false);
  expect(questionHeld("qh-dead")).toBe(false);
  expect(questionHeld("qh-absent")).toBe(false);
});

test("a live hold near the end of its poll window is still honoured, not reaped", () => {
  // The hook polls to a deadline, so it's still holding at the last moment of the window —
  // a reader must not judge it dead just because the marker is old.
  const id = "q-late";
  writeFileSync(
    `${PENDING_DIR}/${id}.json`,
    JSON.stringify({
      sessionId: id,
      kind: "question",
      tool_use_id: "tu_q",
      ts: Date.now() - 599_000, // inside the 600s window, barely
      pid: process.pid,
    }),
  );
  expect(decideQuestion(id, "tu_q", { Pick: "B" })).toBe(true);
  expect(existsSync(`${PENDING_DIR}/${id}.json`)).toBe(true);
});

test("a live pid older than the hook's poll window is dead (recycled pid)", () => {
  // Question holds poll for hours: 700s old is well inside their window and must be
  // honoured (the shared pre-split bound would have reaped it at 610s).
  const live = "q-recycled-live";
  writeFileSync(
    `${PENDING_DIR}/${live}.json`,
    JSON.stringify({
      sessionId: live,
      kind: "question",
      tool_use_id: "tu_q",
      ts: Date.now() - 700_000,
      pid: process.pid,
    }),
  );
  expect(decideQuestion(live, "tu_q", { Pick: "B" })).toBe(true);

  // Past the question window itself, the same live pid can only be recycled.
  const dead = "q-recycled-dead";
  writeFileSync(
    `${PENDING_DIR}/${dead}.json`,
    JSON.stringify({
      sessionId: dead,
      kind: "question",
      tool_use_id: "tu_q",
      ts: Date.now() - 14_500_000, // past the 4h question window + slack
      pid: process.pid, // alive, but cannot be the original holder
    }),
  );
  expect(decideQuestion(dead, "tu_q", { Pick: "B" })).toBe(false);
});

test("listPendingApprovals skips and reaps an approval whose hook process is gone", async () => {
  const id = "sess-abandoned";
  writeFileSync(
    `${PENDING_DIR}/${id}.json`,
    JSON.stringify({ sessionId: id, ts: Date.now(), pid: await deadPid(), tool: "Bash", tool_use_id: "tu_9" }),
  );
  expect(listPendingApprovals()).toEqual([]);
  expect(existsSync(`${PENDING_DIR}/${id}.json`)).toBe(false);
});

test("declineQuestion returns false when no matching hold (absent or mismatched tool_use_id)", () => {
  expect(declineQuestion("q-absent", "tu_q")).toBe(false);
  const id = "q-decline-mismatch";
  writeFileSync(
    `${PENDING_DIR}/${id}.json`,
    JSON.stringify({ sessionId: id, kind: "question", tool_use_id: "tu_other" }),
  );
  expect(declineQuestion(id, "tu_q")).toBe(false);
  expect(existsSync(`${DECISIONS_DIR}/${id}.json`)).toBe(false);
});

test("listPendingApprovals skips kind:question records (they're not approvals)", () => {
  writeFileSync(
    `${PENDING_DIR}/q-only.json`,
    JSON.stringify({ sessionId: "q-only", kind: "question", tool_use_id: "tu_q", tool: "AskUserQuestion" }),
  );
  expect(listPendingApprovals()).toEqual([]);
});

test("listPendingApprovals enriches `input` from the logged PreToolUse event", () => {
  const id = "sess-pending";
  // The shell writes a MINIMAL record — no `input`.
  writeFileSync(
    `${PENDING_DIR}/${id}.json`,
    JSON.stringify({ sessionId: id, ts: 123, tool: "Bash", tool_use_id: "tu_9" }),
  );
  // The full tool_input lives only in the event log.
  const pre: HookEvent = {
    session_id: id,
    hook_event_name: "PreToolUse",
    transcript_path: "x",
    cwd: "/tmp",
    tool_name: "Bash",
    tool_use_id: "tu_9",
    tool_input: { command: "rm -rf /tmp/x" },
  };
  writeFileSync(eventLogPath(id), JSON.stringify(pre) + "\n");

  const pending = listPendingApprovals();
  expect(pending).toHaveLength(1);
  expect(pending[0].sessionId).toBe(id);
  expect(pending[0].tool).toBe("Bash");
  expect(pending[0].tool_use_id).toBe("tu_9");
  expect(pending[0].input).toEqual({ command: "rm -rf /tmp/x" });
});

test("listPendingApprovals returns [] when the dir is absent", () => {
  rmSync(PENDING_DIR, { recursive: true, force: true });
  expect(listPendingApprovals()).toEqual([]);
});

test("reapDeadSessionFiles removes dead ids across all dirs, keeps live", () => {
  writeFileSync(eventLogPath("live"), "{}\n");
  writeFileSync(eventLogPath("dead"), "{}\n");
  writeFileSync(`${PENDING_DIR}/live.json`, "{}");
  writeFileSync(`${PENDING_DIR}/dead.json`, "{}");
  writeFileSync(`${DECISIONS_DIR}/live.json`, "{}");
  writeFileSync(`${DECISIONS_DIR}/dead.json`, "{}");

  reapDeadSessionFiles(new Set(["live"]));

  expect(existsSync(eventLogPath("live"))).toBe(true);
  expect(existsSync(`${PENDING_DIR}/live.json`)).toBe(true);
  expect(existsSync(`${DECISIONS_DIR}/live.json`)).toBe(true);
  expect(existsSync(eventLogPath("dead"))).toBe(false);
  expect(existsSync(`${PENDING_DIR}/dead.json`)).toBe(false);
  expect(existsSync(`${DECISIONS_DIR}/dead.json`)).toBe(false);
});

test("reapDeadSessionFiles leaves in-flight `.tmp` files alone (Stop-hook trim race)", () => {
  // The Stop hook trims an over-budget log via `tail > <id>.jsonl.tmp && mv`.
  // The reaper must not delete the temp mid-rename — `<id>` is live, and the
  // temp name is not a session id, so it must be skipped, not reaped.
  const tmp = `${eventLogPath("live")}.tmp`;
  writeFileSync(tmp, "{}\n");

  reapDeadSessionFiles(new Set(["live"]));

  expect(existsSync(tmp)).toBe(true);
});
