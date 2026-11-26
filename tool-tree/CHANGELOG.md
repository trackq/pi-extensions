# Changelog

## [0.1.1] - 2026-11-26

Fixes tool rows that stayed outside the tree, and rows that disappeared from it.

- `tool-tree` no longer pins a status line in Pi's footer (`/tool-tree status`
  still prints it on demand), so the footer only carries the segments you want.

- `write`, `edit`, `read`, `grep`, `find`, `ls` and `powershell` now join the
  tree instead of drawing their own block, so a turn with file work is still one
  block. Summaries carry the useful numbers (`+N lines`, `+added −removed`, line
  counts), and the expanded node holds the full body.
- A row Pi built with its own renderer — a call made while the tree was off, or
  one whose start event the extension missed — is adopted on the next paint
  (node created if needed, definition swapped, containers re-pointed) instead of
  lingering as `$ cmd` / `search 3 queries`.
- A turn whose first call is outside the handled set no longer swallows the
  tree: only calls the tree draws itself can anchor a group, and rows for tools
  that keep Pi's renderer are never hidden.
- `Ctrl+O` after the turn collapsed shows the nodes instead of a `▾` header
  with nothing under it, and `/tool-tree off` now really means native rendering
  (the row-hiding patch is inert while disabled).
- Tool calls are registered in message order while they stream, so the tree
  follows what the model wrote rather than the order Pi created rows.
- One registry per process, shared across `/reload`; session restore is
  idempotent, so a reload no longer rebuilds (and freezes) live groups.
- Turns stay claimed across later turns: a previous turn's `Thought for …` line
  no longer returns when Pi re-renders it.

## [0.1.0] - 2026-11-26

First public release.

- One tree per turn: thoughts and tool calls share a single block with a header
  carrying counts and total duration.
- One line per node, drill-down on click, double-click for the full output, and
  `/tool-tree open|close|full <n>` for keyboard-only use.
- Reasoning joins the same tree; turns owned by the tree strip the assistant
  message's own reasoning block, and `thinking-fold` is told to stay out of the
  way through `Symbol.for("pi-tool-tree/thinking-claims")`.
- `handledTools: "auto"` covers `ctx_*`, `mcp__*`, `bash`, `web_search` and
  `fetch_content`; other tools keep Pi's own renderers.
- `scope: turn|assistant-message`, auto-collapse at turn end, guarded
  `ToolExecutionComponent` row-hiding patch that restores itself on dispose.
- Every failure degrades to Pi's native rendering instead of throwing.
