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

Images can't ride the terminal (mosh drops every image-capable sequence), so
`c0 setup --role client` installs a macOS Service: **Cmd+Shift+V** in the
terminal runs `claude0 paste-image`, which ships the clipboard PNG over ssh to
`claude0 receive-image` on the host; the host stores it under
`~/.config/claude0/uploads/` and pastes the path into the focused Claude
prompt, which renders it as `[Image #1]` — the same path phone attachments
take. Ghostty must not bind the chord (`keybind = super+shift+v=unbind`;
`c0 doctor` warns otherwise). Refusals (no image, no Claude prompt focused,
host unreachable) surface as macOS notifications; the chord is
`terminal.imagePasteKey` in the config
([ADR 27](../docs/adr/0027-image-paste-is-a-service-hotkey-plus-path-paste.md)).

## After a reboot

Everything must come back with no SSH login (that is what linger is for).
Healthy looks like:

- `systemctl --user status tmux claude0-bridge claude0-monitor claude0-daemon`
  shows all four active
- `tailscale serve status` shows port 8473, and the phone reaches the bridge
- tmux sessions are restored: tmux.service runs the resurrect restore on
  start, and its post-restore hook runs `claude0 restore-sessions` so Claude
  sessions resume in their panes

**Before a planned reboot, run `claude0 resurrect save`.** The pane→session map
is written only with resurrect's periodic layout snapshot (every ~5 min), so a
session started since the last one isn't resumed otherwise. `restore-sessions`
skips panes already running a foreground process and resumes each session id at
most once; which directory it resumes in is `resolveRestoreTarget`
(`core/resurrect.ts`).

## The user units

Installed and enabled by `c0 setup --role host` from `../config/units/`:

| Unit | Purpose |
|---|---|
| `tmux.service` | tmux server at boot; resurrect restore on start, `kill-server` on stop (no session-map save at stop, [ADR 16](../docs/adr/0016-systemd-units-replace-launchd.md)). |
| `claude0-bridge.service` | The portkey bridge, `Restart=always`, token via 0600 `EnvironmentFile`. |
| `claude0-monitor.service` | Monitor tick while no tmux client is attached, plus the unconditional 5-min resurrect autosave (the host's only periodic saver). |
| `claude0-daemon.service` | The inbox daemon: snooze wakes, discovery snapshots, sidebar renderer. Wake alerts are Web Push (a headless host has no banner tier). |

## Tailscale: relay-only on the VM (not part of setup)

Phone requests (GET, POST, SSE pushes) used to stall 3–15s mid-session while the
bridge answered in milliseconds. A recorder on the VM (`tailscale status` every
250ms) tied every stall to a mobile peer flipping from direct to relay: on a 4G
SIM router the direct UDP path died every 7–60s. magicsock sends UDP-only while
a path is trusted (a pong extends trust 6.5s; heartbeats every 3s), so a dead
path black-holes traffic for 3.5–6.5s before DERP takes over, plus TCP
retransmit backoff. The `CurAddr` flip in `tailscale status` marks the END of
that window. None of those timers is tunable, and the EC2 security group
already allowed inbound UDP 41641.

So the VM's tailscaled runs with `TS_DEBUG_NEVER_DIRECT_UDP=1` in
`/etc/default/tailscaled` (the unit's `EnvironmentFile`): no direct paths to
any peer, everything via DERP over TCP 443. The London DERP is 1.3ms from the
VM; throughput is DERP's unpublished QoS (~15 Mbit/s observed) — fine for
portkey and mosh, slower for bulk transfers.

The knob is an unsupported debug interface. After a tailscale upgrade, confirm
`envknob: TS_DEBUG_NEVER_DIRECT_UDP="1"` in `journalctl -u tailscaled` and that
`tailscale ping <peer>` says "via DERP". A per-device alternative is an
`only-tcp-443` nodeAttr on a tagged device; it is undocumented, and untried
because tagging a device detaches it from its user.

Stalls also explain stale portkey code after a deploy: the shell cache serves
the cached shell whenever the network is slower than `NET_TIMEOUT_MS`
([ADR 21](../docs/adr/0021-offline-app-shell.md)); the fresh copy only lands
for the next launch.

## Personal AWS ops (not part of setup)

My own operations for the AWS box; nothing here is installed by `c0 setup`.

| File | Purpose |
|---|---|
| `aws/dlm-policies.sh` | DLM snapshot schedules (4-hourly/3d + daily/14d on `claude0-backup=true` volumes) + budget-stop guardrail pointer. CLI-only; the console can't do sub-daily. |
| `aws/snapshot-check.{service,timer}` | Hourly staleness probe: newest snapshot older than 5h → push to the phone. Copy to `~/.config/systemd/user/` and enable by hand; needs the aws CLI and `ec2:DescribeSnapshots`. |

The 2026-08 cutover record is archived at
`../docs/history/vm-cutover-runbook.md`; decision records are ADRs 14–17 and
22–23.
