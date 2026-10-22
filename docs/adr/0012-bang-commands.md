# 12. Portkey `!` bash commands: one folded turn, a composer bash mode, and a shell-mode send guard

Date: 2026-07-31
Status: accepted; amended 2026-08-05 (a `!` paste into an empty composer enters bash mode)

How bangs are recorded, parsed, rendered and typed: [docs/bang-commands.md](../bang-commands.md).

## Context

A `!cmd` sent from the phone worked: the send path's keystroke burst reliably puts the pane
in shell mode. Everything around it was wrong, though:

- The transcript showed two raw-tag user bubbles (`<bash-input>…`, `<bash-stdout>…`).
- The optimistic bubble never retired, because its text `!ls` matches neither record. That
  left duplicate bubbles and a permanent 2.5s poll.
- The composer gave no signal that a leading `!` runs as bash, and iOS autocorrect mangled
  the command while it was being typed.

Live panes (CC ~2.1.230) showed three more facts that shape the design:

- Claude's `/rewind` picker lists bangs as checkpoints and leaves slash-command turns out.
- A pasted `!cmd` doesn't enter shell mode in the terminal; only typing does.
- A queued bang leaves the prompt in shell mode, where the next plain text typed runs as
  bash.

## Decision

- **Fold the record pair into one turn.** A command and its output render as one terminal
  turn. A `!` send's optimistic echo renders the same way and retires against that turn.
- **Bash turns are rewind checkpoints; slash-command turns are not.** The asymmetry is
  deliberate: it mirrors Claude's own picker. Counting turns any other way lands the rewind
  on the wrong checkpoint.
- **Composer bash mode enters on a `!` opening an empty draft, typed or pasted.** The mode
  is the only "this will execute" signal on the phone, and it is what turns autocorrect off.
  A `!` typed or pasted mid-draft never flips it, so a copied snippet containing `!` keeps
  its meaning, as it would in the pane.
- **Sends guard against a lingering shell prompt as their own step.** The `❯`-keyed draft
  guard can't see shell mode, so a plain message would be typed into a prompt that runs it
  as bash. An empty shell prompt (the queued-bang leftover, including one our own send
  created) is cleared and re-verified before sending. A shell prompt holding text aborts
  with `shell-draft`.

## Consequences

- A command being typed at the Mac's shell prompt blocks phone sends until it's cleared at
  the desk. Revisit this only if the abort ever actually gets in the way.
- The thread's checkpoint count is tied to Claude's picker. If the picker's listing rules
  change, rewind's `upCount` has to change with them.

## Rejected

- **Rendering the records raw, or dropping them.** Raw tags read as noise, and dropping them
  makes a phone-sent command look lost (the same reasoning as for slash-command turns).
- **A passive tint instead of a real composer mode.** It's too subtle on-device, and it
  can't fix autocorrect, which needs the attribute remount.
- **Entering bash mode on a mid-draft paste or a restored draft.** The `!` there is content,
  not a command prefix. Paste into an *empty* composer was also rejected at first ("the send
  string is identical either way"), then reversed: the visual signal is a real gain.
- **Clearing and restoring shell-mode drafts like ordinary drafts.** That has never been
  verified on a live pane in shell mode, and if it fails the draft is lost silently. The
  abort is strictly safer.
