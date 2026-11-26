#!/usr/bin/env bash
# Converge a machine's Pi setup to the trackq baseline: the right extensions
# installed, the noisy ones gone, and a footer with nothing pinned into it.
#
#   desired   pi-web-access, pi-mcp-adapter, this repo's tool-tree + thinking-fold
#   removed   context-mode (and its orphan daemons + index), pi-thinking-steps
#             (and the legacy thinking-steps.* entries in old sessions),
#             pi-context-tree
#   configured mcp-adapter settings.mcpFooterStatus = "off"
#
# Usage:
#   scripts/setup-pi.sh                    # report only, changes nothing
#   scripts/setup-pi.sh --apply            # install/remove/configure
#   scripts/setup-pi.sh --apply --purge-context-mode-data
#   scripts/setup-pi.sh --agent-dir DIR    # non-default PI_CONFIG_DIR
#
# On another machine, straight from this repo:
#   ssh cowfish 'bash -s -- --apply' < scripts/setup-pi.sh
#
# Restart Pi afterwards: extensions, their tools and the MCP footer setting are
# read at startup.
set -euo pipefail

APPLY=0
PURGE=0
EXPLICIT_AGENT_DIR=0
AGENT_DIR="${PI_CONFIG_DIR:-$HOME/.pi/agent}"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --purge-context-mode-data) PURGE=1; shift ;;
    --agent-dir) AGENT_DIR="${2:?--agent-dir needs a path}"; EXPLICIT_AGENT_DIR=1; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//' | sed '/^set -euo/q' | sed '$d'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Keep `pi` itself pointed at the same tree when --agent-dir overrides it.
if [ "$EXPLICIT_AGENT_DIR" -eq 1 ]; then export PI_CONFIG_DIR="$AGENT_DIR"; fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PI_ROOT="$(cd "$AGENT_DIR/.." && pwd)"
SETTINGS="$AGENT_DIR/settings.json"
ADAPTER="$AGENT_DIR/mcp-adapter.json"
SESSIONS="$AGENT_DIR/sessions"

# Desired and unwanted packages. Local packages come from this clone.
WANTED_NAMES=("pi-web-access" "pi-mcp-adapter" "tool-tree" "thinking-fold")
WANTED_SOURCES=("npm:pi-web-access" "npm:pi-mcp-adapter" "$REPO_ROOT/tool-tree" "$REPO_ROOT/thinking-fold")
UNWANTED_RE='context-mode|thinking-steps|pi-context-tree'

# --- tool discovery --------------------------------------------------------
# Non-interactive shells (ssh, cron) often have neither pi nor node on PATH.
find_bin() { # find_bin <name> <fallback...>
  local name="$1"; shift
  command -v "$name" 2>/dev/null && return 0
  local candidate
  for candidate in "$@"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}
NODE="$(find_bin node "${PI_NODE:-}" "${XDG_DATA_HOME:-$HOME/.local/share}/pi-node/current/bin/node" /opt/homebrew/bin/node /usr/local/bin/node || true)"
[ -n "$NODE" ] && PATH="$(dirname "$NODE"):$PATH"
PI="$(find_bin pi "$AGENT_DIR/bin/pi" "$HOME/.local/bin/pi" /opt/homebrew/bin/pi /usr/local/bin/pi || true)"

PI_VERSION="$(cat "$AGENT_DIR/install/current-version" 2>/dev/null || { [ -n "$PI" ] && "$PI" --version 2>/dev/null; } || echo unknown)"

version_lt() { # $1 older than $2 ?
  awk -v a="$1" -v b="$2" 'BEGIN {
    na = split(a, A, /[.+-]/); nb = split(b, B, /[.+-]/);
    for (i = 1; i <= (na > nb ? na : nb); i++) {
      x = (i <= na ? A[i] : 0) + 0; y = (i <= nb ? B[i] : 0) + 0;
      if (x < y) exit 0; if (x > y) exit 1;
    }
    exit 1
  }'
}

say() { printf '%s\n' "$*"; }
act() { printf '  → %s\n' "$*"; }
have() { printf '%s\n' "$1" | grep -qx "$2"; }

