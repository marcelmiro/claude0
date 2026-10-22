# Model/effort switcher

How portkey's `Model · Effort` picker reads and changes a session's model and reasoning
effort. Decision: [ADR 4](adr/0004-model-effort-switcher-scope.md). Code:
`core/session-api.ts` (`MODEL_ARGS`, `EFFORT_ARGS`, `parseStatusline`,
`setSessionModelEffort`, `commandConfirmation`), `bridge/public/app.js` (`configLabel`). Mechanics are guarded by
`test/smoke/model-effort.sh`, opt-in because it drives real sessions (not part of
`bun test`).

## The sheet

- One `Model · Effort` sheet: model options as rows (aliases only: `default`, `opus[1m]`,
  `fable`, `sonnet`, `haiku`), effort as a chip row. `/model` and `/effort` in the composer
  both open it. One tap applies one change and closes — the config route
  (`POST /sessions/:id/config`) takes a single field per request.
- The ⋯ session sheet has a row whose label is the current values (`Opus · High`) and opens
  the picker. It renders only for the open conversation with a live pane, because the values
  come from the loaded transcript's pane scrape. An unparsed value reads as `—`.
- Ultracode's session-only scope is a hint line under the chip row. The sheet also states a
  model switch's cost: it re-reads the whole conversation on Claude's next step.

## Reading the current values (`parseStatusline`)

- Current *effort* depends on the user's `~/.claude/statusline.sh` rendering
  `.effort.level` as the final word of some `•`-delimited segment, bare or parenthesized
  (`• Opus 5.5 (high)`). Without that statusline edit the switcher still works; the sheet
  just can't pre-mark the active level. No structured source exists: the native
  `~/.claude/sessions/<pid>.json` carries no model or effort field.
- Token-scan rules and Opus version mapping (the current Opus marks the `opus[1m]` row; an
  older Opus keeps its full id and marks none): `parseStatusline`'s docblock.
- Family aliases are version-free, so a family's version bump is a sub-label edit.


## Applying a change (`setSessionModelEffort`)

- Sends the arg-form command (`/model opus[1m]`, `/effort high`) through the guarded send
  path ([docs/pane-input.md](pane-input.md)); a draft is stashed with Ctrl+S and Claude puts
  it back once the switch (and any confirm) is accepted.
- **Scope, as Claude implements it** (lab, 2.1.284–2.1.286): `/model <arg>` saves the arg
  **verbatim** as the new-session default (`/model default` removes the key); `/effort`
  saves per model under `modelSettings.<model id>.effortLevel` in `~/.claude/settings.json`,
  and a model switch inside a running session keeps the session's effort. The `/model`
  picker's `s` (this session only) has no arg form.
- **Switch confirm.** On a warm cache (always, mid-turn) `/model x` opens "Switch model? …
  the full history gets re-read". When its cursor sits on "Yes, switch to …" the switcher
  presses Enter, as Claude's own Alt+P picker switches without asking. Any other dialog
  returns `{ok, dialog: true}` and the phone shows it as a dialog card
  ([ADR 31](adr/0031-dialogs-covering-the-input-box.md)).
- **Mid-turn**, `/model` and `/effort` run at once (unlike `/rewind`, which queues) and
  apply from Claude's next API call in the same turn (2.1.284, checked against the model
  and effort recorded on each assistant message).

## Reading the confirmation

`commandConfirmation` and `extractConfirmation` hold the rules (the line must sit under
this command's newest echo; mid-turn it's a ~7s toast above the box that must not already
have been up; wrapped continuation rows). One user-visible consequence: re-applying the
value just applied, mid-turn within ~7s, reports `no-confirm` (identical toast text)
though Claude applied it.
