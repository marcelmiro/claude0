# Claude0: inbox zero for coding agents

No Claude Code session should sit idle waiting for you to notice it finished
or got stuck. We treat sessions the way inbox zero treats email: everything is
either running or resolved. That's the entire idea behind Claude0.

Parallel sessions are cheap to start and expensive to babysit: each one halts
the moment it needs an answer, and the only way to know is to go back and
check. Claude0 watches all of them and brings you the ones that are blocked,
at your desk or on your phone.

## Features

- **Inbox.** Sessions sort by lifecycle: Needs you, Running, Parked,
  Recently done. You work to keep Needs you empty, acting on each session and
  moving to the next; that's the 0 in Claude0. Snoozed sessions wake
  themselves when due; blocked ones wait in Parked with a note.
- **Notifications.** tmux markers and macOS banners at the
  desk, Web Push to your phone when you're away. Pushes go only to the device
  you last messaged the session from.
- **Phone access.** A web app shows each session's full conversation and lets
  you approve tools, answer questions, send messages, run bash commands, and
  read branch diffs.
- **Session persistence.** Sessions survive tmux restarts and reboots; the
  layout autosaves every 5 minutes.
- **Worktree-aware.** New sessions can launch into per-branch git worktrees,
  and worktree sessions group under their base repo.

Everything runs on your computer, or on an always-on Linux host with your Mac
and phone as thin clients (see [Remote mode](#remote-mode)).

## Install

You need [Bun](https://bun.sh), tmux, Git, and
[Claude Code](https://code.claude.com/docs/en/installation) on PATH. Remote
mode also needs Mosh on both machines. On macOS:

```sh
brew install tmux git oven-sh/bun/bun
brew install --cask claude-code
```

A brew-managed Claude Code does not update itself; run `brew upgrade`.

Clone anywhere and run setup:

```sh
git clone https://github.com/marcelmiro/claude0
cd claude0
bun run setup
```

Setup is idempotent. It installs the `c0` command (long form: `claude0`),
Claude Code hooks, tmux and zsh fragments, session persistence, and the inbox
daemon. It never replaces personal dotfiles. Update later with
`git pull && bun run setup`.

## Usage

Everything is keyboard-driven from inside tmux. `prefix` is tmux's prefix
key, `ctrl+b` unless you changed it. Press it, release, then type the rest,
so `prefix ctrl+a` means `ctrl+b`, release, `ctrl+a`.

```text
alt+s           focus the inbox sidebar, from any window
alt+shift+s     show or hide the inbox sidebar
prefix a        open the full session manager in a popup
prefix ctrl+a   jump to the next session that needs you
```

The whole workflow is that last key. A session needs you, `prefix ctrl+a`
jumps to it, you act, you jump again. When Needs you is empty, you're done.

```sh
c0                    # list all commands
c0 config             # print the config file's path
code $(c0 config)     # open the config in your IDE, swap `code` for yours
```

Remap any of these keys under `tmux.keys` in the config.

## Remote mode

The install splits across two machines: a Linux host that runs everything,
and a client that is only a terminal.

On the remote machine, follow [Install](#install) above, then provision it:

```sh
c0 setup --role host
c0 doctor
```

Unlike on Mac, the host installs its own packages. Setup cannot log in for
you; it ends by printing the interactive steps left (`claude`, `gh auth
login`, `tailscale up`). See [deploy/README.md](deploy/README.md) for
details, including the `--tz` and `--swap-gb` overrides.

The host needs nothing from your Mac. To replicate an existing local setup
instead, copy `~/.claude` and `~/.config/claude0` over and clone your repos
(different home paths need a rename pass first; see
[deploy/README.md](deploy/README.md)).

Then, on your local machine:

```sh
c0 setup --role client   # asks for the host, points `c0 terminal` at it
c0 terminal              # attach over Mosh
```

If you use Ghostty (or any terminal with a configurable startup command),
point it at `c0 terminal` so a failed connection or detach falls through to a
local login shell:

```text
/bin/zsh -lc '"$HOME/.local/bin/c0" terminal; exec /bin/zsh -l'
```

The host's Mosh server keeps a 30-day reconnect window, so a slept or roaming
laptop reconnects to the same terminal.

### Phone

The host serves the phone app over Tailscale. Grab the login token and the
URL on the host:

```sh
c0 bridge token          # the login token
tailscale serve status   # the app is the https:// line (proxy to port 8473)
```

Then on your phone:

1. Install the Tailscale app and log in to the same tailnet as the host.
2. Open the https URL and paste the token when prompted. You should see your
   sessions listed.
3. Add the page to your home screen (Share > Add to Home Screen) and open it
   from that icon; push notifications only work in the installed app. Allow
   them from the bell in the navbar when it appears.
