import { expect, test } from "bun:test";
import { closedPanes, isWakePromptRun, replacedInPane } from "./inbox-discovery";
import type { DispositionRow } from "./inbox-store";
import type { InboxSession } from "./inbox-model";

const row = (id: string, paneId?: string): InboxSession => ({
  id,
  repo: "r",
  name: id,
  reason: "turn-done",
  since: 0,
  real: paneId ? { paneId, target: "main:1", status: "ready" } : undefined,
});
const current = (...rows: InboxSession[]) => new Map(rows.map((r) => [r.id, r]));

test("replacedInPane: the pane's previous session id is gone and a new id sits there → replaced (/clear)", () => {
  expect(replacedInPane([row("old", "%7")], current(row("new", "%7")))).toEqual(["old"]);
});

test("replacedInPane: same id still at the pane, or the pane simply gone (killed) → nothing", () => {
  expect(replacedInPane([row("a", "%7")], current(row("a", "%7")))).toEqual([]);
  expect(replacedInPane([row("a", "%7")], current(row("b", "%8")))).toEqual([]);
  expect(replacedInPane([row("a", "%7")], current())).toEqual([]);
});

test("replacedInPane: a pane-less previous row (parked/recent) is never a replacement candidate", () => {
  expect(replacedInPane([row("parked")], current(row("x", "%7")))).toEqual([]);
});

test("replacedInPane: a session that moved panes but is still live is not replaced", () => {
  expect(replacedInPane([row("a", "%7")], current(row("a", "%9"), row("b", "%7")))).toEqual([]);
});

test("replacedInPane: a pane that lost its id (id-less row) is not a replacement", () => {
  expect(replacedInPane([row("a", "%7")], current(row("", "%7")))).toEqual([]);
});

test("closedPanes: the previous row's pane no longer exists and the session isn't live elsewhere → closed", () => {
  expect(closedPanes([row("a", "%7")], current(), new Set(["%1"]))).toEqual(["a"]);
});

test("closedPanes: a pane that still exists is never closed — a session missing from it is a lost mapping", () => {
  expect(closedPanes([row("a", "%7")], current(), new Set(["%7"]))).toEqual([]);
  expect(closedPanes([row("a", "%7")], current(row("", "%7")), new Set(["%7"]))).toEqual([]);
});

test("closedPanes: a session that moved to another pane, or a pane-less previous row, is not closed", () => {
  expect(closedPanes([row("a", "%7")], current(row("a", "%9")), new Set(["%9"]))).toEqual([]);
  expect(closedPanes([row("parked")], current(), new Set(["%1"]))).toEqual([]);
});

const disp = (over: Partial<DispositionRow>): DispositionRow => ({
  sessionId: "s",
  kind: "snoozed",
  until: 0,
  note: null,
  createdAt: 0,
  autoResumed: true,
  deviceId: null,
  ...over,
});

test("isWakePromptRun: only a resumed prompted snooze starting to run is the wake prompt's turn", () => {
  expect(isWakePromptRun(disp({ note: "check the run" }))).toBe(true);
  // a plain wake's first run is the user's reply — it ends the woke mark
  expect(isWakePromptRun(disp({}))).toBe(false);
  // not yet resumed by the daemon (a manual resume mid-snooze), a block, or no disposition
  expect(isWakePromptRun(disp({ note: "check the run", autoResumed: false }))).toBe(false);
  expect(isWakePromptRun(disp({ kind: "blocked", until: null, note: "keys" }))).toBe(false);
  expect(isWakePromptRun(undefined)).toBe(false);
});