say "Pi setup baseline"
say "  agent dir: $AGENT_DIR"
say "  repo:      $REPO_ROOT"
say "  pi:        $PI_VERSION${PI:+ ($PI)}"
say "  node:      ${NODE:-not found (JSON edits and session cleanup disabled)}"
say "  mode:      $([ "$APPLY" -eq 1 ] && echo apply || echo 'report only (add --apply)')"

if [ -n "$PI_VERSION" ] && version_lt "$PI_VERSION" "1.6.1"; then
  say "  ! pi $PI_VERSION is older than 1.6.1 — the footer layout and some TUI internals differ; run 'pi update'"
fi

# --- packages --------------------------------------------------------------
LIST="$([ -n "$PI" ] && "$PI" list 2>/dev/null || printf '')"

say ""
say "packages"
MISSING=()
for i in "${!WANTED_NAMES[@]}"; do
  name="${WANTED_NAMES[$i]}"
  source="${WANTED_SOURCES[$i]}"
  if printf '%s\n' "$LIST" | grep -q -- "$name"; then
    say "  ✓ $name"
  else
    say "  ✗ $name — missing"
    MISSING+=("$source")
  fi
done

PRESENT_UNWANTED=()
while IFS= read -r line; do
  entry="$(printf '%s' "$line" | sed 's/^[[:space:]]*//')"
  [ -n "$entry" ] || continue
  printf '%s' "$entry" | grep -Eq "$UNWANTED_RE" || continue
  say "  ✗ $entry — should be removed"
  PRESENT_UNWANTED+=("$entry")
done <<<"$(printf '%s\n' "$LIST" | grep -E '^[[:space:]]*(npm:|\.|/|[A-Za-z0-9_-]+:)' | grep -Ev ':[[:space:]]*$' || true)"

# --- mcp-adapter footer ----------------------------------------------------
read_mcp_state() {
  if [ -z "$NODE" ]; then echo missing; return 0; fi
  "$NODE" - "$ADAPTER" <<'NODE' 2>/dev/null || echo unreadable
const fs = require("node:fs");
const path = process.argv[2];
if (!fs.existsSync(path)) { console.log("missing"); process.exit(0); }
try {
  const value = JSON.parse(fs.readFileSync(path, "utf8"))?.settings?.mcpFooterStatus;
  console.log(value === undefined ? "default (full)" : String(value));
} catch { console.log("unreadable"); }
NODE
}
MCP_STATE="$(read_mcp_state)"
say ""
say "footer"
case "$MCP_STATE" in
  off) say "  ✓ MCP segment off (mcp-adapter.json)" ;;
  missing) say "  ✗ MCP segment on — no mcp-adapter.json (adapter default is full)" ;;
  unreadable) say "  ✗ mcp-adapter.json is not valid JSON — fix it by hand" ;;
  *) say "  ✗ MCP segment on — settings.mcpFooterStatus = $MCP_STATE" ;;
esac
want_tool_tree_version() { # prints the local tool-tree version
  [ -n "$NODE" ] && "$NODE" -e 'process.stdout.write(require(process.argv[1]).version||"")' "$REPO_ROOT/tool-tree/package.json" 2>/dev/null
}
if [ -n "$(printf '%s\n' "$LIST" | grep -c 'tool-tree' || true)" ]; then
  TT_LOCAL="$(want_tool_tree_version)"
  say "  · tool-tree in use: $([ -n "$TT_LOCAL" ] && echo "this clone ($TT_LOCAL)" || echo unknown)"
fi

# --- context-mode leftovers ------------------------------------------------
DAEMON_PIDS="$(pgrep -f "node .*context-mode/server\.bundle\.mjs" 2>/dev/null || true)"
DATA_DIRS=("$HOME/.context-mode" "$AGENT_DIR/context-mode" "$PI_ROOT/context-mode" "$PI_ROOT/context-mode.ctx-v1-old")
say ""
say "context-mode leftovers"
if [ -z "$DAEMON_PIDS" ]; then
  say "  ✓ no daemons"
else
  say "  ✗ daemons: $(printf '%s' "$DAEMON_PIDS" | tr '\n' ' ')"
fi
for dir in "${DATA_DIRS[@]}"; do
  [ -d "$dir" ] && say "  · $(du -sh "$dir" 2>/dev/null | cut -f1) $dir"
done
say "  (data kept unless --purge-context-mode-data)"

