import { describe, expect, test } from "bun:test";
import { orderInboxRows, type DiscoverySeen } from "./inbox-payload";
import type { InboxSession } from "../core/inbox-model";

const NOW = new Date(2026, 7, 11, 14, 30).getTime();
const H = 3_600_000;
const D = 86_400_000;

function sess(over: Partial<InboxSession>): InboxSession {
  return { id: "x", repo: "claude0", name: "n", reason: "turn-done", since: NOW - H, ...over };
}

function seen(over: Partial<DiscoverySeen> = {}): DiscoverySeen {
  return { status: "ready", live: true, needsYou: false, ...over };
}

describe("orderInboxRows", () => {
  test("sections emit in needs-you → running → parked → done order with meta", () => {
    const rows = orderInboxRows(
      [
        sess({ id: "done1", archivedAt: NOW - H }),
        sess({ id: "park-snz", disposition: { kind: "snoozed", until: NOW + 2 * H } }),
        sess({ id: "park-blk", disposition: { kind: "blocked", note: "waiting on keys" } }),
        sess({ id: "run", running: { finishAt: NOW + H } }),
        sess({ id: "needs" }),
      ],
      new Map(),
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(["needs", "run", "park-snz", "park-blk", "done1"]);
    expect(rows[0]!.meta).toEqual({ section: "needs-you", since: NOW - H });
    expect(rows[2]!.meta.wakeAt).toBe(NOW + 2 * H);
    expect(rows[3]!.meta.note).toBe("waiting on keys");
    expect(rows[4]!.meta.since).toBe(NOW - H); // done rows age from archivedAt
  });

  test("a woken snooze files under needs-you with the woken mark, since = the wake moment", () => {
    const rows = orderInboxRows(
      [sess({ id: "woke", disposition: { kind: "snoozed", until: NOW - 5 * 60_000 } })],
      new Map(),
      NOW,
    );
    expect(rows[0]!.meta).toEqual({ section: "needs-you", since: NOW - 5 * 60_000, woken: true });
  });

  test("a script-waiting running row ages from the script handover, like the sidebar", () => {
    const rows = orderInboxRows(
      [
        sess({ id: "scr", running: { finishAt: Number.MAX_SAFE_INTEGER }, script: true, scriptSince: NOW - 10 * 60_000 }),
        sess({ id: "turn", running: { finishAt: Number.MAX_SAFE_INTEGER } }),
      ],
      new Map(),
      NOW,
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r.meta.since]));
    expect(by["scr"]).toBe(NOW - 10 * 60_000);
    expect(by["turn"]).toBe(NOW - H);
  });

  test("a services-only ⏳ row is Needs You, aged from its turn end", () => {
    const rows = orderInboxRows([sess({ id: "svc", since: NOW - 10 * 60_000, script: true })], new Map(), NOW);
    expect(rows[0]!.meta).toEqual({ section: "needs-you", since: NOW - 10 * 60_000 });
  });

  test("a wait released by the cap is Needs You, aged from its turn end, not its wait anchor", () => {
    const rows = orderInboxRows([sess({ id: "cap", since: NOW - 3 * H, script: true, scriptSince: NOW - 3 * H + 1 })], new Map(), NOW);
    expect(rows[0]!.meta).toEqual({ section: "needs-you", since: NOW - 3 * H });
  });

  test("archived >24h is History — dropped entirely", () => {
    const rows = orderInboxRows([sess({ id: "old", archivedAt: NOW - D - 1 })], new Map(), NOW);
    expect(rows).toEqual([]);
  });

  test("discovery-only newborns append within their section, since = now", () => {
    const rows = orderInboxRows(
      [sess({ id: "needs" }), sess({ id: "run", running: { finishAt: NOW + H } })],
      new Map([
        ["born-run", seen({ status: "running" })],
        ["born-ready", seen({ status: "ready" })],
        ["born-wait", seen({ status: "waiting" })],
      ]),
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(["needs", "born-ready", "born-wait", "run", "born-run"]);
    expect(rows[1]!.meta).toEqual({ section: "needs-you", since: NOW });
    expect(rows[1]!.snapshot).toBeUndefined();
  });

  test("a newborn with a discovery age anchor keeps it, so recomputes stay byte-stable", () => {
    const rows = orderInboxRows(
      [],
      new Map([["born", seen({ status: "ready", since: NOW - 5 * 60_000 })]]),
      NOW,
    );
    expect(rows[0]!.meta).toEqual({ section: "needs-you", since: NOW - 5 * 60_000 });
  });

  test("discovery ids already in the inbox are never duplicated as newborns", () => {
    const rows = orderInboxRows(
      [sess({ id: "a" })],
      new Map([["a", seen({ status: "running" })]]),
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    expect(rows[0]!.meta.section).toBe("needs-you"); // store wins over discovery
  });

  test("pane-less discovery rows join needs-you only via the pending/unread safeguard", () => {
    const rows = orderInboxRows(
      [],
      new Map([
        ["mislabeled", seen({ status: "archived", live: false, needsYou: true })],
        ["plain-archived", seen({ status: "archived", live: false })],
        ["idle", seen({ status: "idle" })],
      ]),
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(["mislabeled"]);
  });
});
