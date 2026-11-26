# Testing brief (tool-tree)

Goal: one tree block per turn (or per assistant message) instead of one tool
bucket per call. One line per call, drill-down details, no layout regressions.

## 1. Automated

```bash
cd tool-tree
node --experimental-transform-types test/render-regressions.mjs
```

Expect `35/35 checks passed` + `OK`. It renders real `ToolExecutionComponent`
instances and covers: tree shape and connectors, header counts (`N calls`,
`1 failed`), error glyphs, single click (preview), double click (full output,
then collapse), header click (collapse-then-expand), `Ctrl+O` parity, grouping
scope, width safety at 60/100/160 columns, and the summariser table.

Add a check here first for any bug you fix.

## 2. Live window checklist

Restart Pi after changing the package (extensions load at startup).

| # | Action | Expected |
|---|---|---|
| 1 | `/tool-tree status` | toast `tool-tree on · turn · preview 6 · N calls — 1.bash …` and the same line pinned in Pi's footer |
| 2 | `Think first, then run pwd with bash and date with ctx_execute` | After the turn: **one summary line** `▸ tools · 2 calls · 1 thought · …`; no separate `Thought for …` lines; no coloured buckets |
| 2b | `/tool-tree expand` | Reveals the block: `thought` nodes interleaved with tool nodes, in the order they happened |
| 3 | `/tool-tree full 2` | Node #2 opens with `command/language/output` rows; header chevron becomes `▾` |
| 4 | `/tool-tree collapse` | Tree folds back to the summary line only |
| 5 | Failing command (`ls /definitely-not-here`) | Node shows `✗`, meta `failed · N lines`, header shows `1 failed` |
| 6 | `/tool-tree off`, run a command | Pi's native rendering returns exactly (buckets, `ctrl+o to expand` hint) |
| 7 | `/tool-tree on` again | Tree returns; `~/.pi/agent/99extensions.json` persists `enabled` |
| 8 | Click a node row (fullscreen terminal) | Expands that node only; double click shows full output |
| 9 | Resume a session with earlier tool calls | Old turns render as trees (restored from session entries) |
| 10 | `scope assistant-message` + a turn with text between calls | One tree per assistant message, strict chronological order |

## 3. Failure signals to report

- More than one header per turn, or duplicate node lines.
- Blank line between nodes (the row-hiding patch did not apply).
- Details shown while collapsed, or "no output" for a call that had output.
- Raw `toolSuccessBg`/bucket rendering for a handled tool.
- `tool-tree disabled:` warning, or any exception in the transcript.
- Header counts not matching the number of node rows.
- A `Thought for …` line *and* a tree `thought` node for the same turn (claim not applied).

## 4. Known limitations / next improvements

- Mouse clicks need Pi's fullscreen mode (`tuiMode` default). In the PTY test
  harness neither our click nor Pi's own click repaints, so mouse behaviour is
  verified offline (`handleMouse` with `clickCount`) and must be confirmed by
  hand in a real terminal.
- Nested codemode calls (`parentToolCallId`) render as deeper tree levels but
  are not yet exercised by a live prompt.
- `read`/`edit`/`write`/`grep`/`glob` intentionally keep Pi's renderers; adding
  them needs summaries for diffs.
- Expansion is per session, in-memory; nothing persisted.

## 5. Files

| File | Role |
|---|---|
| `index.ts` | Renderer registration, event wiring, `/tool-tree` command |
| `registry.ts` | Groups/nodes, status, durations, expansion state, session restore |
| `summaries.ts` | Per-tool one-line summaries and expanded detail rows |
| `node-component.ts` | `TreeComponent` (header, rows, connectors, hit-testing) |
| `patch.ts` | Row hiding + `Ctrl+O` forwarding on `ToolExecutionComponent` |
| `config.ts` | `~/.pi/agent/99extensions.json` → `tool-tree` |
| `test/render-regressions.mjs` | Offline harness |
