# pi-tool-tree

Collapse a turn's **reasoning and tool calls** into one tree block: a header with
counts and timings, one line per thought/tool, and drill-down detail on demand —
instead of one coloured bucket per call plus a separate "Thought for …" line per
assistant message.

```text
▾ tools · 2 calls · 2 thoughts · 2.4s
├─▸ ✓ thought             9 lines · 984ms
├─▸ ✓ bash    pwd         1 line · 29ms
├─▸ ✓ thought             1 line · 589ms
└─▸ ✓ bash    date        1 line · 50ms
```

With file work in the same turn:

```text
▾ tools · 4 calls · 1 thought · 2.9s
├─▸ ✓ thought                        3 lines · 1.1s
├─▸ ✓ read    /tmp/notes.md          4 lines · 12ms
├─▸ ✓ write   /tmp/notes.md      +4 lines · 88ms
└─▸ ✓ edit    /tmp/notes.md       +1 −1 · 96ms
```

Expanding any line shows its content:

```text
├─▾ ✓ thought                        1 line · 516ms
│   reasoning  Simple: primes 2,3,5,7,11,13,17,19,23,29,31,37 — 12th is 37.
├─▾ ✓ run     date                  1 line · 97ms
│   command    date
│   language   shell
│   output     Thu Nov 26 07:32:50 AM CET 2026
```

When the turn ends the block collapses to a single summary line
(`▸ tools · 2 calls · 2 thoughts · 1.0s`); expand it again to debug. Each row
keeps Pi's theme colours, but the background buckets are gone.

## Interaction

| Action | Result |
|---|---|
| Click a node row | Expand / collapse that node (preview of its output) |
| Double-click a node row | Show the **full** output for that node; double-click again collapses |
| Click the header row (`▸ tools · …`) | Expand a collapsed summary, otherwise collapse everything if anything is open, otherwise expand every node |
| `Ctrl+O` | Pi's own expand-all: every node renders its full output |
| `/tool-tree status` | Prints the settings line and numbers this session's tool calls |
| `/tool-tree open 3` / `close 3` / `full 3` | Drill into node **#3** from `/tool-tree status` (works without a mouse) |
| `/tool-tree expand` / `collapse` / `toggle` | Apply to every group in the session (`expand` reveals a collapsed summary) |
| `/tool-tree collapse-after on\|off` | Auto-collapse the block when a turn ends (default on) |

The mode lives in `~/.pi/agent/99extensions.json`; `/tool-tree status` and every
settings change show a one-line toast with the current settings. Nothing is
pinned to Pi's footer — that line stays free for the segments you actually want
(cwd, context, cost, MCP).

Mouse events only arrive when Pi runs in fullscreen mode (`tuiMode`, Pi's
default). In regular mode use the `/tool-tree open|close|full <n>` commands.

## What gets a tree

`handledTools: "auto"` (default) handles everything Pi draws as a bucket:
`ctx_*`, all `mcp__*` tools, `bash`, `powershell`, `read`, `write`, `edit`,
`grep`, `find`, `ls`, `web_search` and `fetch_content`. A turn is therefore one
block, whatever mix of tools it used — including a `write`/`edit` between two
shell calls.

Summaries carry what matters for file tools: `write` shows the target and
`+N lines`, `edit` shows `+added −removed`, `read` the range and line count,
`grep`/`find` their counts. The expanded node has the full body, so nothing is
lost by folding them in.

Anything else (e.g. `get_search_content`) keeps Pi's own renderer: its row is
**never hidden** and it never anchors a tree, so it cannot swallow the block.

A row that Pi built with its own renderer — a call made while the tree was off,
or one whose start event this package missed — gets a node and is adopted into
the tree on the next paint. Nothing stays behind as a stray `$ cmd` /
`search 3 queries` block once the tree is on.

## Settings

Stored in `~/.pi/agent/99extensions.json` under `tool-tree`:

```json
{
  "tool-tree": {
    "enabled": true,
    "scope": "turn",
    "groupHeader": true,
    "previewLines": 6,
    "treeStyle": "unicode",
    "handledTools": "auto",
    "collapseAfterTurn": true,
    "extraTools": []
  }
}
```

```
/tool-tree on | off                 enable/disable (off = Pi's native rendering)
/tool-tree scope turn|assistant-message
/tool-tree header on|off
/tool-tree style unicode|ascii
/tool-tree lines 6                  output preview rows in a node
/tool-tree handled auto|all
```

- `scope: "turn"` (default): one tree per turn, anchored where the turn's first
  tool call happened.
- `scope: "assistant-message"`: one tree per assistant message; ordering stays
  strictly chronological when the model interleaves text and tool calls.

## How it works

1. `pi.registerToolRenderer` returns `renderShell: "self"` renderers for handled
   tools, so no coloured `Box` is drawn.
2. A registry built from `message_start` / `tool_execution_start|update|end` /
   `turn_end` groups calls, tracks status, durations and results.
3. The group's **first handled tool** row renders the whole tree (thought rows
   have no row of their own); a guarded patch on
   `ToolExecutionComponent.prototype.render` hides the remaining handled rows of
   the group (and forwards `setExpanded`, i.e. `Ctrl+O`, to the tree).
   A row that was built with Pi's own renderer is adopted on the next paint
   (definition swapped, containers re-pointed); rows for tools outside the
   handled set, and rows whose group has no handled call, are left untouched —
   a turn can never lose its calls.
4. Reasoning joins the same tree: one thinking node per assistant message, in
   chronological order. The assistant message's own reasoning block is stripped
   for turns owned by the tree (via a guarded `AssistantMessageComponent`
   patch), so a turn shows one block instead of N "Thought for …" lines.
   `thinking-fold` detects the same claim through
   `Symbol.for("pi-tool-tree/thinking-claims")` and stays out of the way; turns
   without tool calls still get its folded line.
4. Summaries come from the call arguments plus a light parse of the result text
   (`context-mode` results carry `details: {}`). Every failure degrades to a
   generic one-liner — the renderer never throws and Pi's own fallback stays in
   place.

5. One registry lives for the whole Pi process (keyed on
   `Symbol.for("pi-tool-tree/registry")`) and session restore is idempotent, so
   `/reload` keeps the live groups instead of rebuilding them behind the rows Pi
   already rendered.

## Compatibility

- Verified against Pi 1.5.2 (`ToolExecutionComponent`, `registerToolRenderer`,
  `TuiMouseEvent.clickCount`, `MouseRegion` dispatch order).
- The only internals dependency is the row-hiding patch. If it breaks, rows
  still render (one tree per row) and nothing crashes; `dispose()` restores the
  original methods.
- No changes to model context, tool schemas or session persistence. Expansion
  state is in-memory only.

## Install

```bash
pi install npm:pi-tool-tree
```

From this repo instead (installs both extensions):

```bash
pi install git:github.com/trackq/pi-extensions
```

Or from a local clone: `pi install ./tool-tree`. Uninstall with
`pi remove <same source>`; `pi config` disables it without uninstalling.

## Tests

```bash
cd tool-tree
node --experimental-transform-types test/render-regressions.mjs
```

Covers tree shape, connectors, header counts, failed nodes, single-click,
double-click, header toggle, `Ctrl+O`, scope grouping, width safety and the
summariser table.

## License

MIT — see [LICENSE](LICENSE).
