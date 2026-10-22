# 31. Dialogs covering the input box are surfaced and answered, never typed into

Date: 2026-09-29
Status: accepted; amended 2026-09-29 (dialogs over a running turn surface too)

How dialogs are detected, carded and answered:
[docs/questions-and-dialogs.md](../questions-and-dialogs.md).

## Context

Claude Code 2.1.284 asks before switching model on a conversation whose prompt cache is
warm: a "Switch model? … the full history gets re-read on your next message" dialog with
"1. Yes, switch to …" / "2. No, go back". It replaces the input box until answered.

A real session hit it from portkey. The switcher polled for "Set model to …", returned
`no-confirm`, and left the dialog up. Every later send then took the last `❯` row on screen
as "the input". With the box gone, that was the echoed prompt above the dialog. The send
read it as a draft, walked the kill keys into the dialog, and aborted with
`draft-stash-failed`. The Home row flagged `approval` (the dialog's "1. Yes" matched the
permission-prompt scrape), but the conversation had no card to render because no tool call
was pending. The session couldn't be answered from the phone. Lab-verified on the same
build:

- With no `❯` row on screen at all, a send types straight into the dialog. The message "try
  1 thing" confirmed the switch (the digit) and saved the new model as the global default.
- Claude Code has many such dialogs, and its native status reports them all as `waiting`,
  with only a coarse label to tell them apart.

## Decision

- **Never type into a dialog.** The input box is the framed prompt row (a rule above, a
  closing rule below). Every path that types into the pane checks for it before sending any
  key, and refuses with `no-input-box` if it's missing.
- **A dialog means Claude is blocked on the user and nothing else explains it.** No open
  question and no pending tool approval, but a dialog parsed off the pane. It renders as a
  card with Claude's own wording and options. This also covers a dialog over a running turn
  (a `/model` confirm typed mid-turn, a Mac-side picker), because Claude keeps reporting
  `busy` until the turn ends. Gating on `waiting` alone left the confirm unanswerable for the
  rest of the turn, which then ran on the old model.
- **Answers are pinned to the label the phone showed.** A pick re-reads the dialog and
  refuses `stale-dialog` unless that option still carries that label. It moves the cursor by
  the exact delta and presses Enter only when the cursor verifiably sits on it. Digits are
  never used, because they select only on numbered lists and lists wrap. Dismiss is Escape.

## Consequences

- New Claude Code dialogs need no code: anything bordered, listed and waiting renders as a
  card with Claude's own wording.
- A waiting session whose screen doesn't parse gets no card and no badge; it still shows as
  waiting. If its input box is hidden too, sends refuse `no-input-box` rather than typing
  blind.
- A parked job's dialog isn't surfaced.
- Detection depends on how Claude Code draws its screen. Lab captures in
  `test/fixtures/viewport/` pin each shape.
