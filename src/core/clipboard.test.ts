/**
 * OSC 52 framing is all-or-nothing: a mis-doubled ESC or wrong terminator makes the
 * terminal swallow the write with no error anywhere. The exact byte shapes are pinned
 * here, including the tmux DCS passthrough envelope and the size refusal.
 */
import { test, expect } from "bun:test";
import { osc52Sequence, OSC52_MAX_TEXT_BYTES, MOSH_OSC_STRING_MAX } from "./clipboard";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

test("bare sequence: OSC 52 with the c selector, BEL-terminated", () => {
  expect(osc52Sequence("hello", false)).toBe(`\x1b]52;c;${b64("hello")}\x07`);
});

test("inside tmux: DCS envelope with doubled interior ESC, closed by ESC backslash", () => {
  const inner = `\x1b]52;c;${b64("hi")}\x07`;
  expect(osc52Sequence("hi", true)).toBe(`\x1bPtmux;\x1b\x1b]52;c;${b64("hi")}\x07\x1b\\`);
  // Exactly the inner sequence's ESCs are doubled — no others introduced.
  expect(osc52Sequence("hi", true)).toBe(`\x1bPtmux;${inner.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`);
});

test("multi-byte text is measured in bytes, encoded as UTF-8", () => {
  const s = "héllo→🌍";
  expect(osc52Sequence(s, false)).toBe(`\x1b]52;c;${b64(s)}\x07`);
});

test("oversized text is refused, boundary is inclusive", () => {
  expect(osc52Sequence("x".repeat(OSC52_MAX_TEXT_BYTES), false)).not.toBeNull();
  expect(osc52Sequence("x".repeat(OSC52_MAX_TEXT_BYTES + 1), false)).toBeNull();
  // Byte budget, not code points: a 4-byte emoji spends 4.
  expect(osc52Sequence("🌍".repeat(OSC52_MAX_TEXT_BYTES / 4 + 1), false)).toBeNull();
});

test("the largest accepted write fits mosh's OSC string limit whole", () => {
  // mosh buffers everything between ESC ] and BEL.
  const oscString = (text: string) => `52;c;${b64(text)}`;
  expect(oscString("x".repeat(OSC52_MAX_TEXT_BYTES)).length).toBeLessThanOrEqual(MOSH_OSC_STRING_MAX);
  expect(oscString("x".repeat(OSC52_MAX_TEXT_BYTES + 1)).length).toBeGreaterThan(MOSH_OSC_STRING_MAX);
});
