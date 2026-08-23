# deploy/ — Claude0 on an always-on Linux host

Provisioning for running the whole Claude0 stack (tmux + Claude Code sessions + the
portkey bridge) on a headless Ubuntu 24.04 VM, with the Mac and iPhone as thin
clients over Tailscale. The cutover itself (state copy, auth, PWA reinstall) is
`RUNBOOK.md`; decision records are ADRs 14–17.

## Contents

| File | Purpose |
|---|---|
| `provision.sh` | Idempotent Claude0 host setup — runtime packages, inotify sysctl, swap, TZ, journald cap, needrestart list-only, bubblewrap AppArmor profile, linger + user units, bridge token, and Tailscale. It requires the Linux dotfiles profile and does not own terminal presentation or plugins. Re-run any time. |
| `units/tmux.service` | User unit: tmux server at boot (linger), `claude0 save-sessions` on stop. |
| `units/claude0-bridge.service` | User unit: the bridge, `Restart=always` with spaced retries, token via 0600 `EnvironmentFile`. |
| `units/claude0-monitor.service` | User unit: fallback monitor tick + resurrect autosave while no tmux client is attached (status-right — and continuum riding it — only runs for attached clients). |
| `units/claude0-daemon.service` | User unit: the inbox daemon (snooze wakes, discovery snapshots, sidebar renderer) — systemd twin of darwin's `com.claude0.daemon` launchd agent. Off-darwin the wake alert is a broadcast Web Push (no banner tier on a headless host). |
| `../config/tmux.conf` | Claude0-owned, cross-platform tmux integration installed by `claude0 setup`. Personal tmux settings remain separate. |
| `doctor.sh` | Read-only post-provision audit of Claude0 integration, auth, services, bridge, Tailscale, and host capacity. Run `~/.dotfiles/doctor` for tmux UI, bindings, clipboard, and TPM. |
| `aws/dlm-policies.sh` | DLM snapshot schedules (4-hourly/3d + daily/14d on `csm-backup=true` volumes) + budget-stop guardrail pointer. CLI-only — the console can't do sub-daily. |
| `units/snapshot-check.{service,timer}` | Hourly staleness probe: newest `csm-backup` snapshot older than 5h → `claude0 notify` pushes to the phone. Needs the aws CLI and an instance role with `ec2:DescribeSnapshots`. |

## Usage

```sh
git clone git@github.com:marcelmiro/dotfiles.git ~/.dotfiles
~/.dotfiles/install linux
~/.dotfiles/bin/setup-linux

./provision.sh --tz Europe/Madrid --swap-gb 16
claude0 setup
~/.dotfiles/doctor
./doctor.sh
```

Run as the login user; system steps use sudo. Steps needing live systemd or
tailscaled are skipped with a `[provision skip]` line when unavailable (container
smoke-tests), so watch the output — a skip on a real VM is a problem.

Prerequisites the script checks but cannot create:

- **Any home path works.** Claude Code encodes the absolute cwd into transcript
  directory names, so `~/.claude` state copied from a host with a *different* home
  needs a rename pass before sessions resume — matching homes byte-for-byte just
  makes that step a no-op (ADR 15, retired). `scripts/migrate-dev-layout.ts` is the
  existing rename machinery (manifest-driven `sourceHome` → `targetHome`), built for
  a same-host account rename: for a cross-host move, run `preflight` on the source
  host with real `--source-root`/`--target-root` values, copy state, then `apply` on
  the target (its home must already equal the manifest's `targetHome`).
- **Tailscale join** is interactive by design: `sudo tailscale up --ssh
  --hostname=<name> --authkey=<key>`. Use a **pre-tagged auth key** — tagging after
  join does not disable key expiry, and an expired node key strands the box.
- **bun + c0 + claude** installs are in the runbook (they're user-level, not host
  provisioning).

The Linux host installs the explicit `common + linux` Stow profiles from the
personal dotfiles repository. This imports the same tmux presentation, bindings,
clipboard behavior, and TPM-managed plugins as macOS without linking macOS app
configuration. `claude0 setup` owns and updates only its application fragments under
`~/.config/claude0/`.

Mac-to-VM paste is terminal input, not a Linux clipboard operation: use `Cmd+V`
in Ghostty. VM-to-Mac copy (including Claude0's Space→c) uses OSC 52. Ghostty needs
`clipboard-read = allow` and `clipboard-write = allow`; tmux advertises both
`clipboard` and `bpaste` client features when the chain is healthy. `doctor.sh`
checks the remote half and prints the attached client's capabilities. Ghostty's
explicit `super+v=paste_from_clipboard` binding makes the host-to-VM path behave
like a local terminal; no remote clipboard service or tmux prefix is involved.

## After a reboot

Everything must come back with no SSH login (linger): `systemctl --user status
tmux claude0-bridge claude0-monitor` from an SSH one-liner, `tailscale serve status` shows
8473, and the phone reaches the bridge. That's verification scenario 4; scenario 8
covers session restore (resurrect's restore from tmux.service's `ExecStartPost`,
whose post-restore hook runs `claude0 restore-sessions`).
