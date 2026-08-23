# Cutover runbook — Mac → Linux VM

> **Historical record** of the 2026-08 Mac→VM cutover. Provisioning a host today is
> `claude0 setup --role host` ([ADR 22](../adr/0022-per-machine-roles.md)); the
> scripts and dotfiles steps below no longer exist.

Ordered, one sitting (~2h active). The Mac keeps working until phase F, so nothing
is burned before the VM is proven. State dispositions come from the migration
table in the plan (copy vs regenerate vs discard); decisions: ADRs 14–17.

## A. Launch (AWS, eu-central-1)

1. Instance: **r7i.2xlarge**, Ubuntu 24.04 LTS x86 AMI, EBS-only (no instance
   store). gp3 sized ~3× the measured data (63 GB → **200 GB**, baseline IOPS;
   growth is one online `modify-volume`, shrink is impossible). Security group:
   **no inbound** except UDP 41641 (Tailscale direct); all egress open — plus a
   TEMPORARY tcp/22 rule from your current IP for phases A–C, revoked once
   Tailscale SSH works.
2. IMDSv2: `--metadata-options "HttpTokens=required,HttpPutResponseHopLimit=2"`
   (plain-API r7i launches still default to optional).
3. First boot, as `ubuntu`:
   ```sh
   DEV_USER=marcel
   sudo mkdir -p /Users && sudo useradd -m -d "/Users/$DEV_USER" -s /usr/bin/zsh "$DEV_USER"   # useradd won't create /Users itself
   echo "$DEV_USER ALL=(ALL) NOPASSWD:ALL" | sudo tee "/etc/sudoers.d/$DEV_USER"
   sudo install -d -m 700 -o "$DEV_USER" "/Users/$DEV_USER/.ssh"
   sudo cp ~/.ssh/authorized_keys "/Users/$DEV_USER/.ssh/" && sudo chown "$DEV_USER" "/Users/$DEV_USER/.ssh/authorized_keys"
   ```
4. NVMe timeout (an EBS blip can remount the FS read-only at the 30s default):
   `nvme_core.io_timeout=4294967295` appended to `GRUB_CMDLINE_LINUX` in
   `/etc/default/grub`, then `sudo update-grub`. Verify any extra volumes mount by
   UUID with `nofail`.
5. Reboot once; log in as `marcel`. Keep the same short name and `/Users/marcel`
   home on Mac and VM so Claude transcript paths remain portable.

## B. Provision

```sh
git clone git@github.com:marcelmiro/dotfiles.git ~/.dotfiles
~/.dotfiles/install linux                                  # common tmux UI + Linux shell profile + TPM
~/.dotfiles/bin/setup-linux                                # personal zsh, Neovim, and Linux tools
mkdir -p ~/dev
git clone https://github.com/marcelmiro/claude0 ~/dev/claude0
~/dev/claude0/deploy/provision.sh --tz Europe/Madrid --swap-gb 16
curl -fsSL https://bun.sh/install | bash                       # bun → ~/.bun/bin
cd ~/dev/claude0 && bun install && ln -sf ~/dev/claude0/bin/claude0.ts ~/.bun/bin/claude0
curl -fsSL https://claude.ai/install.sh | bash -s stable       # claude (self-updating channel)
claude0 setup                                                     # hooks + tmux/zsh fragments
sudo tailscale up --ssh --hostname=<name> --authkey=<PRE-TAGGED key>   # tag at join or expiry stays on
sudo tailscale serve --bg 8473
```

To inherit the Mac's tailnet hostname, rename/remove the Mac node FIRST — a
collision silently mints `<name>-1` and the phone points at the wrong origin.

## C. Auth (all headless-capable)

- `claude` → press `c` to copy the login URL, open on the phone/Mac, paste code back.
- `gh auth login --git-protocol https` (device flow) then `gh auth setup-git`.
- Commit signing → SSH format (gpg-agent blocks forever on headless pinentry):
  ```sh
  ssh-keygen -t ed25519 -f ~/.ssh/signing -N ''
  git config --global gpg.format ssh
  git config --global user.signingkey ~/.ssh/signing.pub
  ```
