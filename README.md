# Claude0

Claude0 is a tmux-based workspace for running and monitoring multiple Claude Code
sessions. It supports two independent modes:

- **Local:** Claude0, tmux, and Claude run on the current computer.
- **Remote:** a Mac or Linux client uses Mosh to attach to an always-on Linux Claude0
  host. tmux owns session persistence; the client is only a terminal.

## Install Claude0 on a computer

Requirements: [Bun](https://bun.sh), tmux, zsh, Git, and Claude Code. Remote
mode also requires Mosh on the client and host.

```sh
mkdir -p ~/dev
git clone https://github.com/marcelmiro/claude0 ~/dev/claude0
cd ~/dev/claude0
bun install
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/claude0.ts" ~/.local/bin/claude0
claude0 setup
```

`claude0 setup` is idempotent. It installs Claude hooks plus narrowly scoped
Claude0-owned extensions at:

```text
~/.config/claude0/tmux.conf
~/.config/claude0/shell.zsh
~/.config/claude0/terminal-launcher  # private transport implementation
~/.local/bin/c0
```

It adds one import line to `~/.tmux.conf` and `~/.zshrc`; it never replaces or
templates personal dotfiles, and none are required — Claude0 installs everything
it needs, including tmux-resurrect (a user-managed TPM copy always takes
precedence over the Claude0-owned clone). See
[ADR 23](docs/adr/0023-dotfiles-independence.md).

### Migrating an existing `~/Documents` installation

Do not move repositories or rename the account with plain `mv`: Git worktree
metadata and Claude transcript identities contain absolute paths. The layout
and account changes can be staged independently. First migrate the layout under
the current home:

```sh
CURRENT_HOME="$HOME"
bun run scripts/migrate-dev-layout.ts preflight \
  --target-home "$CURRENT_HOME" \
  --source-root "$CURRENT_HOME/Documents" \
  --target-root "$CURRENT_HOME/dev"
bun run scripts/migrate-dev-layout.ts apply
```

Immediately before a later account rename, generate a fresh home-only manifest
from the already-migrated layout, then run `apply` on the renamed account:

```sh
bun run scripts/migrate-dev-layout.ts preflight \
  --target-home /Users/marcel \
  --source-root "$HOME/dev" \
  --target-root /Users/marcel/dev
# after the rename, as the new account:
bun run scripts/migrate-dev-layout.ts apply
```

Each apply phase keeps path-state backups under
`~/.config/claude0/migrations/`. See
[ADR 17](docs/adr/0017-user-centric-development-layout.md) for the invariants.

## One user config

```sh
# Print the absolute path, creating the documented defaults on first use:
claude0 config

# Edit it with any editor:
${EDITOR:-vim} "$(claude0 config)"
```

Claude0 has one machine-local, schema-backed settings file. Repository discovery,
terminal attachment, UI, and notification preferences all live in that file; Claude0
does not maintain hidden sidecar settings. The default repository layout is flat:
`~/dev/<repo>`. Set `repositories.priority` only when you want selected repos pinned.

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
