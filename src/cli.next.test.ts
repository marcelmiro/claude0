import { test, expect } from "bun:test";
import { nextTier } from "./cli";
import { detectStatus } from "./core/status";
import { fixture } from "../test/helpers/fixture";

const tier = (plain: string) => nextTier(plain, detectStatus(plain, true).status);

test("tool approval ranks first", () => {
  expect(tier(fixture("viewport/permission-prompt.plain.txt"))).toBe(0);
  expect(tier(fixture("viewport/permission-prompt-ask-rule.plain.txt"))).toBe(0);
});

test("AskUserQuestion ranks second, though detectStatus reads its picker as ready", () => {
  expect(tier(fixture("viewport/ask-user-question.plain.txt"))).toBe(1);
});

test("plan approval ranks third", () => {
  const plan =
    "⏺ User approved Claude's plan? no — waiting\n" +
    "────────────────────────────────────────\n" +
    " Ready to code?\n\n" +
    " Here is Claude's plan:\n" +
    "  1. Add nextTier\n  2. Rank candidates\n\n" +
    " Claude has written up a plan and is ready to execute. Would you like to proceed?\n\n" +
    " ❯ 1. Yes, and auto-accept edits\n" +
    "   2. Yes, manually approve edits\n" +
    "   3. No, keep planning\n";
  expect(tier(plan)).toBe(2);
});

test("a finished turn ranks last", () => {
  const done =
    "⏺ Done — tests pass.\n\n" +
    "✻ Crunched for 1s · done 10:17 AM\n\n" +
    "────────────────────────────────────────\n" +
    "❯ \n" +
    "────────────────────────────────────────\n" +
    "  ctx 12%\n";
  expect(tier(done)).toBe(3);
});
