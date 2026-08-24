import { describe, expect, test } from "bun:test";
import { renderView, type ViewState } from "./rows";
import { fmtWakeAbs, plainLen } from "./ansi";
import { wakeAt, type InboxSession } from "../core/inbox-model";

const NOW = new Date(2026, 7, 11, 14, 30).getTime();
const M = 60_000;
const H = 3_600_000;

function sess(over: Partial<InboxSession>): InboxSession {
  return { id: "x", repo: "claude0", name: "fix-auth", reason: "turn-done", since: NOW - H, ...over };
}

function vs(over: Partial<ViewState> = {}): ViewState {
  return {
    focused: false,
    selectedId: null,
    activePaneId: null,
    snoozeMenuFor: null,
    snoozeDigits: "",
    snoozeUnit: "t",
    blockNoteFor: null,
    blockNote: "",
    helpVisible: false,
    flash: "",
    flashUntil: 0,
    scrollTop: 0,
    ...over,
  };
}

const DIMS = { width: 30, height: 20 };

const SAMPLE = [
  sess({ id: "n1", since: NOW - 2 * H }),
  sess({ id: "n2", reason: "question", since: NOW - 10 * M }),
  sess({ id: "r1", running: { finishAt: Number.MAX_SAFE_INTEGER }, since: NOW - 5 * M, real: { paneId: "%1", target: "main:1", status: "running" } }),
  sess({ id: "p1", disposition: { kind: "snoozed", until: NOW + 3 * H } }),
  sess({ id: "d1", archivedAt: NOW - H }),
];

