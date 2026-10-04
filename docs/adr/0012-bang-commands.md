# 12. Portkey `!` bash commands: one folded turn, a typed-only composer mode, and a shell-mode send guard

Date: 2026-07-31
Status: accepted

## Context

A `!cmd` sent from the phone worked — the send path's `send-keys -l` burst reliably puts
the pane in shell mode — but everything around it was wrong: the transcript showed two
raw-tag user bubbles (`<bash-input>…`, `<bash-stdout>…`), the optimistic bubble never
retired (its text `!ls` matches neither record), which left duplicate bubbles and a
permanent 2.5s poll, and the composer gave no signal that a leading `!` executes as bash
while iOS autocorrect mangled the command being typed.

The behavior model was pinned down against live panes (CC ~2.1.230):

- The JSONL carries two ADJACENT `user` records: `<bash-input>cmd</bash-input>`, then
  `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`. Current CC feeds the result
  to the model — an assistant turn follows every bang.
- The `/rewind` picker LISTS a bang as a checkpoint (`! echo … · No code changes`).
- A bracketed PASTE of `!cmd` does NOT enter shell mode in the terminal — only typing does.
- A mid-turn bang queues (keeping its `!`), executes at turn end… and then the pane's
  prompt STAYS in shell mode: the live input line renders `! ` where `❯` would be, with a
  "! for shell mode" hint under the input box. The next plain text typed into that pane
  executes as bash. `C-u` + `BSpace` exits; an immediate (non-queued) bang exits on its own.

## Decision

**Fold the record pair into one turn.** The parser maps the input record to a
`bash: { command, stdout, stderr }` turn and merges the adjacent output record into it
(`foldBashTurns`, in both the linear and active-branch parses). Output tags are extracted
independently — observed records always carry both (stderr present even when empty), but
the parser must not depend on that shape. An orphan output record (clipped branch) is
dropped; an input with no output keeps empty stdout/stderr (killed mid-command). The
thread renders the pair terminal-style: right-aligned peach mono command bubble, then the
output as a full-width rail — stdout mint, stderr red, long stdout clamped behind an
expander. The optimistic echo of a `!` send renders the same bubble and retires against
`"!" + command`.

**Bash turns ARE rewind checkpoints; slash-command turns are NOT.** This asymmetry is
deliberate, not an inconsistency: it mirrors Claude's own picker, which lists bang
commands and excludes slash-command turns (both verified live). Counting them any other
way shifts every earlier prompt's upCount and lands the rewind on the wrong checkpoint.

**Composer bash mode enters on a `!` opening an empty draft — typed or pasted.** A typed
`!` on an empty field lifts into an in-field glyph and remounts the textarea with
autocorrect/spellcheck off (iOS honors those attributes only at focus time). *Amended
2026-08-05:* a `!`-leading paste into an **empty** composer now enters the mode too — the
send string is identical either way (the pane executes it as bash regardless), so
withholding the mode only hid the "this will execute" affordance from the paste-a-command
workflow. A `!` typed or pasted **mid-draft** still never flips: a copied snippet that
happens to contain `!` keeps its meaning, matching the pane. Backspace on the empty field
or tapping the glyph exits; sending exits after dispatch and sends the literal
`"!" + text`.

**The send path guards against a lingering shell prompt as its own step.** The existing
draft guard is `❯`-keyed and blind to shell mode — `killInput`'s C-u loop would no-op yet
report the input empty, and the message would be typed into a prompt that executes it as
bash. So `sendMessage` pre-flights with `shellModeInput(capture)` (the `! …` line plus
the hint below it): an EMPTY shell prompt (the queued-bang leftover — including one our
own send created) is cleared with a single `BSpace` and re-verified before proceeding; a
shell prompt HOLDING TEXT aborts with reason `shell-draft`. No kill/restore is attempted
for shell drafts: the kill-ring choreography (chain survival across the mode-exit
`BSpace`, whether shell mode is even the same multi-row editor) is unverified on a live
pane, and its failure mode is silent draft loss. Fail loud instead; revisit only if the
abort ever actually annoys.

## Rejected

- **Rendering the records raw or dropping them** — raw tags read as noise; dropping them
  makes a phone-sent command look lost (same reasoning as slash-command turns).
- **A passive tint instead of a real composer mode** — too subtle on-device, and it can't
  fix autocorrect, which needs the attribute remount.
- **Auto-entering bash mode on paste or on restored drafts** — originally rejected as
  "no gain: the send string is identical either way". *Partially reversed 2026-08-05:*
  the paste-into-empty case turned out to have a real gain (the mode's visual
  affordance), so it now flips; mid-draft pastes and restored drafts still don't
  (restored `!cmd` drafts re-enter the mode via setComposerText, unchanged).
- **Reusing `killInput` + C-y restore for shell-mode drafts** — unverified in shell mode
  with silent-loss failure; the fail-safe abort is strictly safer.

## Addendum (2026-10-04): a running bang command shows "running", not "sending…"

Claude Code appends a bang command to the transcript only once it exits: the
`<bash-input>` record keeps the submit timestamp but is written alongside its
`<bash-stdout>` (observed: a `!cd … && …` submitted at 22:52:05.8 hit the JSONL
at 22:53:35.9, both records together). The optimistic bubble retires only against
the folded turn, so for a long command it sat on "sending…" for the whole run, as
if delivery had stalled. Once the bridge accepts a `!` send (keys are in the pane),
the bubble's tag now reads "running · <elapsed>" until the turn lands. "sending…"
keeps meaning not-yet-delivered.
