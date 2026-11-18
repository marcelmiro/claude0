import { describe, expect, test } from "bun:test";
import { replacesDraft } from "./mac-draft";

describe("replacesDraft", () => {
  test("the same text replaces the draft at any length, whitespace ignored", () => {
    expect(replacesDraft("yes", "yes")).toBe(true);
    expect(replacesDraft("fix the retry logic", "fix the retry\nlogic")).toBe(true);
  });

  test("the draft followed by more replaces it once the draft is long enough", () => {
    expect(replacesDraft("fix the retry logic", "fix the retry logic and add a test")).toBe(true);
    expect(replacesDraft("yes", "yes, and also ship it")).toBe(false);
  });

  test("a different or edited message leaves the draft to the stash", () => {
    expect(replacesDraft("fix the retry logic", "fix the retry budget")).toBe(false);
    expect(replacesDraft("fix the retry logic and add a test", "fix the retry logic")).toBe(false);
    expect(replacesDraft("", "anything")).toBe(false);
  });
});
