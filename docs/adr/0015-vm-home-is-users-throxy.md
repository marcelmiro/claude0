# 15. The Linux VM user's home is /Users/throxy

Date: 2026-08-09
Status: superseded by ADR 17; the home-path constraint itself was retired 2026-08-23

> **Retirement note (2026-08-23):** nothing in claude0 depends on the `/Users`
> prefix — any `$HOME` works, and provision/doctor no longer check it. The
> constraint only ever mattered at migration boundaries: moving `~/.claude`
> state between hosts with different homes requires the rename pass
> (`scripts/migrate-dev-layout.ts`, manifest-driven `sourceHome` → `targetHome`),
> which was rejected below as a *recurring* cost but is the supported path for a
> one-time move.

## Context

Claude Code encodes the **absolute** cwd into its transcript directory names
(`~/.claude/projects/<encoded-cwd>/…`), and Claude0 state references the
same paths (`repoPaths`, name cache keys, resurrect cwds). Moving the setup to a
Linux host whose home is `/home/<user>` would rename every encoded directory,
orphaning every copied transcript: sessions stop resolving, resume tails frozen
copies, and discovery blanks live panes.

## Decision

Create the VM user with home **`/Users/throxy`**:

```sh
sudo mkdir -p /Users            # useradd does NOT create the parent (verified)
sudo useradd -m -d /Users/throxy -s /usr/bin/zsh throxy
```

Linux attaches no meaning to `/Users` — it's just a directory. Every encoded
transcript dir, config path, `repoPaths` entry, and rsync command then matches the
Mac byte-for-byte, and no re-encoding pass exists to get wrong.
`deploy/provision.sh` verifies the layout and warns loudly when it doesn't hold.

## Consequences

- Anything that hardcodes `/home` (rare; some dotfile installers, quota defaults)
  needs a second look. PAM, logind linger, systemd user units, SSH, and package
  managers are all `$HOME`-driven and unaffected (container-verified for the
  provisioning path).
- `adduser`-based tooling defaults to `/home`; the runbook uses `useradd -d`
  explicitly.

## Rejected

- **Rename pass** over `~/.claude/projects/` (`-Users-throxy-…` → `-home-throxy-…`)
  plus `repoPaths` edits: a migration step that must be re-derived for every future
  copy in either direction, and one missed directory silently breaks one session.
  Kept only as the documented fallback if a host ever forbids the home layout.
- **Symlink** `/Users/throxy → /home/throxy`: tools that realpath (lsof's output
  matching in Claude0 does, deliberately) see the `/home` form, so the two encodings
  drift apart inside one host — worse than either clean layout.
