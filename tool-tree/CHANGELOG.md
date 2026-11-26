# Changelog

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
