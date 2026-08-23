# 23. Claude0 depends on no dotfiles; resurrection is claude0-provided

Date: 2026-08-23
Status: accepted

## Context

Host provisioning hard-failed without five files from the operator's private
dotfiles repo, two shipped units hardcoded its TPM tmux-resurrect paths, and
the README told host installers to clone and Stow that repo before claude0.
The only *functional* dependency in all of it was tmux-resurrect; the rest was
personal taste riding the product's install path.

## Decision

**Independence contract**: claude0 installs and owns everything it needs, and
personal dotfiles are never required, replaced, or templated.

- Claude0's fragments live under `~/.config/claude0/`; the only touch on
  personal files is one import line added to `.zshrc` and `.tmux.conf` (skipped
  when a dotfiles layer already sources the fragment). The terminal launcher is
  rendered by setup with the `terminal.*` values baked in.
- Resurrection becomes claude0-essential. `claude0 resurrect save|restore`
  resolves the plugin at runtime: a user-managed TPM copy always wins
  (`~/.config/tmux/plugins`, legacy `~/.tmux/plugins`, or an unconventional
  location detected via `@resurrect-save-dir` presence); otherwise claude0
  clones its own copy under `~/.config/claude0/plugins/`, pinned to a
  known-good commit, never tracking master, and loads it from the claude0 tmux
  fragment. The units call the subcommand, not a hardcoded path.
- Claude0 owns, for its own installs, the `@resurrect-processes` must-not-
  contain-`claude` invariant (ADR 16).
- Either side installs first; a setup re-run heals; `claude0 doctor` detects
  staleness and warns on a double-load (fragment run-shell line while a
  user-managed copy resolves).

## Consequences

- Fresh users get working resurrection with zero dotfiles; the operator's
  TPM-managed copy keeps winning byte-for-byte.
- A TPM copy installed *after* setup double-loads until the next setup re-run
  (doctor warns; re-run heals). An orphaned claude0 clone left behind by a TPM
  handover is accepted.

## Rejected

- **Requiring the personal Stow dotfiles repo on hosts** (the old flow):
  couples the product to one person's private repo and makes every fresh
  install a two-repo ritual.
- **A provision.d hook directory**: preserves the coupling politely — the
  premise was rejected, not the mechanism.
- **Reimplementing resurrect natively**: the pane-layout machinery is
  battle-tested; owning the *install* suffices.
- **Templating the unit files**: no unit templating exists; runtime resolution
  via the subcommand is the smaller mechanism.