describe("renderView", () => {
  test("exactly height rows, every row within width", () => {
    const view = renderView(SAMPLE, vs(), DIMS, NOW);
    expect(view.rows.length).toBe(DIMS.height);
    for (const row of view.rows) {
      expect(plainLen(row)).toBeLessThanOrEqual(DIMS.width);
    }
  });

  test("wide emoji, CJK, and combining marks do not overflow a row", () => {
    const unicode = [
      sess({ id: "unicode", name: "⚡ Fix 日本 e\u0301 rendering", since: NOW - 2 * H }),
    ];
    const dims = { width: 18, height: 8 };
    const view = renderView(unicode, vs(), dims, NOW);
    expect(view.rows.length).toBe(dims.height);
    for (const row of view.rows) {
      expect(plainLen(row)).toBeLessThanOrEqual(dims.width);
    }
  });

  test("sections and rowAtLine cover both lines of a two-line row", () => {
    const view = renderView(SAMPLE, vs(), DIMS, NOW);
    expect(view.visible.map((v) => v.section)).toEqual([
      "needs-you",
      "needs-you",
      "running",
      "parked",
      "done",
    ]);
    // two-line rows map both content lines to the id
    const n1Lines = view.rowAtLine.filter((id) => id === "n1").length;
    expect(n1Lines).toBe(2);
    const p1Lines = view.rowAtLine.filter((id) => id === "p1").length;
    expect(p1Lines).toBe(1); // parked is one-line
  });

  test("unfocused = glance surface: no selection bg, empty hint row", () => {
    const view = renderView(SAMPLE, vs({ selectedId: "n1" }), DIMS, NOW);
    expect(view.rows.join("")).not.toContain("\x1b[48;2;64;64;64m");
    expect(view.rows[view.rows.length - 1]).toBe("");
  });

  test("focused: selection bg present, section hints in the bottom row", () => {
    const view = renderView(SAMPLE, vs({ focused: true, selectedId: "n1" }), DIMS, NOW);
    expect(view.rows.join("")).toContain("\x1b[48;2;64;64;64m");
    expect(view.rows[view.rows.length - 1]).toContain("s b e f");
  });

  test("snooze form: two chrome lines — unit blocks, dim placeholder 1, preview, hints", () => {
    const view = renderView(SAMPLE, vs({ focused: true, selectedId: "n1", snoozeMenuFor: "n1" }), DIMS, NOW);
    expect(view.rows.length).toBe(DIMS.height);
    const units = view.rows[view.rows.length - 2]!;
    const entry = view.rows[view.rows.length - 1]!;
    for (const label of ["8am", "day", "hr"]) expect(units).toContain(label);
    // active unit (default t) carries the selection bg
    const highlighted = units.slice(units.indexOf("\x1b[48;2;64;64;64m"), units.indexOf("\x1b[49m"));
    expect(highlighted).toContain("8am");
    // empty amount renders the overwritable default as dim 1; preview resolves it
    expect(entry).toContain("\x1b[38;2;80;80;80m1");
    // caret sits BEFORE the placeholder (insertion point — the 1 is untyped);
    // right-edge bar ▕ so the ink hugs the placeholder digit
    expect(entry.indexOf("▕")).toBeLessThan(entry.indexOf("\x1b[38;2;80;80;80m1"));
    expect(entry).toContain(fmtWakeAbs(wakeAt(NOW, 1, "t"), NOW));
    expect(entry).toContain("↵ ⎋");
    expect(plainLen(units)).toBeLessThanOrEqual(DIMS.width);
    expect(plainLen(entry)).toBeLessThanOrEqual(DIMS.width);
  });

  test("snooze form: typed digits replace the placeholder and the highlight follows the unit", () => {
    const view = renderView(
      SAMPLE,
      vs({ focused: true, selectedId: "n1", snoozeMenuFor: "n1", snoozeDigits: "3", snoozeUnit: "d" }),
      DIMS,
      NOW,
    );
    const units = view.rows[view.rows.length - 2]!;
    const entry = view.rows[view.rows.length - 1]!;
    const highlighted = units.slice(units.indexOf("\x1b[48;2;64;64;64m"), units.indexOf("\x1b[49m"));
    expect(highlighted).toContain("day");
    expect(entry).not.toContain("\x1b[38;2;80;80;80m1"); // no dim placeholder once typed
    // caret immediately after the typed digits (white 3, then peach caret)
    expect(entry).toContain("3\x1b[39m\x1b[38;2;255;199;153m▏");
    // typed digit sits in the placeholder's column: one pad cell replaces the
    // old caret cell, so the digit doesn't hop left when typing starts
    expect(entry.replace(/\x1b\[[0-9;]*m/g, "")).toContain("☾  3▏");
    expect(entry).toContain(fmtWakeAbs(NOW + 3 * 86_400_000, NOW));
  });

  test("block note chrome takes the hint row", () => {
    const note = renderView(SAMPLE, vs({ focused: true, selectedId: "n1", blockNoteFor: "n1", blockNote: "stripe" }), DIMS, NOW);
    expect(note.rows[note.rows.length - 1]).toContain("stripe");
  });

  test("selected parked row gets a detail line with the exact wake", () => {
    const view = renderView(SAMPLE, vs({ focused: true, selectedId: "p1" }), DIMS, NOW);
    // same string the shared formatter produces (locale-dependent), wired via detailFor
    expect(view.rows[view.rows.length - 2]).toContain(`until ${fmtWakeAbs(NOW + 3 * H, NOW)}`);
  });

  test("help overlay replaces content while focused", () => {
    const view = renderView(SAMPLE, vs({ focused: true, helpVisible: true }), DIMS, NOW);
    expect(view.rows.join("")).toContain("navigate");
    expect(view.rows[view.rows.length - 1]).toContain("close");
    expect(view.visible).toEqual([]);
  });

  test("narrow pane shows counts only", () => {
    const view = renderView(SAMPLE, vs(), { width: 12, height: 6 }, NOW);
    expect(view.rows.join("")).toContain("●2");
    expect(view.rows.join("")).toContain("⦿1");
    expect(view.rows.join("")).toContain("⏸1");
  });

  test("empty inbox shows inbox zero", () => {
    const view = renderView([], vs(), DIMS, NOW);
    expect(view.rows.join("")).toContain("inbox zero ✓");
  });

  test("focused selection below the fold scrolls into view", () => {
    const many = Array.from({ length: 20 }, (_, i) => sess({ id: `n${i}`, since: NOW - i * M }));
    const view = renderView(many, vs({ focused: true, selectedId: "n0" }), { width: 30, height: 10 }, NOW);
    // n0 is the YOUNGEST (needs-you sorts oldest first → last row); it must be visible
    expect(view.scrollTop).toBeGreaterThan(0);
    const contentRows = view.rows.slice(0, 9);
    expect(contentRows.join("")).toContain("\x1b[48;2;64;64;64m");
  });

  test("pin bar marks the window's active pane session", () => {
    const view = renderView(SAMPLE, vs({ activePaneId: "%1" }), DIMS, NOW);
    expect(view.rows.join("")).toContain("▎");
  });
});

test("needs-you age escalates: muted <1d, peach 1-3d, red >3d", () => {
  const D = 24 * H;
  const view = renderView(
    [sess({ id: "fresh", since: NOW - H }), sess({ id: "day", since: NOW - 30 * H }), sess({ id: "old", since: NOW - 4 * D })],
    vs(),
    DIMS,
    NOW,
  );
  const out = view.rows.join("");
  expect(out).toContain("\x1b[38;2;255;128;128m4d"); // red past 3d
  expect(out).toContain("\x1b[38;2;255;199;153m1d"); // peach at 1-3d
  expect(out).toContain("\x1b[38;2;160;160;160m1h"); // muted under 1d
});

test("prompt-sitters render under NEEDS YOU", () => {
  const view = renderView(
    [...SAMPLE, sess({ id: "o1", name: "idle-one" })],
    vs(),
    { width: 30, height: 24 },
    NOW,
  );
  expect(view.rows.join("")).toContain("idle-one");
  expect(view.visible.find((v) => v.id === "o1")?.section).toBe("needs-you");
});
