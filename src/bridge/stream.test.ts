import { test, expect } from "bun:test";
import { addClient, deltaTurns, pushTranscript, removeClient, subscribe, turnKey } from "./stream";

const keys = (...texts: string[]) => texts.map((t) => turnKey({ role: "user", text: t }));

test("first push (no prior keys) is a snapshot", () => {
  expect(deltaTurns(null, keys("a"))).toEqual({ kind: "snapshot" });
});

test("pure extension appends from the prefix end", () => {
  expect(deltaTurns(keys("a", "b"), keys("a", "b", "c"))).toEqual({ kind: "append", fromIndex: 2 });
});

test("identical turn lists append zero turns (volatile-only change)", () => {
  expect(deltaTurns(keys("a", "b"), keys("a", "b"))).toEqual({ kind: "append", fromIndex: 2 });
});

test("last turn amended in place (streaming text) appends from that turn", () => {
  expect(deltaTurns(keys("a", "partial"), keys("a", "partial grown", "next"))).toEqual({
    kind: "append",
    fromIndex: 1,
  });
});

test("one-turn truncation is an append with no new turns", () => {
  expect(deltaTurns(keys("a", "b"), keys("a"))).toEqual({ kind: "append", fromIndex: 1 });
});

test("rewind (shrink past the last turn) is a snapshot", () => {
  expect(deltaTurns(keys("a", "b", "c"), keys("a"))).toEqual({ kind: "snapshot" });
});

test("branch flip (diverging prefix) is a snapshot", () => {
  expect(deltaTurns(keys("a", "b", "c"), keys("a", "x", "y", "z"))).toEqual({ kind: "snapshot" });
});

test("turnKey is stable for equal turns and differs for different ones", () => {
  const t = { role: "assistant", content: [{ type: "text", text: "hi" }] };
  expect(turnKey(t)).toBe(turnKey(structuredClone(t)));
  expect(turnKey(t)).not.toBe(turnKey({ ...t, role: "user" }));
});

// A fake SSE connection for one device: decodes every transcript frame pushed to it.
function connect(deviceId: string): { frames: () => Record<string, unknown>[]; close: () => void } {
  const out: string[] = [];
  const decoder = new TextDecoder();
  const c = { enqueue: (b: Uint8Array) => out.push(decoder.decode(b)) } as unknown as ReadableStreamDefaultController;
  addClient(c, deviceId);
  return {
    frames: () =>
      out.map((f) => JSON.parse(f.replace(/^data: /, "").trim())).filter((f) => f.type === "transcript"),
    close: () => {
      removeClient(c);
      subscribe(deviceId, null);
    },
  };
}

const turnsOf = (...texts: string[]) => texts.map((t) => ({ role: "user", text: t }));

test("subscribing with the current rev pushes a zero-turn append carrying the volatile fields", () => {
  const dev = connect("dev-held");
  subscribe("dev-held", "s1", "rev-1");
  pushTranscript("s1", { rev: "rev-1", turns: turnsOf("a", "b"), approval: { tool: "Bash" } });
  const [f] = dev.frames();
  expect(f).toMatchObject({ kind: "append", fromIndex: 2, newTurns: [], payload: { rev: "rev-1", approval: { tool: "Bash" } } });
  dev.close();
});

test("subscribing with a stale rev still gets the full snapshot", () => {
  const dev = connect("dev-stale");
  subscribe("dev-stale", "s1", "rev-0");
  pushTranscript("s1", { rev: "rev-1", turns: turnsOf("a", "b") });
  expect(dev.frames()[0]).toMatchObject({ kind: "snapshot", payload: { turns: turnsOf("a", "b") } });
  dev.close();
});

test("the held rev is consumed by the first push — later pushes delta against what was pushed", () => {
  const dev = connect("dev-next");
  subscribe("dev-next", "s1", "rev-1");
  pushTranscript("s1", { rev: "rev-1", turns: turnsOf("a") });
  pushTranscript("s1", { rev: "rev-2", turns: turnsOf("a", "b") });
  expect(dev.frames()[1]).toMatchObject({ kind: "append", fromIndex: 1, newTurns: turnsOf("b") });
  dev.close();
});
