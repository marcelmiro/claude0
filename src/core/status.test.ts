/**
 * Characterization test for the scroll-up status bug (Contract C — only this
 * row kept for MVP).
 *
 * This PINS the current buggy behavior; it does NOT fix it. When the user
 * scrolls up mid-run, Claude's TUI keeps the `❯` prompt but swaps the spinner
 * line for "Jump to bottom (ctrl+End) ↓", so `detectStatus` finds no spinner and
 * falls through to `ready` even though the process is running.
 *
 * `fixture()` returns RAW file text; `detectStatus` needs ANSI-stripped input,
 * so the `.plain.txt` variants are used.
 *
 * TEMPORARY: these assertions encode buggy output. When Impl #2 makes
 * `event-status` the primary status source, this test must be deleted or
 * inverted (the scroll-up case should become `running`). It is Impl #2's job to
 * do so — do not "fix" it here.
 */

import { test, expect } from "bun:test";
import { detectStatus, isPermissionPrompt } from "./status";
import { fixture } from "../../test/helpers/fixture";

test("scroll-up viewport is misread as ready (the bug Impl #2 migrates away from)", () => {
  const scrolled = fixture("viewport/running-scrolled-up.plain.txt");
  expect(detectStatus(scrolled, true).status).toBe("ready");
});

test("non-scrolled running viewport is correctly read as running (control)", () => {
  const running = fixture("viewport/running.plain.txt");
  expect(detectStatus(running, true).status).toBe("running");
});

// isPermissionPrompt — gates surfacing an ATTACHED session's tool approval to the phone.
test("detects an on-screen tool permission prompt", () => {
  const prompt = fixture("viewport/permission-prompt.plain.txt");
  expect(isPermissionPrompt(prompt)).toBe(true);
});

test("a running viewport is not a permission prompt (no false approve card)", () => {
  const running = fixture("viewport/running.plain.txt");
  expect(isPermissionPrompt(running)).toBe(false);
});

test("AskUserQuestion checkbox UI is excluded (it has its own answer path)", () => {
  // The ☐ checkbox marker is the AskUserQuestion tell; Enter/Escape must not hijack it.
  const question = "Do you want to proceed?\n ☐ Option A\n ☐ Option B\n ← ☐ → to select";
  expect(isPermissionPrompt(question)).toBe(false);
});

test("stale 'do you want to' text in scrollback (not near the bottom) does not trigger", () => {
  const scrollback =
    "  Do you want to proceed?\n" +
    Array.from({ length: 25 }, (_, i) => `  output line ${i}`).join("\n") +
    "\n❯ ";
  expect(isPermissionPrompt(scrollback)).toBe(false);
});

test("an open AskUserQuestion picker reads as waiting, even with its ☐ header scrolled past the bottom 15 rows", () => {
  expect(detectStatus(fixture("viewport/ask-user-question.plain.txt"), true).status).toBe("waiting");
});

test("a running todo list's ☐ rows are not a question picker", () => {
  const todo =
    "✳ Rebasing… (12s)\n" +
    "  ⎿  ☐ Move the picker check\n" +
    "     ☐ Run the suite\n" +
    "────────────────────────────────────────\n" +
    "❯ \n" +
    "────────────────────────────────────────\n";
  expect(detectStatus(todo, true).status).toBe("running");
});
