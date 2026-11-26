#!/usr/bin/env bash
# Make a machine's Pi footer match the baseline used on this workstation:
#
#   ~/trackq/pi-extensions (main)
#   ↑397k ↓152k R28M CH99.7% $0.647 28.0%/1.0M (auto)      (refuseless) model • high
#
# i.e. the pwd line plus Pi's own session-stats line, and nothing pinned by
# extensions. Three things pollute that line, each from a different place:
#
#   "tool-tree on · turn · preview 6 · 12 calls"   pi-tool-tree < 0.1.1 called
#                                                  ctx.ui.setStatus("tool-tree")
#   "🔌 MCP: 2 servers enabled (1 disabled)"        pi-mcp-adapter footer status
#                                                  (settings.mcpFooterStatus)
#   "in 240 tok/s · out 213 tok/s"                 pi-thinking-steps: a live
#                                                  footer status + one persisted
#                                                  custom entry per assistant message
#
# Usage:
#   scripts/footer-baseline.sh                 # report only (no writes)
#   scripts/footer-baseline.sh --apply         # fix what can be fixed here
#   scripts/footer-baseline.sh --agent-dir DIR  # non-default PI_CONFIG_DIR
#
# Remote machine (e.g. the Mac, on the tailnet), straight from this repo:
#   ssh cowfish 'bash -s -- --apply' < scripts/footer-baseline.sh
set -euo pipefail

APPLY=0
AGENT_DIR="${PI_CONFIG_DIR:-$HOME/.pi/agent}"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --agent-dir) AGENT_DIR="${2:?--agent-dir needs a path}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//' | sed '/^set -euo/q' | sed '$d'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SETTINGS="$AGENT_DIR/settings.json"
ADAPTER="$AGENT_DIR/mcp-adapter.json"
SESSIONS="$AGENT_DIR/sessions"

# Non-interactive shells (ssh, launchd) often miss node. Pi's own installer keeps
# one under ~/.local/share/pi-node, so fall back to that before giving up.
find_node() {
  if [ -n "${PI_NODE:-}" ] && [ -x "${PI_NODE}" ]; then echo "$PI_NODE"; return 0; fi
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidate="${XDG_DATA_HOME:-$HOME/.local/share}/pi-node/current/bin/node"
  if [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  return 1
}
NODE="$(find_node || true)"
[ -n "$NODE" ] && PATH="$(dirname "$NODE"):$PATH"

# Portable version compare (BSD sort has no -V): prints the older of two x.y.z.
version_lt() { # $1 < $2 ?
  awk -v a="$1" -v b="$2" 'BEGIN {
    na = split(a, A, /[.+-]/); nb = split(b, B, /[.+-]/);
    for (i = 1; i <= (na > nb ? na : nb); i++) {
      x = (i <= na ? A[i] : 0) + 0; y = (i <= nb ? B[i] : 0) + 0;
      if (x < y) { exit 0 } if (x > y) { exit 1 }
    }
    exit 1
  }'
}

say() { printf '%s\n' "$*"; }
act() { printf '  → %s\n' "$*"; }

say "Pi footer baseline"
say "  agent dir: $AGENT_DIR"
say "  mode:      $([ "$APPLY" -eq 1 ] && echo apply || echo 'report only (add --apply)')"

# --- Pi version ------------------------------------------------------------
PI_VERSION="$(cat "$AGENT_DIR/install/current-version" 2>/dev/null || pi --version 2>/dev/null || echo unknown)"
say "  pi:        $PI_VERSION"
say "  node:      ${NODE:-not found (JSON edits disabled)}"

# --- settings: packages ----------------------------------------------------
if [ -f "$SETTINGS" ] && [ -n "$NODE" ]; then
  say ""
  say "settings.json"
  "$NODE" - "$SETTINGS" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const data = JSON.parse(fs.readFileSync(path, "utf8"));
const packages = Array.isArray(data.packages) ? data.packages : [];
const legacy = packages.filter((p) => String(p).includes("pi-thinking-steps"));
const legacyEntries = packages.filter((p) => String(p).includes("pi-context-tree"));
const toolTree = packages.filter((p) => String(p).includes("tool-tree"));
console.log(`  packages:  ${packages.length}`);
for (const p of packages) console.log(`    · ${p}`);
if (legacy.length > 0) {
  console.log(`  ✗ pi-thinking-steps is installed — its live rate line is the "in … tok/s · out … tok/s" segment.`);
} else {
  console.log("  ✓ pi-thinking-steps not installed (no tok/s segment)");
}
if (legacyEntries.length > 0) console.log(`  ! obsolete pi-context-tree entry: ${legacyEntries.join(", ")}`);
for (const p of toolTree) console.log(`  · tool-tree source: ${p}`);
NODE
fi

