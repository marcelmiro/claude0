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

  test("line-editing ctrl keys decode by name; other control bytes stay dropped", () => {
    expect(parseInput("\x15")).toEqual([{ type: "key", name: "u", ctrl: true }]);
    expect(parseInput("\x17")).toEqual([{ type: "key", name: "w", ctrl: true }]);
    expect(parseInput("\n")).toEqual([{ type: "key", name: "j", ctrl: true }]); // LF is ^J, not Enter
    expect(parseInput("\x0b")).toEqual([{ type: "key", name: "k", ctrl: true }]);
    expect(parseInput("\x04")).toEqual([{ type: "key", name: "d", ctrl: true }]); // preview half-page
    expect(parseInput("\x07")).toEqual([]); // ^G must never act as g
    expect(parseInput("\x0e")).toEqual([]); // nor ^N as n
  });

  test("lone ESC is the escape key; arrows decode", () => {
    expect(parseInput("\x1b")).toEqual([{ type: "key", name: "escape" }]);
    expect(parseInput("\x1b[A")).toEqual([{ type: "key", name: "up" }]);
    expect(parseInput("\x1b[B")).toEqual([{ type: "key", name: "down" }]);
    expect(parseInput("\x1b[5~")).toEqual([{ type: "key", name: "pageup" }]);
    expect(parseInput("\x1b[6~")).toEqual([{ type: "key", name: "pagedown" }]);
  });

  test("shift+arrows (CSI 1;2) carry the shift flag; other modifiers don't", () => {
    expect(parseInput("\x1b[1;2A")).toEqual([{ type: "key", name: "up", shift: true }]);
    expect(parseInput("\x1b[1;2B")).toEqual([{ type: "key", name: "down", shift: true }]);
    // Alt (1;3) / Ctrl (1;5) arrows stay plain moves rather than section jumps.
    expect(parseInput("\x1b[1;5A")).toEqual([{ type: "key", name: "up" }]);
  });

  test("ctrl+shift+j/k decode from both extended-key formats; other extended keys drop", () => {
    const J = [{ type: "key" as const, name: "j", ctrl: true, shift: true }];
    const K = [{ type: "key" as const, name: "k", ctrl: true, shift: true }];
    expect(parseInput("\x1b[74;6u")).toEqual(J); // tmux 3.4, verified with send-keys C-S-j
    expect(parseInput("\x1b[75;6u")).toEqual(K);
    expect(parseInput("\x1b[106;6u")).toEqual(J);
    expect(parseInput("\x1b[27;6;74~")).toEqual(J);
    expect(parseInput("\x1b[27;6;107~")).toEqual(K);
    expect(parseInput("\x1b[106;5u")).toEqual([]); // ctrl only: never a bare j
    expect(parseInput("\x1b[13;2u")).toEqual([]);
    expect(parseInput("\x1b[71;6u")).toEqual([]);
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
