import { describe, expect, test } from "bun:test";
import type { TranscriptTurn } from "../types";
import { C } from "../sidebar/ansi";
import { fmtGap, markdown, paintLine, plain, renderTranscript, wrap } from "./render";

const NOW = new Date(2026, 10, 5, 15, 0).getTime();
const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
const text = (role: "user" | "assistant", t: string, mins?: number): TranscriptTurn => ({
  role,
  content: [{ type: "text", text: t }],
  ...(mins !== undefined ? { at: at(mins) } : {}),
});
const tool = (name: string, input: Record<string, string>, ok = true, head = ""): TranscriptTurn => ({
  role: "assistant",
  content: [{ type: "tool_use", id: name + Math.random(), name, input, result: { ok, head, lines: 1 } }],
});
const render = (turns: TranscriptTurn[], extra: { lastPromptAt?: number; cwd?: string } = {}) =>
  renderTranscript(turns, { width: 40, now: NOW, ...extra });
const lines = (turns: TranscriptTurn[], extra = {}) => render(turns, extra).lines.map(plain);

describe("wrap", () => {
  test("soft breaks drop the space they land on; hard breaks keep indentation", () => {
    expect(wrap([{ t: "aaa bbb ccc" }], 7).map((l) => l.map((s) => s.t).join(""))).toEqual(["aaa bbb", "ccc"]);
    expect(wrap([{ t: "a\n  b" }], 10).map((l) => l.map((s) => s.t).join(""))).toEqual(["a", "  b"]);
  });

  test("a word wider than the line splits", () => {
    expect(wrap([{ t: "abcdefgh" }], 3).map((l) => l.map((s) => s.t).join(""))).toEqual(["abc", "def", "gh"]);
  });
});

describe("renderTranscript grammar", () => {
  test("prompt on a band with ❯, reply with ●, prompts indexed", () => {
    const doc = render([text("user", "fix the bug"), text("assistant", "Done — **fixed**.")]);
    expect(doc.lines.map(plain)).toEqual(["❯ fix the bug", "", "● Done — fixed."]);
    expect(doc.lines[0]!.band).toBe(C.surface);
    expect(doc.prompts).toEqual([0]);
    expect(doc.lines[2]!.spans.find((s) => s.t === "fixed")?.bold).toBe(true);
  });

  test("tool calls: one line, portkey's argument, relative path; failures show their head", () => {
    const out = lines(
      [tool("Read", { file_path: "/repo/src/a.ts" }), tool("Bash", { command: "bun test\nmore" }, false, "1 fail")],
      { cwd: "/repo" },
    );
    expect(out).toEqual(["● Read src/a.ts", "", "● Bash bun test …", "  ⎿ 1 fail"]);
  });

  test("a delivery is one dim line: summary, else idle for a bare ping, else the body's first line", () => {
    const tm = (id: string, summary: string, body: string): TranscriptTurn => ({ role: "user", content: [], teammate: [{ id, summary, body }] });
    expect(
      lines([
        tm("std", "2 findings", "{}"),
        tm("ux", "", '{"type":"idle_notification"}'),
        tm("throxy-8a", "", "\nAck: watcher stopped.\n\nMore."),
      ]).filter(Boolean),
    ).toEqual(["↳ std: 2 findings", "↳ ux: idle", "↳ throxy-8a: Ack: watcher stopped."]);
  });

  test("three tool-only turns before the newest prompt fold into a tally", () => {
    const burst = [tool("Read", { file_path: "/r/a.ts" }), tool("Read", { file_path: "/r/b.ts" }), tool("Edit", { file_path: "/r/a.ts" }, false)];
    for (const [i, t] of burst.entries()) t.at = at(30 - i);
    const doc = renderTranscript([text("user", "go", 31), ...burst, text("user", "next", 10)], { width: 80, now: NOW, lastPromptAt: NOW - 10 * 60_000 });
    expect(doc.lines.map(plain)).toContain("● 3 tool calls · 1 failed · Read ×2, Edit · a.ts, b.ts");
  });

  test("the work since the newest prompt stays expanded", () => {
    const burst = [tool("Read", { file_path: "/r/a.ts" }), tool("Read", { file_path: "/r/b.ts" }), tool("Read", { file_path: "/r/c.ts" })];
    const out = lines([text("user", "go"), ...burst]);
    expect(out.filter((l) => l.startsWith("● Read"))).toHaveLength(3);
  });

  test("commands, bash, markers, compaction, answered questions", () => {
    const out = lines([
      { role: "user", content: [], command: "/pr-triage 12" },
      { role: "user", content: [], bash: { command: "ls", stdout: "a\nb\nc\nd\ne", stderr: "" } },
      text("user", "[Request interrupted by user]"),
      { role: "user", content: [{ type: "text", text: "summary" }], compactSummary: true },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "q", name: "AskUserQuestion", input: {}, qa: [{ q: "Ship?", a: "Yes" }] }],
      },
    ]);
    expect(out).toEqual([
      "❯ /pr-triage 12",
      "",
      "! ls",
      "  ⎿ a",
      "    b",
      "    c",
      "    … +2 lines",
      "",
      "⊘ Request interrupted by user",
      "",
      "────────────── compacted ──────────────",
      "",
      "● Asked: Ship?",
      "  ⎿ Yes",
    ]);
  });

  test("a gap over five minutes gets a right-aligned time label", () => {
    const doc = render([text("user", "a", 60), text("assistant", "b", 59), text("user", "c", 10)]);
    const labels = doc.lines.filter((l) => l.right).map((l) => l.right!.t);
    expect(labels).toEqual([fmtGap(NOW - 60 * 60_000, NOW), fmtGap(NOW - 10 * 60_000, NOW)]);
  });

  test("thinking is hidden", () => {
    expect(lines([{ role: "assistant", content: [{ type: "thinking", text: "hmm" }] }])).toEqual([]);
  });
});

describe("markdown", () => {
  test("lists, code on a band, aligned tables", () => {
    const md = markdown("- one\n- two\n\n```\nx = 1\n```\n\n| a | bb |\n|---|---|\n| 1 | 2 |", 30);
    expect(md.map(plain)).toEqual(["• one", "• two", "", " x = 1", "", "a  bb", "─  ──", "1  2"]);
    expect(md[3]!.band).toBe(C.surface);
  });

  test("entities are unescaped", () => {
    expect(markdown("a & b <c> 'q'", 30).map(plain)).toEqual(["a & b <c> 'q'"]);
  });
});

describe("fmtGap", () => {
  test("today, yesterday, older", () => {
    expect(fmtGap(new Date(2026, 10, 5, 9, 5).getTime(), NOW)).toBe("09:05");
    expect(fmtGap(new Date(2026, 10, 4, 13, 6).getTime(), NOW)).toBe("Yesterday 13:06");
    expect(fmtGap(new Date(2026, 7, 24, 13, 6).getTime(), NOW)).toBe("24/08 13:06");
  });
});

describe("paintLine", () => {
  test("pads to width, fills the band, highlights the current match strongest", () => {
    const line = { spans: [{ t: "hello world" }], band: C.surface };
    const out = paintLine(line, 15, [{ from: 6, to: 11, current: true }]);
    expect(Bun.stringWidth(out.replace(/\x1b\[[0-9;]*m/g, ""))).toBe(15);
    expect(out).toContain("\x1b[0;1;38;2;16;16;16;48;2;255;199;153mworld");
    expect(out).toContain("48;2;28;28;28mhello ");
  });
});
