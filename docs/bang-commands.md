# Bang commands

How a `!cmd` sent from portkey is typed, recorded, parsed and rendered. The named comments
carry the implementation detail. Decision: [ADR 12](adr/0012-bang-commands.md). The send
path's shell-mode guard is step 4 of the pre-flight in [pane-input.md](pane-input.md); the
shell-mode hazard itself is a CLAUDE.md gotcha.

| Concern | Where |
|---|---|
| The two JSONL records (input, then stdout+stderr), folded into one turn | the `BASH_INPUT` comment in `core/transcript.ts`; `foldBashTurns` |
| Bash turns are rewind checkpoints, slash-command turns aren't | the comment above `isPromptTurn` (`bridge/public/app.js`) |
| The optimistic bubble retires on `"!"` + the trimmed command | `bangKey` (`app.js`) |
| An accepted bang shows "running · <elapsed>" until its turn lands | `deliveredBangs` (`app.js`) |
| Composer bash mode: a `!` opening an empty draft, typed or pasted | the composer's `onInput` (`app.js`, `pasteWasEmpty`) |
| The send: `"!"` + the trimmed field text | the composer's `send` (`app.js`) |

## Claude Code facts the code doesn't record (CC ~2.1.230 unless noted)

- **Typing enters shell mode; pasting doesn't.** The send path's `send-keys -l` burst puts
  the pane in shell mode. A bracketed paste of `!cmd` does not.
- **The result goes to the model:** an assistant turn follows every bang.
- **Both records are written only when the command exits.** The input record keeps the
  submit timestamp but is written alongside its output: a command submitted at 22:52:05.8
  reached the JSONL at 22:53:35.9. That is why "running" exists as a bubble state.
- **A mid-turn bang queues** (keeping its `!`) and runs at turn end, then leaves the prompt
  in shell mode. An immediate, non-queued bang exits shell mode on its own.

## What the user sees

- The thread renders a bang like a terminal: a right-aligned peach mono command bubble,
  then the output as a full-width rail (stdout mint, stderr red). stdout over 8 lines
  (`BASH_CLAMP_LINES`) collapses behind an expander.
- In bash mode the `!` becomes an in-field glyph, and the textarea is remounted with
  autocorrect and spellcheck off, because iOS honors those attributes only at focus time.
  Backspace on the empty field, or a tap on the glyph, exits; sending exits after dispatch.
  A restored `!cmd` draft re-enters the mode (`setComposerText`).
