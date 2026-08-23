# 16. systemd user units run tmux and the bridge; resurrect never spawns claude

Date: 2026-08-09
Status: accepted

## Context

On the Mac, keeping the stack alive was a pile of workarounds: `caffeinate` so the
laptop wouldn't sleep, a launchd plist or `nohup … & disown` for the bridge, and a
token-recovery trick (`ps eww | grep CLAUDE0_BRIDGE_TOKEN`) because the token lived
only in a process's environment. On an always-on Linux VM those pressures invert:
the host never sleeps, but *everything* must survive reboots and SSH logouts with
nobody watching.

## Decision

- `loginctl enable-linger` — without it, logind kills the user's whole process
  tree (the tmux server and every Claude session in it) when the last SSH session
  closes.
- **tmux and the bridge are systemd user units** (`config/units/`), installed and
  enabled by `claude0 setup` host provisioning (originally
  `deploy/provision.sh`). `WantedBy=default.target` (the user instance
  has no `multi-user.target`; that value silently never starts). The bridge token
  moves to a 0600 `EnvironmentFile` — minted once, no process-environment
  spelunking. Bridge restarts are `Restart=always` with `RestartSec=5s` and
  `StartLimitIntervalSec=300`: the systemd defaults (100ms × 5-in-10s) give up
  permanently after five fast crashes, e.g. a port-in-use loop.
- **Restore pairing**: `tmux.service` `ExecStop` runs `claude0 save-sessions` before
  `kill-server`; `ExecStartPost` runs resurrect's restore script (NOT continuum's
  restore-on-server-start, which races the forking handshake under systemd —
  tmux-continuum #110 — and killed the server), whose post-restore hook then runs
  `claude0 restore-sessions` to resume each pane's Claude session by id.
  `@resurrect-processes` must NOT include claude — resurrect's `ps`-derived
  restore spawns a *fresh* claude while claude0's `--resume` starts the real one: two
  processes fighting over one transcript.

## Consequences

- The CLAUDE.md "bridge restarts" procedure becomes
  `systemctl --user restart claude0-bridge` on the VM; the nohup/token-recovery dance
  applies only to a darwin-hosted bridge.
- User units get no login-shell PATH, and `environment.d` is only read when the
  user manager starts — a file written mid-provisioning is invisible until reboot
  (hit live: the bridge crash-looped on `env: 'bun': No such file`). The units
  carry `Environment=PATH=%h/.bun/bin:…` themselves, so install order can't
  break them.

## Rejected

- **Start-on-first-SSH** (profile hooks): leaves the box dead after an unattended
  reboot until a human logs in — the exact failure this migration exists to end.
- **System-level units running as the user**: work without linger but put user
  code in the system manager, complicate `systemctl --user` ergonomics, and gain
  nothing here.
- **Letting resurrect restore claude processes** — see Decision; guaranteed
  double-process fight.