# --- tool-tree version -----------------------------------------------------
say ""
TT_VERSION=""
for candidate in \
  "$AGENT_DIR/npm/node_modules/pi-tool-tree/package.json" \
  "$REPO_ROOT/tool-tree/package.json"; do
  if [ -f "$candidate" ] && [ -n "$NODE" ]; then
    TT_VERSION="$("$NODE" -e 'process.stdout.write(require(process.argv[1]).version||"")' "$candidate")"
    [ -n "$TT_VERSION" ] && break
  fi
done
if [ -z "$TT_VERSION" ]; then
  say "tool-tree: not found (nothing pins a footer status)"
elif version_lt "$TT_VERSION" "0.1.1"; then
  say "tool-tree: $TT_VERSION ✗ (0.1.1 removed the pinned footer status; update it:"
  say "            pi remove <source> && pi install git:github.com/trackq/pi-extensions)"
else
  say "tool-tree: $TT_VERSION ✓ (does not pin a footer status)"
fi

# --- mcp-adapter footer ----------------------------------------------------
say ""
say "mcp-adapter.json"
MCP_STATE="$("$NODE" - "$ADAPTER" <<'NODE' 2>/dev/null || echo missing
const fs = require("node:fs");
const path = process.argv[2];
if (!fs.existsSync(path)) { console.log("missing"); process.exit(0); }
let data;
try { data = JSON.parse(fs.readFileSync(path, "utf8")); } catch { console.log("unreadable"); process.exit(0); }
const value = data?.settings?.mcpFooterStatus;
console.log(value === undefined ? `default(full)` : String(value));
NODE
)"
case "$MCP_STATE" in
  off) say "  ✓ settings.mcpFooterStatus = off (no MCP segment)" ;;
  missing) say "  ✗ no mcp-adapter.json — the adapter defaults to mcpFooterStatus: full" ;;
  unreadable) say "  ✗ mcp-adapter.json is not valid JSON — fix it by hand" ;;
  *) say "  ✗ settings.mcpFooterStatus = $MCP_STATE — expected off" ;;
esac

# --- legacy session entries ------------------------------------------------
STRIP="$REPO_ROOT/thinking-fold/scripts/strip-legacy-entries.mjs"
if [ -f "$STRIP" ] && [ -d "$SESSIONS" ] && [ -n "$NODE" ]; then
  say ""
  say "legacy thinking-steps entries"
  "$NODE" "$STRIP" --dir "$SESSIONS" 2>/dev/null | tail -2 | sed 's/^/  /'
fi

# --- apply -----------------------------------------------------------------
if [ "$APPLY" -eq 1 ]; then
  say ""
  say "applying"
  [ -n "$NODE" ] || { say "  ✗ node is required for --apply (set PI_NODE=/path/to/node)"; exit 1; }

  # 1. drop pi-thinking-steps / pi-context-tree from the package list
  if [ -f "$SETTINGS" ]; then
    "$NODE" - "$SETTINGS" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const data = JSON.parse(fs.readFileSync(path, "utf8"));
const before = Array.isArray(data.packages) ? data.packages : [];
const after = before.filter((p) => !/pi-thinking-steps|pi-context-tree/.test(String(p)));
if (after.length !== before.length) {
  data.packages = after;
  fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  const removed = before.filter((p) => !after.includes(p));
  console.log(`  ✓ settings.json: removed ${removed.join(", ")}`);
} else {
  console.log("  ✓ settings.json: nothing to remove");
}
NODE
  fi

  # 2. MCP footer off, preserving the rest of the adapter config
  "$NODE" - "$ADAPTER" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
let data = {};
if (fs.existsSync(path)) {
  const text = fs.readFileSync(path, "utf8");
  try { data = text.trim() ? JSON.parse(text) : {}; } catch (error) {
    console.error(`  ✗ ${path} is not valid JSON (${error.message}); left untouched`);
    process.exit(0);
  }
}
data.settings = { ...(data.settings ?? {}), mcpFooterStatus: "off" };
fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
console.log(`  ✓ mcp-adapter.json: settings.mcpFooterStatus = off`);
NODE

  # 3. strip the persisted rate lines
  if [ -f "$STRIP" ] && [ -d "$SESSIONS" ]; then
    "$NODE" "$STRIP" --dir "$SESSIONS" --apply 2>/dev/null | tail -2 | sed 's/^/  /'
  fi

  say ""
  say "restart Pi — extensions and the MCP footer setting are read at startup."
fi