- Guardrail (load-bearing): PR-required ruleset on `main` in the repos the agent
  pushes to. The VM's key is functionally a deploy key.

## D. State copy (Mac → VM)

On the Mac (VM reachable as `vm` over Tailscale):

```sh
launchctl bootout gui/$UID/com.claude0.daemon                             # stop the inbox daemon first (also teardown, below)
sqlite3 ~/.config/claude0/inbox.db "PRAGMA wal_checkpoint(TRUNCATE);"     # fold WAL into the db file before copying it
rsync -a --info=progress2 ~/dev/ vm:dev/                              # flat repos; worktrees travel inside each base repo
rsync -a ~/.claude/projects/ vm:.claude/projects/                     # transcripts resolve as-is
scp ~/.config/claude0/config.json ~/.config/claude0/names.json ~/.config/claude0/push-vapid.json ~/.config/claude0/inbox.db vm:.config/claude0/
```

`inbox.db` carries the authored inbox state — open snoozes, block notes, the
event history behind the ✓ scoreboard. A snooze pending at cutover must wake on
the VM (repo paths inside stay valid via `/Users` parity; the activity snapshot
table self-rebuilds on the VM's first discovery tick).

Do NOT copy: `push-subscriptions.json` (origin-bound — dead at the new origin),
`state.json`, `panes/`, `hook-events`, `resurrect-sessions.json`, `verdicts/`,
`script-wait.json`, `consumers/ source/ pushed/ pending/ decisions/` (all
host-local or transient), `~/.claude/.credentials.json` (fresh login, phase C),
`~/.claude/settings.json` (next line regenerates hooks at the current version).

Then on the VM: `claude0 setup`.

## E. Bring up + verify

```sh
systemctl --user daemon-reload && systemctl --user start tmux claude0-bridge claude0-monitor claude0-daemon snapshot-check.timer
```

Run verification scenarios **4** (reboot with no SSH → everything back), **5/6**
(presence: typing suppresses pushes; idle attach routes approvals/questions to the
phone), **8** (reboot with live sessions → `claude0 restore-sessions` resumes each,
no duplicate claude per pane), **9** (Space→c over Mosh lands in the Mac
clipboard), **7** (phone lists sessions, resume works, push round-trips).

## F. Point the clients at it

- iPhone: Tailscale app → VPN On Demand → cellular **Always**. Delete the old
  portkey icon; open `https://<vm>.<tailnet>.ts.net`, Add to Home Screen, re-grant
  push (the bell — permission needs the tap), confirm a test push.
- Mac: `brew install mosh`; run `claude0 setup`, then set `terminal.remoteHost` and
  `terminal.defaultTarget` in `$(claude0 config)`. Ghostty runs
  `claude0 terminal` at startup; `claude0 terminal local` remains available
  for a completely separate Mac-local Claude0/tmux environment.
  `shell-integration-features = ssh-env,ssh-terminfo`, `clipboard-write = allow`.
- Mac teardown: stop the launchd bridge / `caffeinate` wrapper, remove the plist,
  stop the monitor, and boot out the inbox daemon (`launchctl bootout
  gui/$UID/com.claude0.daemon` + delete `~/Library/LaunchAgents/com.claude0.daemon.plist`
  — two daemons against two tmux servers means two divergent inboxes). Leave
  `~/.config/claude0` and repos in place as the rollback seed.
- Flip CLAUDE.md's "Bridge restarts" section to the systemd procedure
  (`systemctl --user restart claude0-bridge`, log: `journalctl --user -u claude0-bridge`),
  keeping the darwin procedure as a footnote (ADR 16).

## G. Rollback (valid ~days)

Stop VM units → restart Mac monitor/bridge (old instructions) → reinstall the PWA
at the Mac origin → rsync back only `~/.claude/projects/` deltas for sessions
touched on the VM. The Mac's untouched `~/.config/claude0` does the rest. After the
window, restore from the VM's EBS snapshots instead (the DLM schedules in
`aws/dlm-policies.sh`).
