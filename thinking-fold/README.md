# pi-thinking-fold (DeepSeek edition)

Fold streaming reasoning into a short live tail preview and expand it with
Pi's thinking shortcut (`Ctrl+T`). This is a fork of
[`@99percentpeople/pi-thinking-fold`](https://github.com/99percentpeople/pi-extensions/tree/master/extensions/thinking-fold)
with three changes:

1. **DeepSeek is recognized explicitly** — by provider (`deepseek`, `deepseek-*`),
   by model name (`deepseek-chat`, `deepseek-reasoner`, `deepseek-v4-*`,
   `deepseek/deepseek-r1` on OpenRouter, …) and by any `openai-completions`
   gateway. DeepSeek traces are always treated as full reasoning traces, so they
   fold the same way as other trace models.
2. **Folding survives tool-calling turns and other thinking extensions.** The
   upstream package gives up (and renders natively) when another extension
   patches `AssistantMessageComponent` first — which is exactly what happens with
   `pi-thinking-steps` installed, and it shows up as "thinking is not summarized
   any more" during `cd` / `ls` / script-running turns. This fork tracks the real
   assistant messages from the extension event stream, folds the foreign thinking
   panel instead of bailing out, and keeps a render-time fallback so a foreign
   patch order can never silently disable folding. Any failure falls back to
   untouched native rendering — it cannot crash the TUI.
3. **No external dependency.** Settings live in the same file and namespace as
   before (`~/.pi/agent/99extensions.json` → `thinking-fold`), so upstream values
   carry over, but the `/99settings` plugin dependency is gone. Configure with the
   `/thinking-fold` command instead.

## Behavior

While a model is thinking, the assistant item shows a timed header plus its
latest terminal-visible lines:

```text
Thinking 7.1s  (ctrl+t to expand)
  checking the final branch…
  validating the result…
```

When reasoning finishes, it collapses to:

```text
Thought for 12.3s  (ctrl+t to expand)
```

`Ctrl+T` (or the configured `app.thinking.toggle` binding) toggles between the
folded view and complete reasoning blocks. The choice persists across turns.
Clicking a thinking block in fullscreen mode toggles the same state.

The extension only changes display-only message copies. Original assistant
messages, reasoning signatures, session persistence and model context are not
modified, and no extra session entries are added.

## Settings

```text
/thinking-fold                                  show current settings
/thinking-fold status                           same
/thinking-fold lines 5                          preview lines kept (1–20)
/thinking-fold while <auto|preview|collapse>    while thinking
/thinking-fold after <auto|collapse|preview|full>   after thinking
/thinking-fold toggle                           fold/unfold now
/thinking-fold reset                            back to defaults
```

Defaults: `lines 5`, `while auto`, `after auto`.

- **while auto**: summary models show only the timer, trace models show the
  latest lines.
- **after auto**: completed reasoning content is hidden (one timed line).

Stored in `~/.pi/agent/99extensions.json`:

```json
{
  "thinking-fold": {
    "foldThreshold": 5,
    "streamingBehavior": "auto",
    "completedBehavior": "auto"
  }
}
```

Legacy `previewLines` / `autoCollapse` values are migrated on load.

## Model behavior table

`model-behaviors.json` maps a model identity (`api`, `provider`, `model` — regex
sources, case-insensitive) to `trace` (raw reasoning is streamed) or `summary`
(the provider sends a reasoning summary). Rules with more selectors win, then
`model` > `provider` > `api`; a later rule wins a remaining tie. Unmatched models
default to `trace`.

DeepSeek rules in this fork:

| Rule | Selectors | Behavior |
|---|---|---|
| `deepseek-trace` | provider `^deepseek$` + model `^deepseek-.*$` | trace |
| `deepseek-provider-trace` | provider `^deepseek(?:-\|$)` | trace |
| `deepseek-model-trace` | model contains `deepseek` | trace |
| `deepseek-openrouter-trace` | provider `^openrouter$` + model `^deepseek/` | trace |

## Install

```bash
pi install npm:pi-thinking-fold-deepseek
```

From this repo instead (installs both extensions):

```bash
pi install git:github.com/trackq/pi-extensions
```

Or test from a local clone without installing:

```bash
pi -e ./thinking-fold
```

Remove with `pi remove <same source>`; `pi config` disables it without
uninstalling.

## Compatibility notes

- Patches `AssistantMessageComponent.updateContent` and `render` and restores both
  on shutdown. Works with the `MouseRegion`-wrapped thinking blocks introduced in
  Pi 0.85 and verified against Pi 1.5.2.
- Coexists with other thinking renderers (verified with `pi-thinking-steps`):
  the foreign panel is replaced by the folded section. The other extension's own
  mode/toggle keeps working but no longer decides how thinking is displayed.
- If Pi's internal child layout changes, the affected message falls back to
  complete native rendering instead of leaking markers or corrupting content.

## License

MIT — see [LICENSE](LICENSE). Original work © 99percentpeople.
