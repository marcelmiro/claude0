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
  `/rewind` and on a pre-stream interrupt), or — for a message send only — a draft the
  outgoing message carries whole (`replacesDraft`, `shared/mac-draft.js`: the same text,
  or the draft followed by more) and `killInput` can clear (`fitsKillInput`; a taller
  draft is stashed as usual). Cut with `killInput`, never restored; the text is in the
  transcript either way, and Ctrl+Y at the Mac recovers the cut.
- `stash` — a real Mac-side draft, set aside with Claude's own Ctrl+S (`stashInput`) and
  put back by Claude after the next submit. A failed stash aborts the send with
  `draft-stash-failed`.

Rewind is stricter than send: it discards a leftover but refuses a real draft with
`draft-present`, and refuses `stash-occupied` even without one, because the rewound prompt
overwrites the input and a completed `/rewind` loses the stash.

Portkey shows the same classification before a send: every transcript payload (full and
`unchanged`) carries `macDraft` — the box's real draft text, whether a stash is held, and
whether the text sits on a shell-mode prompt — read from one styled capture with no keys
sent (`macDraft`). It leaves out a message the bridge is mid-sending (`isOutgoingEcho`):
a busy session's hook events push between the typed text and Claude clearing the box
after Enter, and that capture would show the phone's own message as a Mac draft. The
composer renders it as a note; it refreshes with the payload, not
on each Mac-side keystroke. "use" copies the draft into the composer (not offered for a
shell draft, a draft too tall to cut (`cuttable`), or one holding a `[Pasted text #N]`/
`[Image #N]` placeholder, whose content the capture doesn't have); the note then says the send replaces the Mac draft, by the
same `replacesDraft` rule the send applies. The capture flattens the draft's line breaks
to spaces — a wrapped row and a real newline render alike.

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
`input-cursor-wrapped`, `footer-focused`, `footer-focused-draft`, `stash-marker`, `stash-marker-draft` (2.1.326),
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
  with `isAbortedMidStream: true`. The auto-submitted records (2.1.327, one per queued
  message, linked through attachments) chain after the interrupt marker when Escape lands
  mid-stream — so until the reply starts the last one is the revert's bare-leaf shape.
  When Escape lands mid-tool, a write-order race (3 of 4 lab runs) hangs them off the
  interrupted tool_use instead, beside the rejected tool result and off the active branch.
  The live process still holds them (terminal and `/rewind` list them), but a resume
  rebuilds from the parent chain and drops them. So `parseActiveBranch`
  (`withInterruptSubmissions`) splices them in after the marker only while the session's
  live process started before the interrupt (`liveProcessStartedAt`, `core/session-state.ts`).
  That start time is part of the transcript `rev`, so the next read after a resume re-ships
  the thread. A resume writes no transcript line and logs no hook event, so an open phone
  only refetches on its next poll or push.
- Portkey's Stop arms no revert-restore and no "ready" overlay while `queuedPending` is
  non-empty (`onStop`, `app.js`). The queue auto-submits, so nothing comes back. The
  phone's copy of the queue lags a just-sent message, and Claude flushes the queue entry a
  beat after taking it. So a text `/message` sent while Claude is busy answers `queued` only once
  that entry is in the transcript (`userEnqueueAfter`), and the client disarms on that answer.
  `/interrupt` waits for a send still typing into the pane (`sendTracked`, `server.ts`), so
  an Escape never splits one. It also answers `queued`: whether Claude's queue held
  messages at the Escape (`queuedAtEscape`: the queue up to a byte mark taken just before
  it, or the user's enqueue written right after it — Claude sometimes flushes the enqueue only
  with the Escape's auto-submit, after the send's own check gave up).
  The phone's copy lags a turn-end dequeue too — Claude takes a queued message as the next
  prompt, and an Escape before it streams reverts it — so the client re-decides on that.
- Escape during a compaction cancels it ("Compaction canceled.") and a queued message
  auto-submits ~0.3s later (2.1.329, lab run). A message queued during a compaction is
  enqueued with no text, so `queuedAtEscape` can't see it: while `compacting`, the client
  keeps its own send's `queued` answer over the bridge's "not queued" (`onStop`).
- `/rewind` lists every sent prompt, including several submitted together with no reply
  in between and back-to-back `!cmd` turns. It never lists a prompt followed only by an
  interrupt marker before the next prompt (`promptCheckpointIndices`, `app.js`).
- On a revert the client prefills the composer, hides the bare leaf (`hiddenInterrupts`,
  `app.js`), and calls `POST /sessions/:id/clear-input` (`clearPaneInput` → `killInput`).
  A Stop right after Send can beat the prompt into the JSONL, so "the text is absent"
  resolves the restore only once the text was seen or a 3s grace passed. Otherwise it
  would skip the hide and the clear.
