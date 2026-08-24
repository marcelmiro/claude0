# Claude0

Claude0 is a tmux-based workspace for running and monitoring multiple Claude Code
sessions. It supports two independent modes:

- **Local:** Claude0, tmux, and Claude run on the current computer.
- **Remote:** a Mac or Linux client uses Mosh to attach to an always-on Linux Claude0
  host. tmux owns session persistence; the client is only a terminal.

## Prerequisites

Claude0 needs [Bun](https://bun.sh), tmux, Git, and
[Claude Code](https://claude.ai/install.sh) on PATH. Remote mode also requires
Mosh on the client and host.

Claude0 never installs system packages on a Mac — your package manager is
yours. On macOS:

```sh
brew install tmux git
curl -fsSL https://bun.sh/install | bash
curl -fsSL https://claude.ai/install.sh | bash
```

A Linux **host** is the exception: `claude0 setup --role host` provisions its
own packages (see below). `claude0 setup` warns about any missing required
tool, and `claude0 doctor` audits the full installation.

## Install

Clone anywhere and run one command:

```sh
git clone https://github.com/marcelmiro/claude0
cd claude0
bun run setup
```

`bun run setup` installs dependencies and runs `claude0 setup`, which is
idempotent and installs everything else:

- the `claude0` and `c0` commands in `~/.local/bin` (symlinks to the checkout)
- Claude Code lifecycle hooks under `~/.config/claude0/hooks`
- narrowly scoped tmux/zsh fragments plus one import line in `~/.tmux.conf`
  and `~/.zshrc`
- session persistence: tmux-resurrect (pinned clone; a user-managed TPM copy
  always takes precedence), its save/restore hooks, and a periodic layout save
  every 5 minutes — no tmux-continuum needed
- the inbox daemon (launchd on macOS; a systemd user unit on a Linux host)

Personal dotfiles, prompts, and tmux presentation are never replaced or
templated, and none are required — see
[ADR 23](docs/adr/0023-dotfiles-independence.md). To update later:
`git pull && bun run setup`. Verify any install with `claude0 doctor`.

Migrating a pre-`~/dev` installation? See
[docs/history/migrate-documents-layout.md](docs/history/migrate-documents-layout.md).

## One user config

```sh
# Print the absolute path, creating the documented defaults on first use:
claude0 config

# Edit it with any editor:
${EDITOR:-vim} "$(claude0 config)"
```

Claude0 has one machine-local, schema-backed settings file. Repository discovery,
terminal attachment, UI, and notification preferences all live in that file; Claude0
does not maintain hidden sidecar settings. `repositories.roots` defaults to the
directory the claude0 checkout lives in (repositories stay flat under each root).
Set `repositories.priority` only when you want selected repos pinned.

## Local and remote terminal modes

Set `terminal.defaultTarget` and `terminal.remoteHost` in `$(claude0 config)`, then:

```sh
# Explicit invocations do not mutate the default:
claude0 terminal local
claude0 terminal remote
claude0 terminal status

# No argument uses terminal.defaultTarget:
claude0 terminal
```

On macOS, Ghostty invokes the Claude0 command so a failed connection or detach falls
through to a local login shell:

```text
/bin/zsh -lc '"$HOME/.local/bin/c0" terminal; exec /bin/zsh -l'
```

Remote mode requires Mosh on both machines. Hostname, mode, and session choices
are fields in the machine-local `~/.config/claude0/config.json`.
The remote Mosh server keeps a reconnect window of 30 days so ordinary laptop
sleep, roaming, and travel do not strand an open terminal.

## Provision an always-on Linux host

```sh
cd ~/dev/claude0
claude0 setup --role host --tz Europe/Madrid --swap-gb 16
claude0 doctor
```

One idempotent pass with a single sudo authorization; interactive auth
(`claude`, `gh`, `tailscale up`) ends as a printed checklist. See
[deploy/README.md](deploy/README.md) for prerequisites and the role model in
[ADR 22](docs/adr/0022-per-machine-roles.md).
