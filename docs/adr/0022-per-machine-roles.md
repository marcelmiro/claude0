# 22. Every machine declares a deployment role; one Linux host owns the stack

Date: 2026-08-23
Status: accepted

## Context

Claude0 was born Mac-local and adapted to the Linux VM host by hand: shell
scripts (`deploy/provision.sh`, `deploy/doctor.sh`) provisioned the host, and
the one machine-shape signal in code was `terminal.defaultTarget === "remote"`,
read inside the launchd installer. Two machines need different answers to "what
do I install and run here" — the Mac at the desk must not grow a second inbox
daemon, and the host must not grow launchd agents. That guard was implicit,
single-purpose, and easy to defeat.

## Decision

- **`deployment.role: local | host | client`** per install, optional section in
  config.json. `local` = both roles on one machine, the zero-question default
  for new users. Resolution: flag > config > inference (linux → host, darwin
  with a remote `defaultTarget` → client, else local). Setup persists explicit
  flags and host/client resolutions; an *inferred* `local` is deliberately not
  pinned, so setup keeps following `defaultTarget` drift and still retires a
  stale launchd daemon. Inference resolving host/client for the first time is
  confirmed interactively (TTY only); a pinned role is that confirmation and is
  never re-asked.
- **`host` requires linux/systemd.** `--role host` on darwin is refused — a Mac
  holding host duties is `local`.
- **Setup is role-dispatched**: local installs hooks + fragments + launchd
  daemon; client installs the terminal layer only (existing hooks upgraded in
  place, never installed fresh); host additionally runs native provisioning —
  everything provision.sh did (packages, sysctl, swap, TZ, journald, AppArmor,
  linger, units, bridge token, tailscale) in one idempotent pass with one sudo
  authorization and guided stops for interactive auth. `claude0 doctor` is the
  role-aware read-only audit that replaced doctor.sh.
- **Exactly one host at a time, passively enforced**: darwin non-local setup
  boots out the launchd daemon; doctor warns when a client still has a live
  local daemon.
- `deployment` is excluded from DEFAULT_CONFIG materialization (ADR 20 would
  back-fill `role: "local"` onto the VM); it is written only by setup, with the
  point-of-use default in `resolveRole()`.

## Consequences

- The daemon double-install hazard dies structurally; `terminal.defaultTarget`
  survives as the narrower launcher setting.
- An old binary rejects a config carrying the section and falls back to
  defaults — accepted for a single-operator tool; rollback = delete the section.
- Passive exclusivity leaves a manual split-brain path: a second machine
  explicitly pinned `host` runs its own daemon/bridge over a separate inbox.db.
  Accepted; revisit (active claim or bridge handshake) if a second host machine
  ever becomes routine.

## Rejected

- **Global `deployment: local | remote` mode** with platform-inferred roles:
  less explicit, keeps inference load-bearing forever.
- **Active host-claim marker**: adds a stale-claim failure mode that can block
  the only host after a crash.
- **Keeping the shell scripts beside the TS CLI**: two provisioning
  implementations drift, and the scripts could never be role-aware on darwin.
