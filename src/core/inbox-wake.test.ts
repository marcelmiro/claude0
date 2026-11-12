import { describe, expect, test } from "bun:test";
import { dueWakes, shellQuote } from "./inbox-wake";
import type { DispositionRow } from "./inbox-store";

const NOW = 1_000_000;

function snoozed(id: string, until: number, over: Partial<DispositionRow> = {}): [string, DispositionRow] {
  return [id, { sessionId: id, kind: "snoozed", until, note: null, createdAt: NOW - 5_000, autoResumed: false, deviceId: null, ...over }];
}

describe("dueWakes", () => {
  test("due = snoozed, past until, unclaimed, not archived, no live pane", () => {
    const disp = new Map([
      snoozed("due", NOW - 1),
      snoozed("exactly-now", NOW),
      snoozed("future", NOW + 1),
      snoozed("claimed", NOW - 1, { autoResumed: true }),
      snoozed("archived", NOW - 1),
      snoozed("live", NOW - 1),
      ["blocked", { sessionId: "blocked", kind: "blocked" as const, until: null, note: "x", createdAt: 0, autoResumed: false, deviceId: null }] as [string, DispositionRow],
    ]);
    const woken = dueWakes(disp, new Map([["archived", NOW - 100]]), new Set(["live"]), NOW);
    expect(woken.map((w) => w.sessionId).sort()).toEqual(["due", "exactly-now"]);
    expect(woken[0]!.snoozedAt).toBe(NOW - 5_000);
  });

  test("the setter device rides along, so the wake push can target it", () => {
    const disp = new Map([
      snoozed("phone-set", NOW - 1, { deviceId: "dev-1" }),
      snoozed("mac-set", NOW - 1),
    ]);
    const woken = dueWakes(disp, new Map(), new Set(), NOW);
    expect(woken.find((w) => w.sessionId === "phone-set")!.deviceId).toBe("dev-1");
    expect(woken.find((w) => w.sessionId === "mac-set")!.deviceId).toBeNull();
  });

  test("the wake prompt rides along; a plain snooze has none", () => {
    const disp = new Map([snoozed("prompted", NOW - 1, { note: "check the run" }), snoozed("plain", NOW - 1)]);
    const woken = dueWakes(disp, new Map(), new Set(), NOW);
    expect(woken.find((w) => w.sessionId === "prompted")!.wakePrompt).toBe("check the run");
    expect(woken.find((w) => w.sessionId === "plain")!.wakePrompt).toBeNull();
  });

  test("shellQuote survives quotes and shell metacharacters", async () => {
    const prompt = `it's $HOME; \`id\` "x" && echo pwned`;
    expect((await Bun.$`sh -c ${`printf %s ${shellQuote(prompt)}`}`.text())).toBe(prompt);
  });

  test("empty inputs wake nothing", () => {
    expect(dueWakes(new Map(), new Map(), new Set(), NOW)).toEqual([]);
  });
});
