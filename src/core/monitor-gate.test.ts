import "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { PATHS } from "./config";
import { MIN_TICK_GAP_MS, parseFocus, recentTickOutput, recordTick, type Focus } from "./monitor-gate";

const NATIVE = `${PATHS.dir}/test-native-sessions`;
const T0 = 1_000_000_000_000; // ms; status files are dated relative to it

beforeEach(() => {
  rmSync(`${PATHS.dir}/last-tick.json`, { force: true });
  rmSync(NATIVE, { recursive: true, force: true });
  mkdirSync(NATIVE, { recursive: true });
  statusFile("1.json", T0 - 60_000); // an old, unchanged status file
});

function statusFile(name: string, mtimeMs: number): void {
  writeFileSync(`${NATIVE}/${name}`, "{}");
  utimesSync(`${NATIVE}/${name}`, mtimeMs / 1000, mtimeMs / 1000);
}

const focus = (window: string, windowName = "c0/x", activity = 0): Focus => ({ activity, window, windowName });
const gate = (f: Focus | null, now: number) => recentTickOutput(f, now, NATIVE);

test("no recorded tick → null (run a full tick)", () => {
  expect(gate(focus("main:1"), T0)).toBeNull();
});

test("nothing changed since a recent tick → its output is reprinted", () => {
  recordTick("main:1", "⚡ 2 🔄 6", T0);
  expect(gate(focus("main:1"), T0 + MIN_TICK_GAP_MS - 1)).toBe("⚡ 2 🔄 6");
});

test("an empty status is still reprinted, and no client matches a tick that saw none", () => {
  recordTick("", "", T0);
  expect(gate(null, T0 + 100)).toBe("");
});

test("a focus change ticks at once", () => {
  recordTick("main:1", "⚡ 1", T0);
  expect(gate(focus("main:2"), T0 + 100)).toBeNull();
});

test("a Claude status file rewritten since the tick started ticks at once (⚡/push latency)", () => {
  recordTick("main:1", "🔄 1", T0);
  statusFile("2.json", T0 + 50);
  expect(gate(focus("main:1"), T0 + 100)).toBeNull();
});

test("a ⚡ on the focused window ticks while the user is present (auto-clear pending), not while away", () => {
  recordTick("main:1", "⚡ 1", T0);
  const nowSec = (T0 + 100) / 1000;
  expect(gate(focus("main:1", "⚡c0/x", nowSec - 5), T0 + 100)).toBeNull();
  expect(gate(focus("main:1", "⚡c0/x", nowSec - 3600), T0 + 100)).toBe("⚡ 1");
});

test("a tick MIN_TICK_GAP_MS old (or from the future) is stale", () => {
  recordTick("main:1", "🔄 1", T0);
  expect(gate(focus("main:1"), T0 + MIN_TICK_GAP_MS)).toBeNull();
  expect(gate(focus("main:1"), T0 - 1)).toBeNull();
});

test("parseFocus picks the most recently active client; window_name is the free-text tail", () => {
  expect(parseFocus("100 main:1 old\n200 main:3 ⚡c0/fix the thing\n")).toEqual({
    activity: 200,
    window: "main:3",
    windowName: "⚡c0/fix the thing",
  });
  expect(parseFocus("")).toBeNull();
});
