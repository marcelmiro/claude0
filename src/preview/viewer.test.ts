import { describe, expect, test } from "bun:test";
import { bestMatch, findMatches, findWords, popupGeometry } from "./viewer";
import type { Doc } from "./render";

const doc = (...rows: string[]): Doc => ({ lines: rows.map((t) => ({ spans: [{ t }] })), prompts: [] });

describe("find", () => {
  test("words: whitespace-split, lowercased; single letters only when alone", () => {
    expect(findWords("Fork  Reaper")).toEqual(["fork", "reaper"]);
    expect(findWords("a fork")).toEqual(["fork"]);
    expect(findWords("a")).toEqual(["a"]);
  });

  test("matches every occurrence, in reading order", () => {
    const m = findMatches(doc("fork fork", "reaper"), ["reaper", "fork"]);
    expect(m.map((x) => [x.line, x.from])).toEqual([[0, 0], [0, 5], [1, 0]]);
  });

  test("opens at the earliest line holding the most distinct words", () => {
    const d = doc("fork", "reaper", "the fork reaper", "fork reaper again");
    const words = ["fork", "reaper"];
    const m = findMatches(d, words);
    expect(m[bestMatch(m)]!.line).toBe(2);
    expect(bestMatch([])).toBe(-1);
  });
});

describe("popupGeometry", () => {
  const geo = (width: number, height: number, statusTop = false) =>
    popupGeometry({ sidebar: 30, width, height, statusLines: 1, statusTop });

  test("text-wide, 85% tall, centred over the work area; -y is the bottom row", () => {
    // work area: columns 31..203 (173 wide), rows 0..65 (66 tall)
    expect(geo(204, 67)).toEqual(["-x", "64", "-y", "61", "-w", "106", "-h", "56"]);
  });

  test("a status line on top shifts the popup down", () => {
    expect(geo(204, 67, true)[3]).toBe("62");
  });

  test("narrower work areas shrink the popup; under 60 columns it centres at 90%", () => {
    expect(geo(120, 40)[5]).toBe("85");
    expect(geo(80, 40)).toEqual(["-x", "C", "-y", "C", "-w", "90%", "-h", "90%"]);
  });
});
