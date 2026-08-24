# Claude0 on an always-on Linux host

How to run the whole Claude0 stack (tmux, Claude Code sessions, the portkey
bridge) on a headless Ubuntu 24.04 VM, with your Mac and phone as thin clients
over Tailscale.

## Provision

From a claude0 checkout on the host (see the main README's Install section):

```sh
c0 setup --role host [--tz <IANA zone>] [--swap-gb <n>]
c0 doctor
```

Setup provisions everything in one pass with a single sudo authorization:
packages, inotify limits, a swapfile, timezone, journald cap, the bubblewrap
AppArmor profile, user-unit linger, the systemd user units, and the bridge
token. `--dry-run` prints the plan (would-run/skip per step, exact commands)
with no side effects and no sudo prompt. TZ defaults to `Europe/London`; swap
defaults to the machine's RAM size. Run as your login user.

Steps that need live systemd or tailscaled are skipped with a `[skip]` line
when unavailable. That is expected in containers; on a real VM a skip means
something is wrong.

## What setup cannot do for you

- **Tailscale join** is interactive: `sudo tailscale up --ssh
  --hostname=<name> --authkey=<key>`. Use a pre-tagged auth key. Tagging after
  join does not disable key expiry, and an expired node key strands the box.
- **Logins**: `claude` and `gh auth login` are guided stops. Setup prints the
  exact commands instead of attempting them non-interactively.
- **State from another machine.** Starting fresh is fine. To replicate an
  existing install, copy `~/.claude` and `~/.config/claude0` over. Claude Code
  encodes the absolute home path into transcript directory names, so state
  from a machine with a different home needs a rename pass before sessions
  resume: run `scripts/migrate-dev-layout.ts preflight` on the source machine
  with its real `--source-root`/`--target-root`, copy the state, then run
  `apply` on the host.

Claude0 requires no dotfiles: setup installs everything it needs under
`~/.config/claude0/`, and personal dotfiles are never required, replaced, or
templated.

## Clipboard between Mac and VM

Paste into the VM is terminal input: `Cmd+V` in Ghostty, no remote clipboard
service involved. Copy out of the VM (including Claude0's Space→c) uses
OSC 52, which needs Ghostty's `clipboard-read = allow` and
`clipboard-write = allow`. When the chain is healthy, tmux advertises both the
`clipboard` and `bpaste` client features.

## After a reboot

Everything must come back with no SSH login (that is what linger is for).
Healthy looks like:

- `systemctl --user status tmux claude0-bridge claude0-monitor claude0-daemon`
  shows all four active
- `tailscale serve status` shows port 8473, and the phone reaches the bridge
- tmux sessions are restored: tmux.service runs the resurrect restore on
  start, and its post-restore hook runs `claude0 restore-sessions` so Claude
  sessions resume in their panes

## The user units

Installed and enabled by `c0 setup --role host` from `../config/units/`:

| Unit | Purpose |
|---|---|
| `tmux.service` | tmux server at boot; `claude0 save-sessions` on stop. |
| `claude0-bridge.service` | The portkey bridge, `Restart=always`, token via 0600 `EnvironmentFile`. |
| `claude0-monitor.service` | Monitor tick while no tmux client is attached, plus the unconditional 5-min resurrect autosave (the host's only periodic saver). |
| `claude0-daemon.service` | The inbox daemon: snooze wakes, discovery snapshots, sidebar renderer. Wake alerts are Web Push (a headless host has no banner tier). |

## Personal AWS ops (not part of setup)

My own operations for the AWS box; nothing here is installed by `c0 setup`.

| File | Purpose |
|---|---|
| `aws/dlm-policies.sh` | DLM snapshot schedules (4-hourly/3d + daily/14d on `claude0-backup=true` volumes) + budget-stop guardrail pointer. CLI-only; the console can't do sub-daily. |
| `aws/snapshot-check.{service,timer}` | Hourly staleness probe: newest snapshot older than 5h → push to the phone. Copy to `~/.config/systemd/user/` and enable by hand; needs the aws CLI and `ec2:DescribeSnapshots`. |

The 2026-08 cutover record is archived at
`../docs/history/vm-cutover-runbook.md`; decision records are ADRs 14–17 and
22–23.
