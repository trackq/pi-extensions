#!/usr/bin/env bash
# Remove the context-mode extension from Pi on this machine, and clean up what
# it leaves behind.
#
# What "removed" has to cover, learned the hard way:
#   1. the package entry in ~/.pi/agent/settings.json + the npm module
#      (`pi remove npm:context-mode` does both),
#   2. its long-lived `server.bundle.mjs` daemons — they survive the uninstall
#      because nothing signals them, and they point at a path that is gone,
#   3. optionally its data: ~/.context-mode (per-project index DBs),
#      ~/.pi/context-mode and ~/.pi/context-mode.ctx-v1-old.
#
# Usage:
#   scripts/remove-context-mode.sh               # report only
#   scripts/remove-context-mode.sh --apply       # uninstall + stop daemons
#   scripts/remove-context-mode.sh --apply --purge-data   # also delete the data
#   scripts/remove-context-mode.sh --agent-dir DIR
#
# On another machine, from this repo:
#   ssh cowfish 'bash -s -- --apply' < scripts/remove-context-mode.sh
#
# Nothing else on the box is touched: other extensions, MCP servers and the
# non-Pi integrations (Claude Code, Codex, …) keep their own config.
set -euo pipefail

APPLY=0
PURGE=0
AGENT_DIR="${PI_CONFIG_DIR:-$HOME/.pi/agent}"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --purge-data) PURGE=1; APPLY=1; shift ;;
    --agent-dir) AGENT_DIR="${2:?--agent-dir needs a path}"; shift 2 ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//' | sed '/^set -euo/q' | sed '$d'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

PI_ROOT="$(cd "$AGENT_DIR/.." && pwd)"
MODULE_DIR="$AGENT_DIR/npm/node_modules/context-mode"
DATA_DIRS=("$HOME/.context-mode" "$AGENT_DIR/context-mode" "$PI_ROOT/context-mode" "$PI_ROOT/context-mode.ctx-v1-old")

say() { printf '%s\n' "$*"; }
act() { printf '  → %s\n' "$*"; }

say "context-mode removal"
say "  agent dir: $AGENT_DIR"
say "  mode:      $( [ "$APPLY" -eq 1 ] && echo apply || echo 'report only (add --apply)' )"

# --- package ---------------------------------------------------------------
LISTED=0
if command -v pi >/dev/null 2>&1 && pi list 2>/dev/null | grep -q "npm:context-mode"; then
  LISTED=1
elif [ -f "$AGENT_DIR/settings.json" ] && grep -q '"npm:context-mode"' "$AGENT_DIR/settings.json" 2>/dev/null; then
  LISTED=1
fi
if [ "$LISTED" -eq 1 ]; then
  say ""
  say "package"
  say "  ✗ still installed (npm:context-mode)"
else
  say ""
  say "package"
  say "  ✓ not installed"
fi
if [ -d "$MODULE_DIR" ]; then
  say "  · module still on disk: $MODULE_DIR"
fi

# --- daemons ---------------------------------------------------------------
DAEMON_PIDS="$(pgrep -f "node .*context-mode/server\.bundle\.mjs" 2>/dev/null || true)"
say ""
say "daemons"
if [ -z "$DAEMON_PIDS" ]; then
  say "  ✓ none running"
else
  say "  ✗ running:"
  for pid in $DAEMON_PIDS; do
    say "    · $pid $(ps -o lstart= -p "$pid" 2>/dev/null | tr -s ' ') $(ps -o command= -p "$pid" 2>/dev/null)"
  done
fi

# --- data ------------------------------------------------------------------
say ""
say "data"
for dir in "${DATA_DIRS[@]}"; do
  if [ -d "$dir" ]; then
    say "  · $(du -sh "$dir" 2>/dev/null | cut -f1) $dir"
  fi
done
[ "$PURGE" -eq 1 ] || say "  (kept — pass --purge-data to delete)"

# --- apply -----------------------------------------------------------------
if [ "$APPLY" -eq 1 ]; then
  say ""
  say "applying"

  if [ "$LISTED" -eq 1 ]; then
    if command -v pi >/dev/null 2>&1; then
      if pi remove npm:context-mode </dev/null >/dev/null 2>&1; then
        say "  ✓ uninstalled npm:context-mode (settings + npm module)"
      else
        say "  ✗ pi remove failed — run it by hand: pi remove npm:context-mode"
      fi
    else
      say "  ✗ pi not on PATH and the package is still listed — remove it by hand"
    fi
  fi

  if [ -n "$DAEMON_PIDS" ]; then
    for pid in $DAEMON_PIDS; do
      if kill "$pid" 2>/dev/null; then
        say "  ✓ stopped daemon $pid"
      else
        say "  ✗ could not stop $pid"
      fi
    done
    sleep 1
    LEFT="$(pgrep -f "node .*context-mode/server\.bundle\.mjs" 2>/dev/null || true)"
    [ -n "$LEFT" ] && say "  ! still running: $LEFT (kill -9 if it holds a port)"
  fi

  if [ "$PURGE" -eq 1 ]; then
    for dir in "${DATA_DIRS[@]}"; do
      if [ -d "$dir" ]; then
        if rm -rf "$dir"; then say "  ✓ deleted $dir"; else say "  ✗ could not delete $dir"; fi
      fi
    done
  fi

  say ""
  say "restart Pi: a running process keeps the extension's tools loaded"
  say "until it exits ('ctx_*' tools disappear after the restart)."
fi
