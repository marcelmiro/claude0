/**
 * Pure key-sequence builder behind `answerQuestion`. Claude's question menu is
 * numbered, so selection is by DIGIT (absolute) rather than arrow navigation —
 * verified live: batched `Down`×n dropped the arrows and picked the default option.
 */

import { test, expect } from "bun:test";
import { questionAnswerKeys, multiQuestionKeys, answerKeys, chatRowKey, freeTextRowFocused } from "./tmux";
import { questionPickerVisible } from "./status";

test("single-select presses the option's 1-based digit, then Enter to submit", () => {
  expect(questionAnswerKeys(0)).toEqual(["1", "Enter"]);
  expect(questionAnswerKeys(2)).toEqual(["3", "Enter"]);
});

test("multiSelect toggles each option's digit, then Right+Enter (Submit tab)", () => {
  // indices 1 and 3 → digits 2 and 4, then submit.
  expect(questionAnswerKeys([1, 3])).toEqual(["2", "4", "Right", "Enter"]);
});

test("multiSelect de-dupes and sorts the indices", () => {
  expect(questionAnswerKeys([3, 1, 1])).toEqual(questionAnswerKeys([1, 3]));
});

test("multiSelect at index 0 → digit 1 then submit", () => {
  expect(questionAnswerKeys([0])).toEqual(["1", "Right", "Enter"]);
});

// --- Multi-question prompts (N>1), LIVE-VERIFIED model (2026-07-01): Left×N resets to
//     Q1; single-select digit auto-advances (no Right); multi-select digit(s) + Right;
//     land on Submit, then Enter. ---

test("multiQuestionKeys: two questions (single + multi)", () => {
  // Q1 single-select index 2 → "3" (auto-advances); Q2 multi-select [0] → "1" then Right.
  expect(multiQuestionKeys([2, [0]])).toEqual([
    "Left", "Left", // reset to first question tab
    "3",             // Q1 single: selects + auto-advances to Q2
    "1", "Right",    // Q2 multi: toggle, then step onto Submit
    "Enter",         // submit
  ]);
});

test("multiQuestionKeys: all single-select — each digit auto-advances, no Right", () => {
  // Verified live: Size=idx1 "2", Speed=idx1 "2" → Medium/Fast with no explicit Right.
  expect(multiQuestionKeys([1, 1])).toEqual(["Left", "Left", "2", "2", "Enter"]);
});

test("multiQuestionKeys: empty multi-select still steps past its question", () => {
  // Q1 single-select index 0 → "1" (auto-advance); Q2 empty multi-select → just Right.
  expect(multiQuestionKeys([0, []])).toEqual(["Left", "Left", "1", "Right", "Enter"]);
});

test("multiQuestionKeys: multi-select digits are de-duped and sorted", () => {
  // Q1 multi [2,0,0] → "1","3",Right; Q2 single index 1 → "2" (auto-advance).
  expect(multiQuestionKeys([[2, 0, 0], 1])).toEqual([
    "Left", "Left", "1", "3", "Right", "2", "Enter",
  ]);
});

test("answerKeys dispatches single-question to questionAnswerKeys (no reset/extra Right)", () => {
  expect(answerKeys([2])).toEqual(questionAnswerKeys(2)); // ["3", "Enter"]
  expect(answerKeys([[0, 2]])).toEqual(questionAnswerKeys([0, 2])); // ["1","3","Right","Enter"]
});

test("answerKeys dispatches multi-question to multiQuestionKeys", () => {
  expect(answerKeys([2, [0]])).toEqual(multiQuestionKeys([2, [0]]));
});

// --- questionPickerVisible: gates the send-keys fallback on the widget being on-screen ---

// Live capture of a real single-select AskUserQuestion widget (2026-07-21).
const WIDGET_SINGLE = ` ☐ Repro
Test question 1: pick one
❯ 1. Alpha
     First test option
  2. Bravo
     Second test option
  3. Type something.
──────────────────────
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel`;

// A running pane with a todo list — ☐ glyphs present, but NO picker. The old bare-☐
// heuristic would have misread this and fired keystrokes into the spinner.
const SPINNER_WITH_TASKS = `⏺ Working through the list
  ⎿  ☐ Fix the bug
     ☐ Add the test
✽ Cranking… (12s · ↓ 1.2k tokens)
──────────────────────
❯
──────────────────────`;

