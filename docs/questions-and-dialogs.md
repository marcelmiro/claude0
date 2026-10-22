# Questions, approvals and dialogs

How a session blocked on the user gets a phone card: held AskUserQuestion calls, tool
approvals, and Claude Code dialogs covering the input box. The named docblocks carry the
implementation detail. Decisions: [ADR 8](adr/0008-question-hold-not-send-keys.md)
(questions stay hook-held), [ADR 31](adr/0031-dialogs-covering-the-input-box.md) (dialogs
are surfaced and answered). Code: `src/cli.ts` (hook scripts), `core/hook-events.ts`,
`core/tmux.ts`, `core/session-api.ts`, `bridge/server.ts`. Typing into the pane, including
the framed-row and digit hazards: [pane-input.md](pane-input.md) and the CLAUDE.md gotchas.

## Which card a session gets

The bridge checks these in order, so each blocked session gets exactly one kind
(`pendingKind`, `bridge/server.ts`):

1. **Question:** an open AskUserQuestion in the hook event log (`pendingToolCall`).
2. **Approval:** a pending-file approval, or a permission prompt on the pane with a pending
   tool call behind it (`isAttachedApproval`).
3. **Dialog:** neither of the above, and `liveDialog` accepts what `parseDialog` reads off
   the pane (`resolveDialog`).

The Home badge and the conversation's card share these predicates, so a badge never promises
a card that doesn't render. They differ in when they look. Home evaluates dialogs only for
`waiting` sessions. The open conversation recomposes its payload, dialog included, on every
JSONL append (the transcript watcher), on the 2.5s poll while a send or queue is in flight,
and on the 15s poll while background work is live. A dialog opened at the terminal
mid-turn fires no hook event and changes no status, so the card appears at the next of
those, not instantly.

The card itself doesn't poll. A tap hides it optimistically (`decidingDialog`). The hide
lifts when a payload arrives without that dialog, when the post fails, or after 5s, so a
dialog still on the pane comes back.

| Concern | Where |
|---|---|
| Subagent tool events are kept out of the event log, except AskUserQuestion | event logger in `src/cli.ts`, `pendingToolCall` (`core/hook-events.ts`) |
| The question hold is its own matcher-scoped hook with a 4h window, so a hung approval stays killable at ~10 min | `src/cli.ts` (question intercept script, hook registration), `QUESTION_HOLD_MS` |
| Hold release when the user is back at the pane, and why its failure polarity is the opposite of the intercept gate's | `atDeskFocus` (`core/tmux.ts`) |
| Un-held clarify: the picker's own "Chat about this" digit, pre-flighted, falling back to Escape | `clarifyQuestion`, `chatRowKey` (`core/tmux.ts`) |
| Dialog parse: border, options, cursor; an empty region (caught mid-paint) is no dialog | `parseDialog` (`core/session-api.ts`) |
| Dialogs over a running turn count only with options (mid-turn Ctrl+O also hides the box) | `liveDialog` (`core/session-api.ts`) |
| Answering: a label-pinned cursor walk, or Escape to dismiss | `POST /sessions/:id/dialog` → `answerDialog` |
| A parked job's dialog isn't surfaced (its native record is `kind: "bg"`) | `core/session-state.ts` |
| The model switcher accepts its own switch confirm and polls for it; other dialogs go to the card | [model-effort-switcher.md](model-effort-switcher.md) |

## Claude Code facts the code doesn't record

- **Native status** (`~/.claude/sessions/<pid>.json`) reports every blocking state as
  `waiting`, with a `waitingFor` label that is only a coarse bucket: "permission prompt"
  (also plan approval), "input needed" (also MCP elicitations), "dialog open" (the model
  switch confirm, the `/model` picker, and a dozen others). Claude0 doesn't read it.
- **Over a running turn**, Claude reports `busy` until the turn ends. Escape on a dialog
  over a running turn closes it without interrupting the turn. Ctrl+R's history search
  left open mid-turn shows as a card (Dismiss closes it). The slash menu, Ctrl+T, the agent
  list and Ctrl+G's editor don't.
- **The picker (2.1.217)** no longer times out. It has "Type something." and "Chat about
  this" as numbered rows after the real options. A lone digit submits a single-select
  option. multiSelect digits toggle, and submitting goes through a review screen where the
  wrong digit cancels the call.

Scrape shapes are pinned by `test/fixtures/viewport/`: `model-switch-dialog`,
`model-switch-dialog-running`, `model-picker`, `trust-gate`, `ask-user-question`,
`permission-prompt`, `transcript-view-running`, `effort-toast-running`.
