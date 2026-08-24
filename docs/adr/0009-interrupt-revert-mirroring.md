# 9. Interrupts mirror the TUI: revert restores to the composer, keeps stay in the thread

Date: 2026-07-24
Status: accepted

## Context

Stopping a just-sent message from the phone (double-tap Stop → bridge sends Escape) left
the user with nothing: the message vanished from the portkey thread and the composer was
empty, so "stop to improve the message" meant retyping it. Early fixes guessed at what
Claude Code does on interrupt and hid/restored the wrong cases. The behavior was then
pinned down by driving live claude panes through timed interrupts (haiku / sonnet /
fable, ~20 runs), capturing the pane and diffing the JSONL after each.

## Verified interrupt behavior (Claude Code ~2.1.x)

What Escape does to a running turn depends on two things only: whether any API bytes had
arrived, and whether the input box was occupied.

| Condition at Escape | TUI shows | JSONL signature | Branch fate |
|---|---|---|---|
| Pre-stream + empty input | **revert** — text moves back into the input box, nothing drawn | prompt record left as a childless **bare leaf, no marker** | next send forks past it |
| Pre-stream + occupied input | **keep** — message + `⎿ Interrupted` line; draft untouched | prompt + `[Request interrupted by user]` marker, `interruptedMessageId: null` | stays; next send chains after the marker |
| Stream started (thinking deltas count — display not required) | **keep** — plus any partial text | marker with `interruptedMessageId` set; a thinking-only partial persists **no assistant record** (→ `prompt + marker, no output`) | stays |

Also verified: Escape with queued mid-turn messages interrupts the turn and the queue
**auto-submits** as the next prompt (not popped into the input); a second Escape (mid-arm
or later at idle) changes nothing; interrupted partial text persists with
`isAbortedMidStream: true`. One 1-of-16 anomaly (a msgid-less kept pair later abandoned
at the next send) never reproduced and is treated as a CC-internal race.

The revert is why phone stops "lose" the message: the text is parked in the **Mac's**
input box, invisible from the phone. And it is self-defeating across tests: the parked
text occupies the input, so every subsequent stop hits the occupied-input row and
becomes a keep — which also explains why the same gesture seemed to behave randomly.

## Decision

Portkey mirrors the TUI exactly, keyed off the JSONL signature:

- **Bare leaf** (revert): the client (which alone knows the sent text — it exists
  nowhere readable after a revert) prefills the composer, hides the dangling leaf from
  the thread (transient, index+text-guarded; it self-heals when the next send forks the
  branch), and POSTs `/sessions/:id/clear-input` so the pane copy is removed too. The
  composer is focused inside the Stop tap's gesture handler — iOS raises the keyboard
  only for a gesture-driven focus, and the revert confirmation resolves ~2s too late to
  qualify; the prefill then lands in the already-focused box.
- **Any marker shape** (keep): the message stays in the thread with the interrupt line,
  exactly like the Mac. No restore, no hide.

Two send-path fixes fall out of the lab findings:

- **Draft stash killed row-by-row.** Claude's input editor is display-row scoped: one
  `C-u` kills only from the cursor to its row start, so wrapped rows and rows below the
  cursor survived — phone sends spliced into leftover draft text (reproduced as
  concatenated submissions). `killInput` now walks to the bottom (`Down` ×12 — Down is
  history-next, a no-op at the newest entry; **Up recalls history and must never be
  sent**), `C-e`, then `C-u` until the input reads empty. Consecutive kills accumulate
  into one kill-ring chain, so the existing single `C-y` restore yanks the whole draft
  back, newlines included — but any motion or typing between kills RESETS the chain
  (verified: the earlier chunk drops out of the yank), so the sequence is strictly
  motions-first-then-kills and never retries with a second walk. The `Down`s are gapped
  (100ms; the input editor registered arrows reliably at 60–80ms in the lab) so a
  dropped key can't strand rows below the cursor, and if the input still isn't empty
  afterward the send ABORTS (`draft-stash-failed`) rather than typing into the remnant.
- **Clear-on-revert.** After a confirmed revert-restore the pane input is cleared via
  the same kill sequence (recoverable at the Mac with `C-y`). Without this, the parked
  text flips every future pre-stream interrupt to a keep and feeds the draft guard a
  phantom draft forever.

## Rejected alternatives

- **Persisted client-side hiding (localStorage) of interrupted prompts** — curates the
  thread per device, resurrects on other devices, and accumulates dead entries. Replaced
  by mirroring: portkey renders the served branch; only the transient bare-leaf hide
  needs moment-of-interrupt knowledge.
- **Derivable "hide any unanswered prompt followed by an interrupt marker" rule** —
  hid messages the Mac TUI shows (marker = keep, not revert). Diverges from the TUI on
  every kept interrupt, including retroactively across old conversations.
- **Server-side revert detection** — the server can see the bare leaf but not the sent
  text after a revert (it exists only in the pane input and the phone's memory), and
  only the client knows which device drove the send. Detection stays client-side.
