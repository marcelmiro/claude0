# 31. Dialogs covering the input box are surfaced and answered, never typed into

Date: 2026-09-29
Status: accepted

## Context

Claude Code 2.1.284 asks before switching model on a conversation whose prompt cache is
warm: a "Switch model? … the full history gets re-read on your next message" dialog with
"1. Yes, switch to …" / "2. No, go back". It replaces the input box until answered.

A real session hit it from portkey. The switcher polled 2.4s for "Set model to …",
returned `no-confirm`, and left the dialog up. Every later send then located "the input"
as the last `❯` row on screen — with the box gone, that was the echoed prompt above the
dialog — read it as a draft, walked the kill keys into the dialog, and aborted with
`draft-stash-failed`. The Home row flagged `approval` (the dialog's "1. Yes" matched the
permission-prompt scrape) while the conversation had no card to render, since no tool call
was pending. The session was unanswerable from the phone. Lab-verified on the same build:

- With no `❯` row on screen at all, a send types straight into the dialog: the message
  "try 1 thing" confirmed the switch (the digit) and saved the new model as the global
  default.
- An earlier confirmation still on screen was returned as the new switch's success while
  its dialog was up.
- Claude Code reports every such state in `~/.claude/sessions/<pid>.json` as
  `status: "waiting"` with a `waitingFor` label. The label is a coarse bucket, not a
  discriminator: tool permission prompts and plan approval fall back to
  `"permission prompt"`, AskUserQuestion is `"input needed"` (as are MCP elicitations),
  and the model-switch confirm, the `/model` picker and a dozen other dialogs are
  `"dialog open"`.
- Option lists wrap, and digits select only on numbered lists — the trust gate's options
  are unnumbered and ignore digits.

## Decision

- **The input box is the framed prompt row.** `inputBoxRow` accepts only a column-0 `❯`
  (or shell-mode `!`) row with a `─` rule directly above and a closing rule below; the top
  rule may carry a label (`── History 2/3 ──`). Echoed prompts have no rule above, dialog
  options are indented, and AskUserQuestion's "Chat about this" row has no closing rule.
  `prepareInput` checks it before sending any key and refuses with `no-input-box`, so
  sends, rewinds and model switches never type into a dialog.
- **A dialog is "Claude is waiting and nothing else explains it".** The bridge flags one
  when the native status is `waiting`, no AskUserQuestion is open, no tool approval
  applies (a permission prompt with a pending tool call behind it), and `parseDialog`
  reads a dialog off the pane: the rows under its `▔` border, or under the first `─` rule
  near the bottom. It returns the prose, the option labels (numbered rows, or the rows
  aligned with an unnumbered cursor row) and the cursor index. The Home list (`pending:
  "dialog"`, badge "respond") and the conversation payload (`dialog`) use the same
  predicates, so a badge never promises a card that doesn't render.
- **Answered by a label-pinned cursor walk, dismissed with Escape.** `POST
  /sessions/:id/dialog` takes `{option, label}` or `{dismiss: true}`. The pick re-reads the
  dialog, refuses `stale-dialog` unless that index still carries that label, moves the
  cursor by the exact delta, re-reads, and presses Enter only when the cursor verifiably
  sits on it.
- **The switcher hands the dialog to the phone.** After typing `/model x`,
  `setSessionModelEffort` returns `{ok, dialog: true}` as soon as a dialog is on the pane,
  and otherwise accepts only a confirmation printed under the command's own echo.

## Consequences

- New Claude Code dialogs need no code: anything bordered, listed and waiting renders as
  a card with Claude's own wording. `waitingFor` isn't read; it adds no decision the
  status and the scrape don't already make.
- A waiting session whose screen doesn't parse (no dialog border found) gets no card and
  no badge; it still shows as waiting. If its input box is hidden too, sends refuse
  `no-input-box` rather than typing blind.
- A parked job's dialog isn't surfaced: the job's native record is `kind: "bg"`, which the
  status reader skips.
- Scrape shapes are pinned by lab captures in `test/fixtures/viewport/`
  (model-switch-dialog, model-picker, trust-gate, ask-user-question, permission-prompt).

## Addendum 2026-09-29: dialogs over a running turn

- A dialog can open while a turn runs: `/model` typed mid-turn runs at once and, the cache
  being warm, opens the switch confirm; a Mac-side Alt+P picker is another. The turn keeps
  running under it and Claude keeps reporting `busy`, not `waiting`, until the turn ends.
  Gating on `waiting` left the confirm unanswerable from the phone for the rest of the
  turn, which then ran on the old model.
- `liveDialog` is the one predicate behind the card and `answerDialog`: `waiting` accepts
  any parsed dialog, `running` only one with options. Mid-turn, Ctrl+O's transcript view
  also hides the input box and parses as a dialog without options. Lab-verified: Escape on
  a dialog over a running turn closes it without interrupting the turn. Ctrl+R's history
  search left open mid-turn also shows as a card (it covers the input like a dialog, and
  Dismiss closes it); the slash menu, Ctrl+T, the agent list and Ctrl+G's editor don't.
- The Home badge stays `waiting`-only. A dialog opened at the terminal mid-turn fires no
  hook event and flips no status, so the open conversation shows its card at its next
  refetch (the next hook event, or the turn ending).
- The switcher answers the model-switch confirm itself ([ADR 4](0004-model-effort-switcher-scope.md)
  addendum); any other dialog after `/model` or `/effort` still goes to the card.
- Pinned by lab captures `model-switch-dialog-running`, `transcript-view-running` and
  `effort-toast-running` in `test/fixtures/viewport/`.

## Addendum 2026-10-01: a border with nothing under it is not a dialog

`parseDialog` anchored on the dialog's `▔` border and then read the region below it. Captured
the instant the border painted, that region is empty and the parse threw — the bridge 500'd on
`POST /sessions/:id/config` mid model switch (2026-09-30 14:02, `region[region.length - 1]`
on `[]`). An empty region now returns null, the same as no dialog: the switcher and the card
both poll, so the next capture sees the painted dialog.
