import { test, expect, describe } from "bun:test";
import { shellQuote } from "./launch-command";

describe("shellQuote", () => {
  test("leaves safe chars (incl. branch slashes) unquoted", () => {
    expect(shellQuote("cursor/ev-4-x")).toBe("cursor/ev-4-x");
    expect(shellQuote("/tmp/proj/c0-x")).toBe("/tmp/proj/c0-x");
  });
  test("single-quotes anything with shell metachars", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("x;rm -rf /")).toBe("'x;rm -rf /'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