# --- legacy session entries ------------------------------------------------
count_legacy_entries() {
  "$NODE" - "$SESSIONS" <<'NODE' 2>/dev/null || echo 0
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
let count = 0;
const walk = (dir) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(full, "utf8").split("\n")) {
      if (!line.includes("thinking-steps.")) continue;
      try {
        const e = JSON.parse(line);
        if (e?.type === "custom" && String(e.customType ?? "").startsWith("thinking-steps.")) count += 1;
      } catch {}
    }
  }
};
walk(root);
process.stdout.write(String(count));
NODE
}
LEGACY_COUNT=0
if [ -n "$NODE" ] && [ -d "$SESSIONS" ]; then
  LEGACY_COUNT="$(count_legacy_entries)"
  case "$LEGACY_COUNT" in ''|*[!0-9]*) LEGACY_COUNT=0 ;; esac
fi
say ""
say "legacy session entries"
say "  $([ "${LEGACY_COUNT:-0}" -gt 0 ] && echo "✗ $LEGACY_COUNT thinking-steps.* entries in session files" || echo '✓ none')"

# --- apply -----------------------------------------------------------------
if [ "$APPLY" -eq 1 ]; then
  say ""
  say "applying"
  [ -n "$PI" ] || { say "  ✗ pi not found — put it on PATH or pass --agent-dir"; exit 1; }

  for entry in "${PRESENT_UNWANTED[@]:-}"; do
    [ -n "$entry" ] || continue
    if "$PI" remove "$entry" </dev/null >/dev/null 2>&1; then
      act "removed $entry"
    else
      say "  ✗ could not remove $entry — run: pi remove $entry"
    fi
  done

  for source in "${MISSING[@]:-}"; do
    [ -n "$source" ] || continue
    if "$PI" install "$source" </dev/null >/dev/null 2>&1; then
      act "installed $source"
    else
      say "  ✗ could not install $source — run: pi install $source"
    fi
  done

  if [ "$MCP_STATE" != "off" ] && [ -n "$NODE" ]; then
    "$NODE" - "$ADAPTER" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
let data = {};
if (fs.existsSync(path)) {
  const text = fs.readFileSync(path, "utf8");
  if (text.trim()) {
    try { data = JSON.parse(text); } catch (error) {
      console.error(`  ✗ ${path} is not valid JSON (${error.message}); left untouched`);
      process.exit(0);
    }
  }
}
data.settings = { ...(data.settings ?? {}), mcpFooterStatus: "off" };
fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
console.log("  → mcp-adapter.json: settings.mcpFooterStatus = off");
NODE
  fi

  if [ -n "$DAEMON_PIDS" ]; then
    for pid in $DAEMON_PIDS; do
      kill "$pid" 2>/dev/null && act "stopped context-mode daemon $pid" || say "  ✗ could not stop $pid"
    done
  fi

  if [ "$PURGE" -eq 1 ]; then
    for dir in "${DATA_DIRS[@]}"; do
      [ -d "$dir" ] || continue
      rm -rf "$dir" && act "deleted $dir" || say "  ✗ could not delete $dir"
    done
  fi

  if [ "${LEGACY_COUNT:-0}" -gt 0 ] && [ -n "$NODE" ] && [ -d "$SESSIONS" ]; then
    "$NODE" - "$SESSIONS" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
let files = 0, removed = 0, saved = 0;
const isLegacy = (line) => {
  if (!line.includes("thinking-steps.")) return false;
  try {
    const e = JSON.parse(line);
    return e?.type === "custom" && String(e.customType ?? "").startsWith("thinking-steps.");
  } catch { return false; }
};
const walk = (dir) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const original = fs.readFileSync(full, "utf8");
    const lines = original.split("\n");
    const kept = lines.filter((line) => line === "" || !isLegacy(line));
    const gone = lines.length - kept.length;
    if (gone === 0) continue;
    fs.copyFileSync(full, `${full}.bak`);
    fs.writeFileSync(full, kept.join("\n"), "utf8");
    files += 1; removed += gone;
    saved += Buffer.byteLength(original) - Buffer.byteLength(kept.join("\n"));
  }
};
walk(root);
console.log(`  → removed ${removed} legacy entries from ${files} session file(s) (${(saved / 1024).toFixed(0)} KiB), backups kept as *.jsonl.bak`);
NODE
  fi

  say ""
  say "restart Pi: extensions, their tools and the MCP footer setting load at startup."
fi
