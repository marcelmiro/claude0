# Typing into a Claude pane

How the bridge's typing paths fit together: the pre-flight they share, what happens to
text already in the input, and the Claude Code behavior they're calibrated against. Each
function's own docblock in `core/session-api.ts` carries its lab findings — read it before
changing it. The never-do rules are in CLAUDE.md's "Sending keys to a Claude pane".
Decisions: [ADR 6](adr/0006-wrapping-claude-code.md) (guarded keystrokes),
[ADR 9](adr/0009-interrupt-revert-mirroring.md) (interrupt mirroring),
[ADR 12](adr/0012-bang-commands.md) (shell mode),
[ADR 31](adr/0031-dialogs-covering-the-input-box.md) (dialogs).

## Pre-flight (`prepareInput`)

`sendMessage`, `setSessionModelEffort` and `rewindSession` all run it before any key. The
order matters — each step clears a widget that would swallow the next step's keys:

| # | Step | Function | Refuses with |
|---|---|---|---|
| 1 | A framed input box is on screen (none ⇒ a dialog is up) | `inputBoxRow` | `no-input-box` |
| 2 | Hand focus back from the agent list / footer task item | `releaseAgentList` (`agentListFocused`, `footerFocused`) | `agent-list-focused` |
| 3 | Dismiss background-task notification rows | `clearNotificationRows` | `notification-clear-failed` |
| 4 | Leave an empty shell mode; refuse a typed one | `shellModeInput` | `shell-draft`, `shell-clear-failed` |
| 5 | Classify the input, ghost text dropped | `flattenStyled`, `inputPending`, `isSubmittedText`, `stashPresent` | `stash-occupied` |

Step 5 yields a `DraftAction`, which `buildSendPlan` turns into the first send step:

- `none` — empty input.
- `discard` — a leftover of an already-submitted prompt (Claude itself puts text back on
  `/rewind` and on a pre-stream interrupt). Cut with `killInput`, never restored; the
  prompt is still in the transcript.
- `stash` — a real Mac-side draft, set aside with Claude's own Ctrl+S (`stashInput`) and
  put back by Claude after the next submit. A failed stash aborts the send with
  `draft-stash-failed`.

Rewind is stricter than send: it discards a leftover but refuses a real draft with
`draft-present`, and refuses `stash-occupied` even without one, because the rewound prompt
overwrites the input and a completed `/rewind` loses the stash.

## Where keys go wrong

The hazards behind each pre-flight step — `Down` into the footer, notification rows
eating keystrokes, the row-scoped `C-u`, the kill-ring chain, the cursor cell hidden while
the terminal is unfocused — are in the docblocks of `releaseAgentList`, `NOTIFICATION_ROW`,
`killInput` and `stashInput`, and the never-do rules in CLAUDE.md's "Sending keys to a
Claude pane". Lab-verified on 2.1.263–2.1.285.

Keys that don't help, so don't reach for them: Ctrl+End, Meta+>, Ctrl+Down, PageDown and
Meta+Down don't move the input's cursor (Ctrl+End scrolls the transcript, Ctrl+Down steps
the diff file list); End reaches only the row end; Ctrl+L doesn't clear the input.

Pinned by styled lab captures in `test/fixtures/viewport/` (`input-cursor-top`,
`input-cursor-wrapped`, `footer-focused`, `footer-focused-draft`, `stash-marker`,
`shell-details`). Recapture a fixture when a Claude release changes the rendering.

## Interrupts (Claude Code ~2.1.x)

What Escape does to a running turn depends on whether any API bytes had arrived and
whether the input box was occupied:

| Condition at Escape | TUI shows | JSONL signature | Branch fate |
|---|---|---|---|
| Pre-stream + empty input | **revert** — text moves back into the input box, nothing drawn | prompt record left as a childless **bare leaf, no marker** | next send forks past it |
| Pre-stream + occupied input | **keep** — message + `⎿ Interrupted` line; draft untouched | prompt + `[Request interrupted by user]` marker, `interruptedMessageId: null` | stays; next send chains after the marker |
| Stream started (thinking deltas count) | **keep** — plus any partial text | marker with `interruptedMessageId` set; a thinking-only partial persists **no assistant record** | stays |

- Escape with queued mid-turn messages interrupts the turn and the queue **auto-submits**
  as the next prompt. A second Escape changes nothing. Interrupted partial text persists
  with `isAbortedMidStream: true`.
- On a revert the client prefills the composer, hides the bare leaf (`hiddenInterrupts`,
  `app.js`), and calls `POST /sessions/:id/clear-input` (`clearPaneInput` → `killInput`).
