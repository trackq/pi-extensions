# plan.md — collapsing tool activity into a drill-down tree

Status: implemented as `pi-tool-tree` (see section 0).
Target: new package `pi-tool-tree` in this repo (`tool-tree/`).
Inspiration: [pi-thinking-steps](https://github.com/rustytensor/pi-thinking-steps) — its *structure* (one panel, three detail levels, patch-safety, click-to-toggle) is good bones. What we fix: today every tool call draws its own coloured bucket ("green line"), several `ctx_search`/`ctx_execute` calls in one turn never collapse together, and the result view is an undifferentiated text dump.

## 0. Status

Implemented as `pi-tool-tree` in `tool-tree/` (installed and verified in a real
Pi window). Steps 0–9 are done; step 10 (rollout) is partly done: the package is
installed, `enabled` is the kill-switch, README/TESTING exist. Remaining work is
listed in section 6.

**Step 0 findings (measured, do not re-derive):**

- `renderShell: "self"` produces exactly **one** leading blank row per tool row
  (`["", ...content]`) — the `Spacer(1)` child is skipped in that branch.
- A nested `MouseRegion`/`handleMouse` receives `clickCount: 2` on double click;
  returning `{ handled: true }` stops Pi's own row toggle.
- Mouse tracking is enabled only by Pi's alt-screen renderer, i.e. only with
  `tuiMode: "fullscreen"` (Pi's default). In the PTY test harness neither our
  click nor Pi's own click-to-expand repaints the screen, so mouse behaviour is
  verified offline and confirmed by hand in the real terminal.
- Class fields shadow prototype methods: a `groups()` method on a class that
  also has a `groups` Map field is unreachable (`registry.groups is not a
  function`) — use `allGroups()`/`allNodes()`.

**Merged reasoning (added after the first review):** per-turn trees now include
one `thought` node per assistant message, and the assistant message's own
reasoning block is stripped for claimed turns. `thinking-fold` checks the shared
claim symbol and stays out, so turns without tools keep their folded line.
Turns auto-collapse to the summary line on `turn_end` (`collapseAfterTurn`).

**Design change vs. the original plan:** instead of only stripping the blank line
of continuation rows, the group's first row renders the whole tree and the patch
hides every other row of the group (`return []`). This is what makes the block
contiguous; the alternatives (per-row rendering) scattered the tree across
assistant messages.

---

## 1. Problem

In a tool-heavy turn Pi renders one `ToolExecutionComponent` per call:
a 1-row `Spacer` + a `Box` filled with `toolPendingBg` / `toolSuccessBg` / `toolErrorBg` (the "green bucket"). With `context-mode`, one agent step commonly emits 3–8 `ctx_*` calls, so the transcript becomes a wall of buckets separated by blank lines. There is no per-turn summary, no grouping by intent, and no way to open *one* line without flipping the whole row (single click already toggles the whole result).

## 2. Goal

For each assistant turn, render **one tree**:

```text
▾ tools · 5 calls · 3.4s · 2 failed
  ├─ ▸ search   "auth middleware", "session cookie"        12 hits   0.3s
  ├─ ▸ execute  python3 parse_orders.py → 42 lines, exit 0          1.2s
  ├─ ▾ execute  curl api/v1/contacts.json                  ⚠ 1 err  0.9s
  │    ├─ cmd     curl -s api/v1/contacts.json
  │    ├─ stdout  {"error":"unauthorized"} …
  │    └─ detail  first 4 of 18 lines · double-click to collapse
  └─ ▸ batch    scripts/summarize.sh, scripts/count.sh     2/2 ok   1.0s
```

Requirements

1. One line per tool call when collapsed; no bucket background, no stray blank line between nodes.
2. Nodes are grouped per assistant turn and stay in execution order; parallel calls keep call order.
3. **Double-click** a node to expand it in place (args + output + timing); double-click again to collapse. Single click on the group header toggles every node.
4. Optional children under a node: command line, stdout/stderr excerpt, search queries, hit counts, indexed URLs, exit code.
5. The whole group is one keyboard focusable unit for `/tool-tree` commands; `Ctrl+O` still expands/collapses everything.
6. Streaming: a running node shows a spinner/`…` and updates in place; a finished node shows duration + status.
7. Restoration: previous turns re-render as trees after `/reload` or session resume.
8. Any failure falls back to Pi's native rendering — never crash the TUI, never leak markers.

Non-goals: replacing `read`/`edit` diffs (keep Pi's diff renderer), changing model context, changing tool schemas, or persisting expansion state across sessions (v1: in-memory; revisit later).

---

## 3. Verified platform facts (do not re-research)

| Fact | Where |
|---|---|
| `pi.registerToolRenderer(resolver)` chooses renderers per tool name; resolvers run in load order, `next()` falls through | `pi-coding-agent/dist/core/extensions/types.d.ts:1301` |
| `ToolRenderers = { renderShell, renderCall, renderResult }`; `renderShell: "self"` bypasses Pi's coloured `Box` | same file `:489`, `:541` |
| `renderCall(args, theme, ctx)`, `renderResult(result, {expanded, isPartial}, theme, ctx)` | `:536-538` |
| `ToolRenderContext`: `args`, `toolCallId`, `invalidate()`, `lastComponent`, `state`, `cwd`, `executionStarted`, `argsComplete`, `isPartial`, `expanded`, `isError`, `durationMs`, `outputPad`, `keyText`, `keyHint` | `:370-397` |
| Per call Pi creates `ToolExecutionComponent`: `Spacer(1)` + `Box(1,1, bg toolPendingBg/SuccessBg/ErrorBg)`; default result is truncated to 10 lines; wrapping `MouseRegion` toggles `expanded` on click | `dist/modes/interactive/components/tool-execution.js` |
| With `renderShell:"self"` Pi renders `["", ...content]` — one leading blank line per row (removable only by a small patch, see step 5) | same file, `render()` |
| `TuiMouseEvent.clickCount` exists (double-click is reported) | `pi-tui/dist/tui.d.ts:31` |
| `MouseRegion.handleMouse` dispatches to its child **first**, so an inner region can claim a click and stop Pi's row toggle | `pi-tui/dist/components/mouse-region.js` |
| Events: `tool_execution_start|update|end` carry `toolCallId`, `toolName`, `args`, `result`, `isError`, `durationMs`, `parentToolCallId` | `types.d.ts:873-902` |
| Existing events for grouping: `message_start`, `message_update`, `turn_start`, `turn_end` | `types.d.ts` |
| Theme tokens available: `success`, `error`, `warning`, `muted`, `accent`, `borderMuted`, `text`, `toolOutput`, `toolDiffAdded/Removed` | `theme/dark.json`, `system-theme.js` |
| `context-mode` tool results have `details: {}` — summaries must be derived from call args + result text | sampled sessions: `ctx_execute` (765), `ctx_batch_execute`, `ctx_search`, `ctx_fetch_and_index`, `ctx_resume`, `ctx_doctor`, `ctx_upgrade` |

---

## 4. Architecture

Two cooperating pieces, both in the new package:

1. **Renderer (`registerToolRenderer`)** — for each call of a handled tool return `renderShell: "self"` and a one-line `ToolNodeComponent`; `renderResult` returns the expanded body when `ctx.expanded` (node-level) is true.
2. **Group model (events + one small patch)** — a `ToolTreeRegistry` built from `message_start`/`tool_execution_*`/`turn_end` decides group membership, order, summaries and per-node expansion; a patched `ToolExecutionComponent.prototype.render` drops the leading blank line for continuation rows so the tree is tight.

Why not only renderers: a renderer cannot draw a header once per group or know about sibling calls. Why not reparent components: Pi owns `chatContainer` and we do not want to move its children around (fragile across versions, breaks `Ctrl+O`, `setShowImages`, `/tree`).

Fallback ladder for every step: renderer throws → Pi wraps it in `try/catch` and uses its own fallback (already true); our patch throws → restore the original method and render natively; nothing found → pass through with `next()`.

---

## 5. Implementation steps

Each step is shippable and verifiable on its own. Do not skip step 0.

### Step 0 — spike (half a day)

1. In a scratch extension, `pi.registerToolRenderer((name, next) => name.startsWith("ctx_") ? { renderShell: "self", renderCall: () => new Text(`node ${name}`) } : next())`.
2. Start `pi -e scratch/index.ts`, run one `ctx_execute` call. Confirm: no coloured bucket, one line, and count how many blank lines surround it (expect the `Spacer(1)` + the `""` from self-shell → 2).
3. Add an inner `MouseRegion(component, e => { if (e.clickCount === 2) { log("dbl"); return { handled: true }; } })`; confirm double-click fires and Pi's outer expand toggle does **not** fire when we return `handled`.
4. Confirm `renderResult` receives `{ expanded }` that still toggles on single click outside our inner regions.

Exit criteria: node rendering, double-click capture and the blank-line count are known facts; write them into this file before continuing.

### Step 1 — package skeleton (no visible change)

1. `tool-tree/package.json`: `name: "pi-tool-tree"`, `type: "module"`, `pi.extensions: ["./index.ts"]`, peerDeps on `pi-ai`, `pi-coding-agent`, `pi-tui` (same as `thinking-fold/package.json`).
2. `index.ts`: default export `(pi) => { pi.registerToolRenderer((name, next) => next()); }` — pure pass-through.
3. `pi install ./tool-tree`; `pi list` shows it; `/tool-tree` command registered but only prints "tool-tree: 0 nodes" .
4. Verify: transcript identical to without the package.

### Step 2 — registry from events

`registry.ts`:

```ts
interface ToolNode {
  toolCallId: string; toolName: string; args: unknown;
  startedAt: number; endedAt?: number; durationMs?: number;
  status: "running" | "ok" | "error";
  resultText?: string; details?: unknown; isError?: boolean;
  expanded: boolean;                       // node-level, in-memory
  parentToolCallId?: string;               // codemode nesting
}
interface ToolGroup {
  id: string;                              // assistant message timestamp
  nodes: ToolNode[];                       // execution order
  expandedAll: boolean;
}
```

1. `message_start` (assistant) → open a new group; `tool_execution_start` → push a node into the current group; `tool_execution_update` → store `partialResult` text; `tool_execution_end` → finalise status/duration/result; `turn_end` → close the group.
2. Nest nodes whose `parentToolCallId` matches another node (codemode).
3. Expose `groupFor(toolCallId)`, `isContinuation(toolCallId)` (not the group's first node), `nodeByCallId`.
4. Verify with a 3-call prompt: log node order and durations; assert one group per assistant message.

### Step 3 — one-line node renderer

`node-renderer.ts`:

1. `formatNodeLine(node, theme, width)` → status glyph (`⠋` running, `✓` ok, `✗` error) + tool icon/label + subject summary + right-aligned `hits`/`lines` + duration.
2. Subject summarisers per tool (pure functions, unit-tested):
   | tool | subject | meta |
   |---|---|---|
   | `ctx_search` | quoted queries, comma-joined, truncated | `N hits` (count `Query "…"` sections in result) |
   | `ctx_execute`, `bash` | command, first line only | `N lines · exit N` |
   | `ctx_execute_file` | file path | `N lines` |
   | `ctx_batch_execute`, `ctx_batch` | comma-joined commands/scripts | `ok/total` |
   | `ctx_fetch_and_index`, `ctx_index` | hostnames, comma-joined | `N sections · KB` |
   | `web_search` / `fetch_content` (has `details`) | queries/urls | `details.totalResults`, `totalChars` |
   | `read`/`write`/`edit`/`grep`/`glob` | path / pattern | `N lines` / `N files` |
   | unknown | `JSON.stringify(args)` truncated to width | result byte count |
3. `renderCall` returns `ToolNodeComponent` with `renderShell: "self"`.
4. `renderResult` returns the same component instance when possible (`ctx.lastComponent`) so expansion state is preserved; the component reads `node` from the registry and `ctx.expanded`.
5. Verify: collapsed turn shows one line per call, spinners update, no ANSI leakage at widths 60/100/160.

### Step 4 — expanded body

1. Node body rows, indented 4, prefixed `│ `:
   - `cmd` — full command / all queries / all URLs, wrapped via `truncateToVisualLines`.
   - `out` — result text: first 6 lines collapsed-preview, `… N more lines`, full text when the node is expanded.
   - `err` — error message in `theme.fg("error")`.
   - `meta` — duration, exit code, bytes/sections when present.
2. Node expansion is per `toolCallId`; group expansion is `expandedAll`.
3. Verify: expanding one node leaves siblings collapsed; streaming text never reflows the tree height (fixed max rows for the preview).

### Step 5 — grouping visuals

1. Group header component rendered by the **first** node of the group: `▾ tools · 5 calls · 3.4s` (+ `· 1 failed` in error colour); `▸` when fully collapsed.
2. Connectors: `├─` for all but the last node, `└─` for the last; children `│  ├─`.
3. Patch `ToolExecutionComponent.prototype.render` so continuation rows of a group render `[]` (the head row draws the whole tree). Guard: unknown call ids return the original lines. Restore the original on `session_shutdown`.
4. If the patch is unavailable (Pi changed), accept one blank line per node and log nothing — visuals only.
5. Verify: at 100 columns a 5-call turn is 6 lines + header, with no double blank lines; `Ctrl+O` still expands (see step 6).

### Step 6 — interaction

1. `MouseRegion` per node: single click → toggle that node; `event.clickCount === 2` → toggle node *and* its children; return `{ handled: true }` so Pi's row-level toggle never fires inside the tree.
2. Header row: click → toggle `expandedAll`; double click → toggle `treeStyle`? (no — keep single action only).
3. Keyboard: `/tool-tree status`, `/tool-tree open|close|full <n>` (numbered from `status`), `/tool-tree expand|collapse|toggle`, `/tool-tree lines N`. `Ctrl+O` is honoured through `ctx.expanded` plus the `setExpanded` hook: `true` expands every node with full output, `false` collapses the group. Mouse only works in fullscreen mode, hence the numbered keyboard path.
4. Disable Pi's click-to-expand interplay: our node regions claim clicks; the blank area right of a node still toggles Pi's row — acceptable v1, remove via the step-5 patch if needed.
5. Verify each interaction and that `Ctrl+O` twice returns to the collapsed tree.

### Step 7 — restore and reload

1. On `session_start`, walk `ctx.sessionManager.getEntries()`: assistant `toolCall` blocks + following `toolResult` messages → rebuild groups/nodes with `durationMs` where recorded; mark as `ok|error` from `isError`.
2. Rebuild must not change totals (assert node count equals the number of `toolCall` blocks in the session).
3. Verify: `/reload` mid-session, then scroll up — old turns render as trees.

### Step 8 — settings

`config.ts`, same self-contained pattern as `thinking-fold/config.ts`:

```json
{ "tool-tree": { "enabled": true, "scope": "turn", "groupHeader": true,
                 "previewLines": 6, "treeStyle": "unicode", "handledTools": "auto" } }
```

1. `scope: "turn" | "assistant-message"`; `handledTools: "auto" | "all" | "list"` with `auto` = `ctx_*`, `bash`, `web_search`, `fetch_content`, MCP namespaces.
2. `enabled: false` → resolver passes through (`next()`), patch inactive.
3. Verify round-trip via the JSON file and after restart.

### Step 9 — tests

1. `tool-tree/test/render-regressions.mjs`, modelled on `thinking-fold/test/render-regressions.mjs`: copy the package into a temp dir, symlink `@earendil-works/*` from the newest release, instantiate `ToolExecutionComponent` directly with a fake tool definition + renderers, and assert:
   - collapsed row count per node = 1 (after the step-5 patch),
   - header printed once per group,
   - connectors correct for 1/2/5 nodes,
   - double-click toggles only its node (simulate `handleMouse` with `clickCount: 2`),
   - `Ctrl+O` expanded path shows the full result text,
   - no marker/u0000 leakage, width 60/100/160 snapshots.
2. `tool-tree/test/summaries.mjs`: table-driven summariser tests (tool args in → one-line out) including unknown tools and huge args.
3. PTY smoke test (reuse `/tmp/tf-test/pty_run.py` pattern): run `pwd`, `ls`, one `ctx_search`, one failing command; assert on screen: single header, N node lines, no `toolSuccessBg` bucket count > 0.

### Step 10 — rollout

1. Ship default `enabled: true` for `ctx_*` only, `bash` opt-in; document in `README.md` + `TESTING.md`.
2. Keep the pass-through flag; if any Pi upgrade breaks the layout, flip `enabled` via `/tool-tree off` without uninstalling.
3. Watch for: Pi version drift in `ToolExecutionComponent`, `chatContainer` ordering, `Ctrl+O` semantics, mouse dispatch order.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Pi changes `ToolExecutionComponent` internals | Only the blank-line patch depends on them; guard + restore + visual fallback |
| Renderer exceptions | Pi already try/catches renderers and falls back; keep renderers pure and cheap |
| Parallel tool calls with interleaved results | Group by assistant message, order by `tool_execution_start` |
| `details: {}` for `ctx_*` | Summaries from args + result text only; never require details |
| Very large results | Never render full text in collapsed mode; `truncateToVisualLines`; preview cap |
| Nested codemode calls | `parentToolCallId` → child nodes, indent one level |
| Session restore mismatches | Rebuild from entries; assert counts in tests |
| Conflict with other tool renderers | Resolver order: our package last so `next()` still composes; expose `/tool-tree off` |

## 6b. Remaining work

1. Confirm mouse click / double click by hand in a real fullscreen terminal (the
   PTY harness cannot repaint on click, for Pi's own rows either).
2. Exercise nested codemode calls (`parentToolCallId`) with a live prompt.
3. Optional: include `read`/`write`/`edit`/`grep`/`glob` (needs diff-aware
   summaries).
4. Optional: persist per-node expansion across restarts.
5. If Pi ever exposes a group-level chat child (or a tool-batch renderer), drop
   the row-hiding patch and render the group natively.

## 7. Definition of done

- A 5-call turn renders as one header + 5 single-line nodes, no coloured buckets, no blank-line gaps.
- Double-click expands exactly one node; single click on the header toggles all; `Ctrl+O` works.
- Summaries correct for `ctx_search`, `ctx_execute`, `ctx_batch_execute`, `ctx_fetch_and_index`, `bash`, `web_search`, `fetch_content`, and an unknown tool.
- `render-regressions.mjs` and `summaries.mjs` pass; PTY smoke test passes.
- `/reload` restores trees for old turns; disabling the package restores Pi's native output exactly.
