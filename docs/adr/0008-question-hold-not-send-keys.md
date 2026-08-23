# 8. Questions stay hook-held; the send-keys redesign is rejected

Date: 2026-07-22
Status: accepted

## Context

The AskUserQuestion hook-hold was designed against a native widget that auto-resolved
after ~60s, so a phone user could never beat the timer. Live testing on Claude Code
2.1.217 shows that world is gone:

- The native picker **no longer times out** (left ~3 min unanswered, still interactive;
  a `send-keys` answer after 3 min landed as a real answer).
- The picker now has **"Type something." and "Chat about this" built in** as numbered
  rows after the real options.
- A **lone digit submits** a single-select option — index-based, no Enter, atomic at
  the pty.

That reopened an attractive design: drop the hold entirely, always render the native
picker, and let the phone answer purely by keystrokes — both surfaces live, first
answer wins. Adversarial testing killed its strong form:

- **multiSelect**: digits *toggle* checkboxes and Enter toggles too; submitting takes
  navigating to a review screen where the wrong digit (`2`) cancels the whole call.
- **Multi-question**: per-question digits auto-advance but a trailing confirm is
  required; blind sequences leave the call unsubmitted.
- **Free-text focus trap**: with the desk cursor on "Type something." (an inline
  input), an injected digit becomes typed text — reproduced end-to-end recording a
  garbage answer the agent then followed.
- **Straggler digits are not inert**: a late phone keystroke landing after the picker
  resolved can hit a *permission prompt* (also digit-actionable) and approve a shell
  command; at minimum it pollutes the composer.
- Two same-flush keystrokes can coalesce (`"12"`) into a no-op both senders believe
  succeeded.

Sound keystroke driving therefore needs a picker-state parser, a checked multi-step
driver, and post-verification — a state machine keyed to Claude Code's TUI *rendering*,
the same viewport-coupling this project already retreated from (ADR 6 territory: hooks +
JSONL over scraping).

## Decision

Keep the file-IPC hook-hold as the phone's answer channel — race-free by construction,
supports every question shape — and fix its real defects instead:

1. **Focus-release**: the hold's poll loop releases the moment the user is back at the
   Mac (active window + attached client + Ghostty frontmost), so the native picker
   renders in front of them within ~1s. Release polarity fails toward *holding*;
   the intercept gate's polarity fails toward *native* — same probes, opposite defaults.
2. **4h question window** (`QUESTION_HOLD_MS`), split from the 600s approval window and
   registered as a separate matcher-scoped PreToolUse hook so a hung *approval* hook
   stays killable at ~10 min.
3. **Clarify works un-held**: the phone's "Chat about this" on a fallen-through picker
   sends the picker's own chat-row digit — read from the rendered capture, pre-flighted
   against permission prompts and the free-text focus trap, with Escape as the
   copy-changed fallback. One keystroke, so the atomicity result above applies.

Option answering on a native picker keeps the existing pre-flighted `send-keys`
fallback (single-select digits; multiSelect via the sequential driver that confirms the
review screen from the live pane).

## Consequences

- At the Mac: native picker always, untouched. Away: full phone UX indefinitely, and
  walking back mid-question surfaces the picker immediately. First answer wins in every
  ordering, time-multiplexed by presence rather than by racing keystrokes.
- The `not-held` failure ("prompt moved to the desk") disappears.
- The empirical findings above are version-pinned to 2.1.217 — if a future Claude
  reintroduces a widget timer, the hold still covers the away case; if picker copy
  changes, `chatRowKey` degrades to Escape.
- A held question is one idle `claude0 question-hook` process for up to 4h; dead-pid
  reaping (existing) cleans markers if it's killed.
