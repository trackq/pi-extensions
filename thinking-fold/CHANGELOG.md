# Changelog

## [0.2.0] - 2026-11-26

First release outside the original repository; a fork of
[`@99percentpeople/pi-thinking-fold`](https://github.com/99percentpeople/pi-extensions/tree/master/extensions/thinking-fold).

- DeepSeek is recognised explicitly: by provider (`deepseek`, `deepseek-*`), by
  model name (`deepseek-chat`, `deepseek-reasoner`, `deepseek-v4-*`,
  `deepseek/deepseek-r1` on OpenRouter) and by any `openai-completions` gateway,
  so its traces always fold as full reasoning traces.
- Folding survives tool-calling turns and other thinking extensions: the real
  assistant messages are tracked from the event stream, the foreign thinking
  panel is folded instead of bailing out, and a render-time fallback keeps a
  foreign patch order from silently disabling folding.
- Coexists with `pi-tool-tree`: turns it owns are skipped via
  `Symbol.for("pi-tool-tree/thinking-claims")`.
- No external dependency: settings stay in `~/.pi/agent/99extensions.json` under
  `thinking-fold` (upstream values carry over), configured with
  `/thinking-fold` instead of the `/99settings` plugin.
- Any failure falls back to untouched native rendering; original assistant
  messages, reasoning signatures and session data are never modified.
