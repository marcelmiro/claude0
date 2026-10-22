# Typing into a Claude pane

How the bridge reads and drives a Claude Code pane's input box: finding the box, the
pre-flight every typing path runs, draft stash and discard, and the widgets that steal
keystrokes. Decisions: [ADR 6](adr/0006-wrapping-claude-code.md) (guarded keystrokes),
[ADR 9](adr/0009-interrupt-revert-mirroring.md) (interrupt mirroring),
[ADR 12](adr/0012-bang-commands.md) (shell mode),
[ADR 31](adr/0031-dialogs-covering-the-input-box.md) (dialogs). Code: `core/session-api.ts`.
Everything below was lab-verified against live panes; versions are noted where they matter.

## Finding and reading the input

- **The input is the framed row** (`inputBoxRow`): the column-0 `❯` row with a rule
  directly above and a closing rule below. "The last `❯` row" is wrong twice over: a dialog
  replacing the box leaves echoed prompts and dialog options as the last `❯` rows, and
  background-task notification rows (`❯ ⧉  <task> · Enter to open · x to dismiss`) sit
  *below* the input. No framed row means a dialog is up: refuse `no-input-box` before any key.
- **Ghost text is dropped** from the styled capture (`flattenStyled`): dim placeholder
  text isn't a draft. Notification rows are colored, not dim, so the scans skip
  `❯ ⧉`-prefixed rows explicitly.
- **The cursor cell.** Claude draws its cursor as a reverse-video cell. In an empty box
  with a queued message it sits on the dim placeholder's first letter and is not dim
  itself, which read as a one-letter draft (2.1.284). `flattenStyled` drops a reverse cell
  followed directly by dim text; a cursor at the end of, or inside, typed text is kept.
  Claude hides the cell while its terminal is unfocused (tmux `focus-events on`), the usual
  state while the user is on the phone.

## Pre-flight (`prepareInput`)

`sendMessage`, `setSessionModelEffort` and `rewindSession` all run it, in order:

1. Refuse `no-input-box` if there is no framed row.
2. **Release footer focus** (`releaseAgentList`): with background agents or shells
   running, `Down` past the input's last row moves focus into the list under the
   statusline (`agentListFocused`: the selection glyph on a `●`/`◯` row below the box's
   bottom rule; `footerFocused`: the selected task item drawn in reverse video). There `x`
   stops the selected agent/task and Enter opens it; a second `Down` opens the task manager
   over the box; `Escape` interrupts a running turn and leaves focus in the list. `Up`
   walks the selection up and, from the top row, returns to the input's last row with the
   draft intact. Fails loud with `agent-list-focused`.
3. **Dismiss notification rows** with `x` (gated on detection, re-captured per round).
   While a row is visible it captures plain keystrokes — `x` and `C-u` never reach the
   input. Fails loud with `notification-clear-failed`.
4. **Leave an empty shell mode** with Backspace; a shell prompt with text refuses
   `shell-draft` ([ADR 12](adr/0012-bang-commands.md)).
5. **Classify the input**: empty, a leftover to discard, or a draft to stash.

## Drafts: stash

- A draft around a send is stashed with Claude's **Ctrl+S** (`chat:stash`, present back to
  2.1.263). It takes the whole input from any cursor position, pasted images included,
  shows `› stashed` above the box (`stashPresent`), and Claude puts the draft back after
  the next submit: a message, a slash command (after a `/model` confirm is accepted), a
  send queued mid-turn.
- **One slot.** A second Ctrl+S pushes the first stash out to the kill ring, and cutting a
  draft while a stash exists merges it into the stash Claude pops after the submit. With a
  stash present, a send with a draft refuses `stash-occupied`; without a draft it goes
  through and Claude pops the user's stash as it does at the Mac. A completed `/rewind`
  overwrites the input and loses the stash, so rewind refuses `stash-occupied` too, and
  refuses a real draft with `draft-present` (the rewound prompt lands in the input).

## Leftovers: discard

- Claude itself puts submitted text back into the input: `/rewind` restores the rewound
  prompt, and a pre-stream interrupt reverts the prompt into it. Carried as a "draft", a
  leftover once survived overnight, got cut down by partial kills, and was submitted glued
  to `/rewind`.
- **`isSubmittedText`**: input that equals, or is a prefix of, any prompt in the session's
  JSONL (every branch; whitespace removed) is a leftover and gets `discard`. Drafts under 15
  non-space chars never count, so a freshly typed `yes` stays a draft.

## The kill walk (`killInput`)

Used for discards and for `clear-input` after an interrupt revert.

- Claude's input editor is display-row scoped: one `C-u` kills from the cursor to its row
  start, so wrapped rows and rows below the cursor survive.
- So: walk `Down` one row at a time (100ms gaps) to the last row, then `C-e`, then `C-u`
  until the input reads empty. The walk stops on the last row when the cursor cell shows;
  otherwise it stops when focus has left the input and hands it back with one `Up`.
- **`Up` is never sent from inside the input** — at the top row it recalls prompt history
  and replaces the input.
- Consecutive kills form one kill-ring chain (one `C-y` at the Mac yanks the lot back), but
  any motion or typing between kills resets it — hence all motions first, then only kills,
  never a second walk.
- "Cleared" requires an empty box on screen; the caller fails loud otherwise.
- Keys that don't help: Ctrl+End, Meta+>, Ctrl+Down, PageDown and Meta+Down don't move the
  input's cursor (Ctrl+End scrolls the transcript, Ctrl+Down steps the diff file list); End
  only reaches the row end; Ctrl+L doesn't clear the input.

Pinned by styled lab captures in `test/fixtures/viewport/`: `input-cursor-top`,
`input-cursor-wrapped`, `footer-focused`, `footer-focused-draft`, `stash-marker`,
`shell-details`.

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
- After a revert the text sits in the Mac's input box, so every later stop hits the
  occupied-input row and becomes a keep. Hence `clear-input` after a confirmed
  revert-restore.
- **The client-side hide of the reverted leaf** is matched by index, text, and the
  reverted turn's record timestamp (`at`). An unchanged resend forks from the same parent
  and lands at the same index with the same text; only the timestamp tells them apart.