const PERMISSION_PROMPT = `⏺ Bash command
   rm -rf node_modules
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again
  3. No, and tell Claude what to do differently`;

// Rewind picker footer says "Enter to continue", not "Enter to select".
const REWIND_MENU = `  Rewind
  ❯ 1. Restore code and conversation
    2. Restore conversation
  Enter to continue · Esc to cancel`;

test("questionPickerVisible: real widget capture → visible", () => {
  expect(questionPickerVisible(WIDGET_SINGLE)).toBe(true);
});

test("questionPickerVisible: spinner with ☐ task list → NOT visible", () => {
  expect(questionPickerVisible(SPINNER_WITH_TASKS)).toBe(false);
});

test("questionPickerVisible: permission prompt → NOT visible", () => {
  expect(questionPickerVisible(PERMISSION_PROMPT)).toBe(false);
});

test("questionPickerVisible: rewind menu → NOT visible", () => {
  expect(questionPickerVisible(REWIND_MENU)).toBe(false);
});

test("questionPickerVisible: multi-question nav bar → visible", () => {
  expect(questionPickerVisible("← Q1 ☐ · Q2 ✔ →")).toBe(true);
});

test("questionPickerVisible: only samples the bottom 20 lines", () => {
  const scrollback = WIDGET_SINGLE + "\n" + Array(25).fill("output line").join("\n");
  expect(questionPickerVisible(scrollback)).toBe(false);
});

// Live capture of a real multiSelect widget (2026-07-21): checkboxes render as "[ ]"
// (not ☐), so the footer is the load-bearing signal for this variant too.
const WIDGET_MULTISELECT = `Pick toppings
❯ 1. [ ] Cheese
  Add cheese
  2. [ ] Olives
  Add olives
  3. [ ] Ham
  Add ham
  4. [ ] Type something
     Submit
──────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel`;

test("questionPickerVisible: real multiSelect widget capture → visible", () => {
  expect(questionPickerVisible(WIDGET_MULTISELECT)).toBe(true);
});

test("questionPickerVisible: widget above a short pane's trailing blank rows → visible", () => {
  // A capture spans the full pane height; on a young session the widget sits at the
  // top with dozens of empty rows below it (caught live: not-presented on a real picker).
  const cap = WIDGET_SINGLE + "\n" + Array(50).fill("   ").join("\n");
  expect(questionPickerVisible(cap)).toBe(true);
});

// --- chatRowKey / freeTextRowFocused (clarify-on-native-picker pre-flight) ---

test("chatRowKey: single-question widget → the rendered chat-row digit", () => {
  expect(chatRowKey(WIDGET_SINGLE)).toBe("4");
});

test("chatRowKey: multiSelect widget (3 options) → chat row shifts to 5", () => {
  expect(chatRowKey(WIDGET_MULTISELECT)).toBe("5");
});

test("chatRowKey: permission prompt / plain pane → null", () => {
  expect(chatRowKey(PERMISSION_PROMPT)).toBeNull();
  expect(chatRowKey(SPINNER_WITH_TASKS)).toBeNull();
});

test("chatRowKey: chat row scrolled out of the bottom sample → null", () => {
  const cap = WIDGET_SINGLE + "\n" + Array(25).fill("output line").join("\n");
  expect(chatRowKey(cap)).toBeNull();
});

// Live tell (2026-07-22 adversarial run): focusing "Type something." turns the row into
// an inline input — digits type characters — and the footer gains the ctrl+g hint.
const WIDGET_FREETEXT_FOCUSED = ` ☐ Repro
Test question 1: pick one
  1. Alpha
     First test option
  2. Bravo
     Second test option
❯ 3. Type something.
──────────────────────
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel · ctrl+g to edit in Nvim`;

test("freeTextRowFocused: ctrl+g footer hint → focused (no key is safe)", () => {
  expect(freeTextRowFocused(WIDGET_FREETEXT_FOCUSED)).toBe(true);
});

test("freeTextRowFocused: ordinary option-select widget → not focused", () => {
  expect(freeTextRowFocused(WIDGET_SINGLE)).toBe(false);
  expect(freeTextRowFocused(WIDGET_MULTISELECT)).toBe(false);
});
