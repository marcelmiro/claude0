#!/usr/bin/env bash
# Integration smoke test for the portkey model/effort switcher.
#
# Drives a REAL isolated `claude` session and asserts the Claude-Code TUI mechanics the
# feature depends on (option A — arg-form slash commands, global scope, ultracode session-only):
#   1. `/model <name>`   → applies + prints "Set model to …" confirmation, statusline flips.
#   2. `/effort <level>` → applies + prints "Set effort level to …" confirmation.
#   3. `/effort ultracode` → applies SESSION-ONLY (confirmation says "this session only").
#   4. The statusline renders the effort level (the read-path scraped by readPaneStatusline).
#
# NOT part of `bun test` — it launches real sessions (~40s, consumes quota) and mutates the
# GLOBAL default model/effort (restored on exit). Run manually after a Claude Code upgrade to
# confirm the mechanics still hold: `bash test/smoke/model-effort.sh`. Exit 0 = all held.
#
# Requires: tmux, a working `claude` on PATH, and the effort-in-statusline change to
# ~/.claude/statusline.sh (see CLAUDE.md "Portkey model/effort" — the effort assertion needs it).
set -u

BASE="$(cd "$(dirname "$0")" && pwd)/.work"
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
cap() { tmux capture-pane -t "$1" -p; }
line(){ echo "── $* ──"; }
model_of() { cap "$1" | grep -oE "• (Opus|Sonnet|Haiku|Fable)[^•]*" | head -1 | sed -E 's/^• //; s/ *$//'; }
effort_seg() { cap "$1" | grep -oE "• (low|medium|high|xhigh|max|ultracode) *$" | head -1 | sed -E 's/^• //; s/ *$//'; }

SESSIONS=(); ORIG_MODEL=""; ORIG_EFFORT=""
launch() { # name
  local dir="$BASE/$1"; mkdir -p "$dir"; (cd "$dir" && git init -q 2>/dev/null)
  tmux kill-session -t "$1" 2>/dev/null
  tmux new-session -d -s "$1" -x 130 -y 42 -c "$dir"
  tmux send-keys -t "$1" "claude" Enter
  SESSIONS+=("$1"); sleep 9
}
restore() {
  # put the global default back to what a fresh session showed at start
  [ -n "$ORIG_MODEL" ] && { tmux send-keys -t "${SESSIONS[0]}" "/model ${ORIG_MODEL}" Enter; sleep 1.5; }
  [ -n "$ORIG_EFFORT" ] && { tmux send-keys -t "${SESSIONS[0]}" "/effort ${ORIG_EFFORT}" Enter; sleep 1.5; }
}
cleanup() {
  restore
  for s in "${SESSIONS[@]:-}"; do tmux send-keys -t "$s" C-c 2>/dev/null; done; sleep 0.5
  for s in "${SESSIONS[@]:-}"; do tmux kill-session -t "$s" 2>/dev/null; done
  rm -rf "$BASE"
}
trap cleanup EXIT

echo "=== SMOKE: portkey model/effort switcher mechanics (option A) ==="; echo
launch A
# snapshot original global default so we can restore it (map display → arg key). Opus renders
# 1M vs non-1M; "1M context" must restore via opus[1m], NOT bare opus (which downgrades to 200k).
case "$(model_of A)" in
  *Opus*1M*) ORIG_MODEL="opus[1m]";;
  *Opus*)    ORIG_MODEL="opus";;
  *Sonnet*)  ORIG_MODEL="sonnet";;
  *Haiku*)   ORIG_MODEL="haiku";;
  *Fable*)   ORIG_MODEL="fable";;
esac
ORIG_EFFORT="$(effort_seg A)"
echo "     baseline: model=$(model_of A) effort=${ORIG_EFFORT:-<none>}"

line "T0  '/model opus[1m]' → the 1M variant (bare 'opus' would be non-1M)"
tmux send-keys -t A "/model opus[1m]" Enter; sleep 1.6
cap A | grep -qiE "Set model to Opus 5.5 \(1M context\)" && [[ "$(model_of A)" == *"1M"* ]] \
  && ok "opus[1m] → Opus 5.5 (1M context)" || bad "opus[1m] did not select the 1M variant"

line "T1  '/model sonnet' arg form → confirmation + statusline flips to Sonnet"
tmux send-keys -t A "/model sonnet" Enter; sleep 1.6
cap A | grep -qiE "Set model to Sonnet" && ok "confirmation line printed" || bad "no 'Set model to Sonnet' confirmation"
[[ "$(model_of A)" == *Sonnet* ]] && ok "statusline now Sonnet" || bad "statusline did not flip to Sonnet"

line "T2  '/effort high' arg form → confirmation line"
tmux send-keys -t A "/effort high" Enter; sleep 1.6
cap A | grep -qiE "Set effort level to high" && ok "effort confirmation printed" || bad "no 'Set effort level to high' confirmation"

line "T3  '/effort ultracode' → applies SESSION-ONLY (scope stated in confirmation)"
tmux send-keys -t A "/effort ultracode" Enter; sleep 1.6
cap A | grep -qiE "Set effort level to ultracode \(this session only\)" \
  && ok "ultracode confirmed session-only" || bad "ultracode confirmation missing/!session-only"

line "T4  statusline renders the effort level (read-path for current effort)"
# after ultracode the segment may hide; set a plain level and read it back
tmux send-keys -t A "/effort medium" Enter; sleep 1.6
[ "$(effort_seg A)" = "medium" ] \
  && ok "statusline effort segment reads 'medium'" \
  || bad "statusline has no effort segment — is the ~/.claude/statusline.sh change applied?"

echo; echo "=== RESULT: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
