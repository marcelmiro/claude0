# 27. Image paste is a macOS Service hotkey plus a path paste

Date: 2026-08-25
Status: accepted

## Context

Claude Code pastes a clipboard image on Ctrl+V by reading the clipboard of the
machine it runs on. In the remote deployment (ADR 22) that machine is the Linux
host: it has no pasteboard, and the terminal channel cannot carry the image —
mosh forwards only the sequences it models (OSC 52 writes ≤16 KB, bracketed
paste) and drops DCS/APC/OSC 1337/OSC 5522, so no terminal protocol reaches the
host. Every working tool in the wild (Claude Code issue #5277's closing advice
included) uses the same shape: a distinct chord, a side channel, and the file
path pasted into the prompt.

The constraints: nothing new for users to install (no Karabiner/Hammerspoon), a
single-shot `claude0 setup`, no daemon or listener on either side, no bridge
token on the Mac, and no fallback mechanism.

## Decision

`claude0 setup --role client` installs a macOS **Service** — an Automator Quick
Action bundle copied into `~/Library/Services/claude0 paste-image.workflow`,
scoped to the terminal app (`NSRequiredContext.NSApplicationIdentifier` =
`notifications.terminalBundleId`) — and registers its hotkey in the `pbs`
defaults domain (`NSServicesStatus`, `key_equivalent` rendered from
`terminal.imagePasteKey`, default **Cmd+Shift+V**). The Service runs
`claude0 paste-image`:

1. a `mkdir` lock (`~/.config/claude0/paste-image.lock`, holding the owner's
   pid; reclaimed when that process is gone) collapses the Service's
   per-key-repeat firings into one run;
2. the pasteboard PNG is written to a 0600 temp file with the AppleScript recipe
   Claude Code itself uses locally (`the clipboard as «class PNGf»` →
   `write … to fp`; osascript's stdout would be the textual `«data PNGf…»`
   form);
3. the file is piped over the Mac's existing ssh to
   `ssh <terminal.remoteHost> claude0 receive-image` (BatchMode, 5 s connect
   timeout);
4. on the host, `receive-image` stores it as `~/.config/claude0/uploads/<uuid>.png`
   (the portkey upload path; pruned after 24 h) and bracketed-pastes the path
   into the active pane of the most recently active tmux client — Claude Code
   renders that as `[Image #N]`, exactly like a portkey attachment
   (`sendBracketedPaste`, ADR 6). Path only, no Enter.

Every refusal is a macOS notification: no image, image over 20 MB, host unset
or unreachable, no client attached, or the focused pane isn't a Claude prompt
(no live `claude` process on the pane's tty — the same ps×tmux correlation
session discovery uses; `pane_current_command` reads the launching shell for
some panes — or the prompt is in `!` shell mode, where a plain send would
execute the path as bash, ADR 12). Nothing runs between pastes.

`claude0 doctor` (client) re-renders the bundle and compares, checks the `pbs`
entry, warns when Ghostty still binds `super+shift+v` (its default
`paste_from_selection` wins over the Service), probes the host over ssh, and
reports a stale lock.

## Rejected

- **Terminal protocols.** Ghostty keybinds can't run commands; `super+v` is
  text-only; OSC 52 reads return nothing for images; OSC 5522 (Kitty clipboard)
  is unreleased in Ghostty and dropped by mosh anyway.
- **Xvfb + native Ctrl+V** (sync the Mac clipboard into an X clipboard on the
  host so Claude Code's own `xclip` path works). Needs either a Mac-side watcher
  daemon or a Mac listener, plus an X server the host otherwise has no use for.
- **Host pulls from the Mac** over sshd. Remote Login listens on every
  interface, scripting it needs Full Disk Access, and it's another install step.
- **Karabiner / Hammerspoon** hotkeys. A tool dependency the project has ruled
  out (ADR 23).
- **Upload through the bridge.** The Mac would need the phone token.
- **Ctrl+V with a pasteboard probe.** Ghostty owns the key; there is no hook
  between the key and the terminal without one of the tools above.

## Consequences

- Ghostty's default `super+shift+v=paste_from_selection` must be unbound
  (`keybind = super+shift+v=unbind`); doctor warns, README documents it.
- Automator bundles must be its own output: hand-written plists are rejected
  as "damaged". `config/service/` holds the captured files with three tokens.
- The image travels Mac → host once, over Tailscale ssh; no copy of it is kept
  on the Mac after the run.
- Single-operator assumption: with two Mac terminals attached to the same tmux
  server the paste lands in the most recently active one.
