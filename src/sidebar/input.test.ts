import { describe, expect, test } from "bun:test";
import { parseInput } from "./input";

describe("parseInput", () => {
  test("plain keys, case → shift flag", () => {
    expect(parseInput("j")).toEqual([{ type: "key", name: "j", ch: "j", shift: false }]);
    expect(parseInput("J")).toEqual([{ type: "key", name: "j", ch: "J", shift: true }]);
    expect(parseInput("?")).toEqual([{ type: "key", name: "?", ch: "?", shift: false }]);
  });

  test("enter, backspace, ctrl-c, tab", () => {
    expect(parseInput("\r")).toEqual([{ type: "key", name: "enter" }]);
    expect(parseInput("\x7f")).toEqual([{ type: "key", name: "backspace" }]);
    expect(parseInput("\x03")).toEqual([{ type: "key", name: "c", ctrl: true }]);
    expect(parseInput("\t")).toEqual([{ type: "key", name: "tab" }]);
  });

  test("lone ESC is the escape key; arrows decode", () => {
    expect(parseInput("\x1b")).toEqual([{ type: "key", name: "escape" }]);
    expect(parseInput("\x1b[A")).toEqual([{ type: "key", name: "up" }]);
    expect(parseInput("\x1b[B")).toEqual([{ type: "key", name: "down" }]);
  });

  test("shift+arrows (CSI 1;2) carry the shift flag; other modifiers don't", () => {
    expect(parseInput("\x1b[1;2A")).toEqual([{ type: "key", name: "up", shift: true }]);
    expect(parseInput("\x1b[1;2B")).toEqual([{ type: "key", name: "down", shift: true }]);
    // Alt (1;3) / Ctrl (1;5) arrows stay plain moves rather than section jumps.
    expect(parseInput("\x1b[1;5A")).toEqual([{ type: "key", name: "up" }]);
  });

  test("SGR mouse: button-0 press = click, release ignored, wheel decodes", () => {
    expect(parseInput("\x1b[<0;12;5M")).toEqual([{ type: "click", x: 12, y: 5 }]);
    expect(parseInput("\x1b[<0;12;5m")).toEqual([]);
    expect(parseInput("\x1b[<64;1;1M")).toEqual([{ type: "wheel", dir: -1 }]);
    expect(parseInput("\x1b[<65;1;1M")).toEqual([{ type: "wheel", dir: 1 }]);
    // motion (32) and other buttons are noise
    expect(parseInput("\x1b[<35;3;3M")).toEqual([]);
    expect(parseInput("\x1b[<2;3;3M")).toEqual([]);
  });

  test("focus reporting", () => {
    expect(parseInput("\x1b[I")).toEqual([{ type: "focus", in: true }]);
    expect(parseInput("\x1b[O")).toEqual([{ type: "focus", in: false }]);
  });

  test("mixed stream stays ordered", () => {
    const evs = parseInput("\x1b[I\x1b[<0;4;7Mjk\r");
    expect(evs.map((e) => e.type)).toEqual(["focus", "click", "key", "key", "key"]);
  });
});
