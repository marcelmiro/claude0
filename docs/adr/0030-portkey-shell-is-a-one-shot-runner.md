# Portkey's shell is a one-shot command runner, not a terminal

Date: 2026-09-23
Status: accepted

## Context

Switching the Claude account on the host is one pasted line: the whichclaudio dashboard
hands out a shell command that merges a new `claudeAiOauth` credential into
`~/.claude/.credentials.json`, and every running Claude Code session on that machine
picks it up at once. At a desk that line goes into a tmux popup. From the phone there
was no terminal, so a usage-limit stop meant finding a computer — the only remaining
reason portkey could not carry a day on its own.

The composer's `!` bash mode ([ADR 12](0012-bang-commands.md)) could already run the
line inside a session's pane, but that lands a credential in that session's transcript
as a bang turn, needs an idle session with no draft or question, and feeds the output
to the model.

## Decision

**A shell sheet on Home, backed by `POST /shell`: one command in, its exit code and
output out.** The bridge spawns `$SHELL -lc <command>` in the home directory with no
tty and stdin closed, waits up to 30 seconds, caps each output stream at 64 KB, and
answers with the run. `GET /shell` returns the last 20 runs. The sheet renders them in
the bang-turn dress (command bubble, stdout rail, stderr rail) with a footer naming a
non-zero exit, a kill, or truncated output, and a mono composer whose Enter inserts a
newline so a pasted multi-line command is never fired early. One command runs at a
time; a second is refused with `busy`.

**Not a terminal.** No pty, no polling, no interaction. Every command this exists for is
non-interactive by design, and a command that needs a keyboard is the desk's job. A pty
in a tmux window with capture-pane polling would buy cursor state, wrapping, prompt
handling, and cleanup for a use case that is "paste one line, read one line back".

**The login shell is deliberate.** The bridge is a systemd user unit with a minimal
environment; `-l` gives the command the PATH and environment a tmux popup has, so a line
that works at the desk works here. The switch line itself tolerates the bare environment
(measured: it ran under the bridge's env in 36 ms and preserved `mcpOAuth`), but the
next pasted command may not.

**Nothing touches disk or the log.** A pasted line can carry a credential — the whole
reason this exists instead of the composer's `!` path is that a bang lands the line in
the session's transcript. The scrollback lives in the bridge process and dies with it;
the journal gets `shell: exit N in Nms` and never the command text; both responses are
`cache-control: no-store` so the browser's HTTP cache holds nothing, and the service
worker's app-shell allowlist does not include the route. The shell is non-interactive,
so zsh opens no history file (measured: `HISTFILE` empty). The only exposure is the
command in the spawned shell's argv for the milliseconds it runs. The fixtures bridge
serves a canned scrollback so the design loop can paint the sheet.

**Process-group kill on Linux.** `setsid` makes the shell a group leader so a timeout
kills what it spawned, not just the shell — otherwise a `sleep 30 &` keeps the stdout
pipe open and the request never returns. On a Mac host there is no `setsid`; only the
shell pid is killed.

## Consequences

- The bridge already granted arbitrary shell through the composer's `!` path, over
  tailnet plus token; this route removes the detour through a session, it does not widen
  what a holder of the token can do.
- The credential switch applies to the machine the bridge runs on. A Mac-hosted session
  ([ADR 22](0022-per-machine-roles.md)) still takes the tmux popup.
- Usage-limit detection is out of scope: Claude reports the stop in the thread, and
  resuming is a "continue" per session after the switch.
