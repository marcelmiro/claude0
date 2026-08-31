import { expect, test } from "bun:test";
import { replacedInPane } from "./inbox-discovery";
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
