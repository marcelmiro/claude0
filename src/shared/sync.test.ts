import { test, expect } from "bun:test";
import { applyTranscriptEvent, overlayResolved, displaySection } from "./sync.js";

const turn = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

test("snapshot replaces wholesale", () => {
  const held = { turns: [turn("old")], rev: "1:1", openQuestion: { q: "x" } };
  const r = applyTranscriptEvent(held, {
    kind: "snapshot",
    payload: { turns: [turn("new")], rev: "2:2" },
  });
  if ("needsFetch" in r) throw new Error("expected data");
  expect(r.data.turns).toEqual([turn("new")]);
  // omitted field = cleared: the old openQuestion must not survive
  expect("openQuestion" in r.data).toBe(false);
});

test("append extends held turns and takes non-turn fields from the event", () => {
  const held = { turns: [turn("a"), turn("b")], rev: "1:1", usage: { percent: 10 } };
  const r = applyTranscriptEvent(held, {
    kind: "append",
    fromIndex: 2,
    newTurns: [turn("c")],
    payload: { rev: "2:2", usage: { percent: 12 } },
  });
  if ("needsFetch" in r) throw new Error("expected data");
  expect(r.data.turns).toEqual([turn("a"), turn("b"), turn("c")]);
  expect(r.data.rev).toBe("2:2");
  expect((r.data.usage as { percent: number }).percent).toBe(12);
});

test("append that amends the last held turn (streaming) re-applies from fromIndex", () => {
  const held = { turns: [turn("a"), turn("part")] };
  const r = applyTranscriptEvent(held, {
    kind: "append",
    fromIndex: 1,
    newTurns: [turn("partial grown"), turn("next")],
    payload: {},
  });
  if ("needsFetch" in r) throw new Error("expected data");
  expect(r.data.turns).toEqual([turn("a"), turn("partial grown"), turn("next")]);
});

test("append with empty newTurns truncates (one-turn shrink)", () => {
  const held = { turns: [turn("a"), turn("b")] };
  const r = applyTranscriptEvent(held, { kind: "append", fromIndex: 1, newTurns: [], payload: {} });
  if ("needsFetch" in r) throw new Error("expected data");
  expect(r.data.turns).toEqual([turn("a")]);
});

test("append beyond the held length falls back to a fetch", () => {
  const r = applyTranscriptEvent({ turns: [turn("a")] }, {
    kind: "append",
    fromIndex: 3,
    newTurns: [turn("d")],
    payload: {},
  });
  expect("needsFetch" in r && r.needsFetch).toBe(true);
});

test("append from 0 works with nothing held", () => {
  const r = applyTranscriptEvent(null, {
    kind: "append",
    fromIndex: 0,
    newTurns: [turn("a")],
    payload: {},
  });
  if ("needsFetch" in r) throw new Error("expected data");
  expect(r.data.turns).toEqual([turn("a")]);
});

// --- overlayResolved -------------------------------------------------------

test("running overlay: a stale 'ready' snapshot does NOT retire it (no backwards clobber)", () => {
  const o = { status: "running" as const, until: 1000 };
  expect(overlayResolved(o, "ready", 500)).toBe(false);
});

test("running overlay retires on confirmation (running or waiting)", () => {
  const o = { status: "running" as const, until: 1000 };
  expect(overlayResolved(o, "running", 500)).toBe(true);
  expect(overlayResolved(o, "waiting", 500)).toBe(true);
});

test("running overlay retires on expiry", () => {
  const o = { status: "running" as const, until: 1000 };
  expect(overlayResolved(o, "ready", 1500)).toBe(true);
});

test("ready overlay (interrupt) retires once the server leaves running", () => {
  const o = { status: "ready" as const, until: 1000 };
  expect(overlayResolved(o, "running", 500)).toBe(false);
  expect(overlayResolved(o, "ready", 500)).toBe(true);
  expect(overlayResolved(o, "waiting", 500)).toBe(true);
});

// --- displaySection ----------------------------------------------------------

test("a needs-you row whose status is running renders under Running", () => {
  expect(displaySection("needs-you", "running", 0)).toBe("running");
});

test("a needs-you prompt-sitter or approval stays put", () => {
  expect(displaySection("needs-you", "ready", 0)).toBe("needs-you");
  expect(displaySection("needs-you", "waiting", 0)).toBe("needs-you");
});

test("a running row whose turn already ended renders under Needs You", () => {
  expect(displaySection("running", "ready", 0)).toBe("needs-you");
  expect(displaySection("running", "waiting", 0)).toBe("needs-you");
});

test("script-waiters keep their Running placement (the deliberate ⏳ contradiction)", () => {
  expect(displaySection("running", "ready", 2)).toBe("running");
});

test("authored sections are never rerouted", () => {
  expect(displaySection("parked", "running", 0)).toBe("parked");
  expect(displaySection("done", "running", 0)).toBe("done");
  // pane-less projected rows carry non-live statuses — untouched
  expect(displaySection("needs-you", "archived", 0)).toBe("needs-you");
});
