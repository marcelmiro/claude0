# deploy/ — Claude0 on an always-on Linux host

Notes and personal AWS ops for running the whole Claude0 stack (tmux + Claude
Code sessions + the portkey bridge) on a headless Ubuntu 24.04 VM, with the Mac
and iPhone as thin clients over Tailscale. The 2026-08 cutover record is
archived at `../docs/history/vm-cutover-runbook.md`; decision records are ADRs
14–17 and 22–23.

Host provisioning is native: **`claude0 setup --role host`** performs the full
host provisioning (packages, inotify sysctl, swap, TZ, journald cap,
needrestart list-only, bubblewrap AppArmor profile, linger, user units, bridge
token, Tailscale) in one idempotent pass with one sudo authorization, then prints
a guided checklist for the interactive auth steps. `claude0 doctor` is the
read-only audit.

## Contents

| File | Purpose |
|---|---|
| `../config/units/tmux.service` | User unit: tmux server at boot (linger), `claude0 save-sessions` on stop. |
| `../config/units/claude0-bridge.service` | User unit: the bridge, `Restart=always` with spaced retries, token via 0600 `EnvironmentFile`. |
| `../config/units/claude0-monitor.service` | User unit: fallback monitor tick + resurrect autosave while no tmux client is attached (status-right — and continuum riding it — only runs for attached clients). |
| `../config/units/claude0-daemon.service` | User unit: the inbox daemon (snooze wakes, discovery snapshots, sidebar renderer) — systemd twin of darwin's `com.claude0.daemon` launchd agent. Off-darwin the wake alert is a broadcast Web Push (no banner tier on a headless host). |
| `../config/tmux.conf` | Claude0-owned, cross-platform tmux integration installed by `claude0 setup`. Personal tmux settings remain separate. |
| `aws/dlm-policies.sh` | DLM snapshot schedules (4-hourly/3d + daily/14d on `claude0-backup=true` volumes) + budget-stop guardrail pointer. CLI-only — the console can't do sub-daily. |
| `aws/snapshot-check.{service,timer}` | Hourly staleness probe: newest `claude0-backup` snapshot older than 5h → `claude0 notify` pushes to the phone. Personal ops — not installed by `claude0 setup`; copy to `~/.config/systemd/user/` and enable by hand. Needs the aws CLI and an instance role with `ec2:DescribeSnapshots`. |

## Usage

```sh
claude0 setup --role host [--tz <IANA zone>] [--swap-gb <n>]
claude0 doctor
```

`--dry-run` prints the provisioning plan (would-run/skip per step, exact
commands) with no side effects and no sudo prompt. TZ defaults to
`Europe/London`, swap to 16G. Run as the login user; system steps use sudo (one
upfront authorization). Steps needing live systemd or tailscaled are skipped
with a `[skip]` line when unavailable (container smoke-tests), so watch the
output — a skip on a real VM is a problem.

Prerequisites setup checks but cannot create:

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
- **Interactive auth**: `claude` login and `gh auth login` are guided stops —
  setup prints the exact commands instead of attempting them non-interactively.

Claude0 requires no dotfiles: setup installs everything it needs (fragments,
launcher, tmux-resurrect) under `~/.config/claude0/`, and personal dotfiles are
never required, replaced, or templated
([ADR 23](../docs/adr/0023-dotfiles-independence.md)).

Mac-to-VM paste is terminal input, not a Linux clipboard operation: use `Cmd+V`
in Ghostty. VM-to-Mac copy (including Claude0's Space→c) uses OSC 52. Ghostty needs
`clipboard-read = allow` and `clipboard-write = allow`; tmux advertises both
`clipboard` and `bpaste` client features when the chain is healthy. Ghostty's
explicit `super+v=paste_from_clipboard` binding makes the host-to-VM path behave
like a local terminal; no remote clipboard service or tmux prefix is involved.

## After a reboot

Everything must come back with no SSH login (linger): `systemctl --user status
tmux claude0-bridge claude0-monitor` from an SSH one-liner, `tailscale serve status` shows
8473, and the phone reaches the bridge. That's verification scenario 4; scenario 8
covers session restore (resurrect's restore from tmux.service's `ExecStartPost`,
whose post-restore hook runs `claude0 restore-sessions`).
