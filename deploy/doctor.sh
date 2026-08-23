#!/usr/bin/env bash
# Read-only health check for a provisioned Claude0 Linux host. It deliberately never
# prints credentials or the bridge token.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE0_TMUX_SOURCE="if-shell 'test -f ~/.config/claude0/tmux.conf' 'source-file ~/.config/claude0/tmux.conf' ''"
# Literal line expected in the user's zsh configuration.
# shellcheck disable=SC2016
CLAUDE0_ZSH_SOURCE='[[ -r "$HOME/.config/claude0/shell.zsh" ]] && source "$HOME/.config/claude0/shell.zsh"'

failures=0

# Bridge port: default 8473; the bridge EnvironmentFile (sourced below) overrides.
BRIDGE_PORT="${CLAUDE0_BRIDGE_PORT:-8473}"
warnings=0

pass() { printf '\033[32m[ok]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[fail]\033[0m %s\n' "$*"; failures=$((failures + 1)); }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; warnings=$((warnings + 1)); }

expect_eq() {
  local label="$1" actual="$2" wanted="$3"
  if [ "$actual" = "$wanted" ]; then
    pass "$label = $wanted"
  else
    fail "$label = ${actual:-<empty>} (expected $wanted)"
  fi
}

printf 'Claude0 Linux service doctor\n\n'

case "$(uname -s)" in
  Linux) pass "host is Linux ($(uname -m))" ;;
  *) fail "host is $(uname -s), not Linux" ;;
esac

for cmd in tmux mosh-server zsh git gh jq curl bun claude0 claude bwrap socat lsof; do
  if command -v "$cmd" >/dev/null 2>&1; then
    pass "$cmd: $(command -v "$cmd")"
  else
    fail "$cmd is not installed or not on the login PATH"
  fi
done

if [ -d /run/systemd/system ]; then
  for unit in tmux.service claude0-bridge.service claude0-monitor.service claude0-daemon.service snapshot-check.timer; do
    active=$(systemctl --user is-active "$unit" 2>/dev/null || true)
    enabled=$(systemctl --user is-enabled "$unit" 2>/dev/null || true)
    expect_eq "$unit active" "$active" active
    expect_eq "$unit enabled" "$enabled" enabled
  done
  linger=$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)
  expect_eq "login linger" "$linger" yes
else
  fail "systemd is not running"
fi

