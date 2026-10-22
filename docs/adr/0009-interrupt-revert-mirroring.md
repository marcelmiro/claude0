# 9. Interrupts mirror the TUI: revert restores to the composer, keeps stay in the thread

Date: 2026-07-24
Status: accepted; the draft-around-a-send mechanism amended 2026-09-30 (Claude's own Ctrl+S stash replaced the kill-ring cut and `C-y` restore)

How the bridge drives the input box — the interrupt table, pre-flight, stash, the
`killInput` walk, and the widgets that steal keystrokes — is in
[docs/pane-input.md](../pane-input.md).

## Context

Stopping a just-sent message from the phone (double-tap Stop → bridge sends Escape) left
the user with nothing: the message vanished from the portkey thread and the composer was
empty, so "stop to improve the message" meant retyping it. Early fixes guessed at what
Claude Code does on interrupt and hid/restored the wrong cases. The behavior was then
pinned down by driving live claude panes through timed interrupts (haiku / sonnet /
fable, ~20 runs), capturing the pane and diffing the JSONL after each.

Escape **reverts** a turn (text back into the input box, the prompt left as a childless
bare leaf in the JSONL) only when no API bytes had arrived and the input was empty;
otherwise it **keeps** it (message plus an interrupt marker). The revert is why phone
stops "lost" the message: the text was parked in the **Mac's** input box, invisible from
the phone. And it is self-defeating: the parked text occupies the input, so every later
stop becomes a keep — which is why the same gesture seemed to behave randomly.

## Decision

Portkey mirrors the TUI exactly, keyed off the JSONL signature:

- **Bare leaf** (revert): the client (which alone knows the sent text — it exists
  nowhere readable after a revert) prefills the composer, hides the dangling leaf from
  the thread (transient, guarded by index, text and record timestamp; it self-heals when the next send forks the
  branch), and POSTs `/sessions/:id/clear-input` so the pane copy is removed too. The
  composer is focused inside the Stop tap's gesture handler — iOS raises the keyboard
  only for a gesture-driven focus, and the revert confirmation resolves ~2s too late to
  qualify; the prefill then lands in the already-focused box.
- **Any marker shape** (keep): the message stays in the thread with the interrupt line,
  exactly like the Mac. No restore, no hide.

Two send-path rules fall out of the lab findings:

- **A send never types over a draft.** A draft in the input is set aside before the send
  and comes back after it; if it can't be set aside cleanly, the send aborts
  (`draft-stash-failed`) rather than splicing the message into the remnant.
- **Clear-on-revert.** After a confirmed revert-restore the pane input is cleared.
  Without this, the parked text flips every future pre-stream interrupt to a keep and
  feeds the draft guard a phantom draft forever.

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