if tmux has-session -t main 2>/dev/null; then
  pass "tmux session main is alive"

  tmux_path=$(tmux show-environment -g PATH 2>/dev/null | sed -n 's/^PATH=//p')
  if [[ ":$tmux_path:" == *":$HOME/.bun/bin:"* && ":$tmux_path:" == *":$HOME/.local/bin:"* ]]; then
    pass "tmux server PATH includes bun and local bins"
  else
    fail "tmux server PATH is missing $HOME/.bun/bin or $HOME/.local/bin: $tmux_path"
  fi
  if PATH="$tmux_path" command -v claude0 >/dev/null 2>&1; then
    pass "tmux run-shell can resolve claude0"
  else
    fail "claude0 is not resolvable through the tmux server PATH"
  fi

  claude0_status=$(tmux show-options -gqv @claude0_status 2>/dev/null || true)
  if [[ "$claude0_status" == *"claude0 status"* ]]; then pass "Claude0 status segment is active"; else fail "@claude0_status is missing or inactive"; fi
  # The popup key is configurable (config.json tmux.keys.popup; default "prefix a").
  popup_spec=$(jq -r '.tmux.keys.popup // "prefix a"' "$HOME/.config/claude0/config.json" 2>/dev/null || echo "prefix a")
  if [[ "$popup_spec" == prefix\ * ]]; then popup_table=prefix; popup_key=${popup_spec#prefix }; else popup_table=root; popup_key=$popup_spec; fi
  claude0_popup=$(tmux list-keys -T "$popup_table" "$popup_key" 2>/dev/null || true)
  if [[ "$claude0_popup" == *"display-popup"* && "$claude0_popup" == *"claude0"* ]]; then pass "Claude0 popup binding is active"; else fail "$popup_spec is not bound to the Claude0 popup"; fi

else
  fail "tmux session main is not alive"
fi

# The repo template carries {{BIND_*}} tokens that `claude0 setup` renders from
# config.json's tmux.keys — normalize the installed file's bind lines back to
# tokens before comparing, so a custom binding doesn't read as a stale fragment.
normalize_tmux_fragment() {
  sed -E \
    -e "s/^bind-key (-n )?[^ ]+ (run-shell 'tmux set-environment CLAUDE0_FOCUS_PANE)/{{BIND_POPUP}} \\2/" \
    -e "s/^bind-key (-n )?[^ ]+ (run-shell 'claude0 next')/{{BIND_NEXT}} \\2/" \
    "$1" 2>/dev/null
}
if [ -f "$HOME/.config/claude0/tmux.conf" ] \
  && ! grep -qE '^\{\{BIND_(POPUP|NEXT)\}\}' "$HOME/.config/claude0/tmux.conf" \
  && cmp -s <(normalize_tmux_fragment "$here/../config/tmux.conf") <(normalize_tmux_fragment "$HOME/.config/claude0/tmux.conf"); then
  pass "current Claude0-owned tmux fragment is installed"
else
  fail "Claude0-owned tmux fragment is missing or stale: $HOME/.config/claude0/tmux.conf"
fi
# setup accepts the import living in a dotfiles layer the entry point includes
# (e.g. ~/.config/tmux/*.conf) — accept the same here, dereferencing stow symlinks.
if grep -Fxq "$CLAUDE0_TMUX_SOURCE" "$HOME/.tmux.conf" 2>/dev/null \
  || grep -RFq ".config/claude0/tmux.conf" "$HOME/.config/tmux/" 2>/dev/null; then
  pass "$HOME/.tmux.conf imports the Claude0 fragment"
else
  fail "$HOME/.tmux.conf does not import the Claude0 fragment"
fi
if cmp -s "$here/../config/shell.zsh" "$HOME/.config/claude0/shell.zsh" 2>/dev/null; then
  pass "current Claude0-owned zsh fragment is installed"
else
  fail "Claude0-owned zsh fragment is missing or stale: $HOME/.config/claude0/shell.zsh"
fi
if grep -Fxq "$CLAUDE0_ZSH_SOURCE" "$HOME/.zshrc" 2>/dev/null \
  || grep -RFq ".config/claude0/shell.zsh" "$HOME/.config/zsh/" 2>/dev/null; then
  pass "$HOME/.zshrc imports the Claude0 fragment"
else
  fail "$HOME/.zshrc does not import the Claude0 fragment"
fi

claude0_config="$HOME/.config/claude0/config.json"
if jq -e '.schemaVersion == 1 and (.repositories.roots | type == "array") and (.repositories.roots | length > 0)' "$claude0_config" >/dev/null 2>&1; then
  pass "single-file Claude0 config is valid: $claude0_config"
else
  fail "missing or invalid schemaVersion 1 Claude0 config: $claude0_config"
fi

if gh auth status >/dev/null 2>&1; then
  pass "GitHub CLI is authenticated"
else
  fail "GitHub CLI is not authenticated"
fi
if claude auth status 2>/dev/null | jq -e '.loggedIn == true' >/dev/null 2>&1; then
  pass "Claude Code is authenticated"
else
  fail "Claude Code is not authenticated"
fi

bridge_env="$HOME/.config/claude0/bridge.env"
if [ -r "$bridge_env" ]; then
  # Generated EnvironmentFile at a fixed local path.
  set -a
  # shellcheck disable=SC1090
  . "$bridge_env"
  set +a
  BRIDGE_PORT="${CLAUDE0_BRIDGE_PORT:-8473}"
  if [ -n "${CLAUDE0_BRIDGE_TOKEN:-}" ]; then
    payload=$(jq -cn --arg token "$CLAUDE0_BRIDGE_TOKEN" '{token:$token}')
    code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
      -H 'content-type: application/json' --data-binary "$payload" \
      "http://127.0.0.1:${BRIDGE_PORT}/auth" 2>/dev/null || true)
    expect_eq "bridge authentication" "$code" 200
    unset CLAUDE0_BRIDGE_TOKEN payload
  else
    fail "bridge EnvironmentFile has no CLAUDE0_BRIDGE_TOKEN"
  fi
else
  fail "bridge EnvironmentFile is missing or unreadable: $bridge_env"
fi

if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  pass "Tailscale is connected"
  if tailscale serve status 2>/dev/null | grep -q "127.0.0.1:${BRIDGE_PORT}"; then
    pass "Tailscale Serve proxies the portkey bridge"
  else
    fail "Tailscale Serve is not proxying 127.0.0.1:${BRIDGE_PORT}"
  fi
else
  fail "Tailscale is not connected"
fi

# Some minimal images ship without the sysctl binary — /proc carries the same values.
watchers=$(sysctl -n fs.inotify.max_user_watches 2>/dev/null || cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || true)
instances=$(sysctl -n fs.inotify.max_user_instances 2>/dev/null || cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null || true)
if [ "${watchers:-0}" -ge 1048576 ] 2>/dev/null; then pass "inotify watches = $watchers"; else fail "inotify watches = ${watchers:-unknown}"; fi
if [ "${instances:-0}" -ge 16384 ] 2>/dev/null; then pass "inotify instances = $instances"; else fail "inotify instances = ${instances:-unknown}"; fi
# swapon lives in /usr/sbin (often off the user PATH) — /proc/swaps is always readable.
if grep -q '^/swapfile ' /proc/swaps 2>/dev/null; then pass "swapfile is active"; else fail "swapfile is not active"; fi

printf '\nDoctor finished: %d failure(s), %d warning(s).\n' "$failures" "$warnings"
[ "$failures" -eq 0 ]
