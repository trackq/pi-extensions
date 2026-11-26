# Testing brief (for a fresh agent)

Goal: two behaviours must hold for **every** assistant message, including turns
with tool calls, and even when another extension renders thinking.

1. While reasoning streams: one header line `Thinking <n>.<n>s  (ctrl+t to expand)`
   plus at most `foldThreshold` preview lines.
2. When reasoning ends: one line `Thought for <n>.<n>s  (ctrl+t to expand)`;
   `Ctrl+T` shows the complete reasoning again. No duplicated headers, no leaked
   marker characters (`\uE000`), no foreign thinking panel, no Pi crash warning.

## 1. Automated harness (fast, deterministic, no API cost)

```bash
cd thinking-fold
node --experimental-transform-types test/render-regressions.mjs
```

Expected: `72/72 checks passed` + `OK` (exit code 0).

It renders synthetic DeepSeek turns (`thinking`, `thinking + text + 2 toolCalls`,
`thinking + toolCall`, `thinking + text`) through Pi's real
`AssistantMessageComponent` in three patch orderings:

| Ordering | Simulates |
|---|---|
| `native` | no other thinking extension |
| `foreign-before` | another extension patched `updateContent` first (we are outer) |
| `foreign-after` | another extension patched `updateContent` last (it hides reasoning from us; the real `pi-thinking-steps` case) |

When adding a fix, add a check here first, then run the harness.

## 2. Manual TUI checks (installed package)

Restart Pi (extensions load at startup), then:

| # | Action | Expected |
|---|---|---|
| 1 | `/thinking-fold status` | `Thinking fold · fold after 5 lines · while thinking: auto · after thinking: auto` and the `~/.pi/agent/99extensions.json` path. Unknown command ⇒ this window is stale, restart it. |
| 2 | Ask a reasoning-heavy question | `Thinking X.Xs  (ctrl+t to expand)` streaming, a few reasoning lines, then `Thought for X.Xs  (ctrl+t to expand)` |
| 3 | `Ctrl+T` | Full reasoning appears on the same message; press again to fold. State persists on later turns. |
| 4 | `Run pwd and ls with the bash tool, then tell me what you found.` | Every assistant message folds (each gets its own timer). No `┆ Thinking Steps · …` panel, no wall of raw reasoning. |
| 5 | `/thinking-fold lines 8` then repeat step 2 | Up to 8 preview lines; `~/.pi/agent/99extensions.json` shows `"foldThreshold": 8` |
| 6 | `/thinking-fold while collapse` / `after preview` | While thinking: timer only. After: preview lines instead of hiding. |
| 7 | `/thinking-fold after full` | Reasoning stays expanded after completion; `Ctrl+T` still toggles. |
| 8 | Restart Pi, repeat step 2 | Same settings (read back from disk). |
| 9 | Non-DeepSeek model (e.g. a Google model) | Still works; summary models show the timer only while streaming. |

Ctrl+T should also work on restored sessions (previous messages expand).

## 3. Failure signals to report

- `Thought for …` missing on a tool-call turn, or reasoning shown unfolded.
- Two `Thinking…`/`Thought for…` headers on one message (double fold).
- Raw `thinking panel:`, `┆ Thinking Steps`, or `\uE000` characters visible.
- `Warning: pi crashed …` banner (any exception in the patched `render`/
  `updateContent` must be caught and fall back to native rendering).
- Blank assistant message or missing answer text.
- `/thinking-fold` unknown command after restart (package not loaded — check `pi list`).

## 4. Where things live

| File | Role |
|---|---|
| `index.ts` | Extension wiring: events → timings, cursor label, `Ctrl+T` input, `/thinking-fold` command |
| `renderer.ts` | Prototype patch: marker fold (`updateContent`), foreign-panel fold + render fallback (`render`), timings, cursor label |
| `model-behaviors.ts` / `.json` | api/provider/model regex rules → `trace` or `summary`; unmatched defaults to `trace` |
| `config.ts` | Self-contained settings in `~/.pi/agent/99extensions.json` → `thinking-fold` (upstream-compatible schema) |
| `test/render-regressions.mjs` | The harness above |

Key renderer invariants:

- Never throw out of the patched methods; always fall back to
  `record.originalRender` / `record.originalUpdate`.
- `record.states.get(component).fullMessage` may arrive without reasoning when
  another extension strips it — use `resolveDisplayMessage()` (event-tracked
  messages) for any folding decision.
- Never treat `RenderedThinkingSection` as a foreign component.
- The render cache is per component and keyed by message timestamp.

## 5. Known limitations worth improving

- Foreign panels are recognised by component name (`/thinking|reasoning/i`) or by
  contained reasoning text; a foreign renderer with an unrelated class name and
  paraphrased content would fall back to native (safe, but unfolded).
- Multiple thinking runs in one message are folded in place; the render-level
  fallback places all folded sections at the top of the message.
- Only the `preview`/`collapse`/`full` display behaviours and `trace`/`summary`
  model behaviours exist; adding e.g. per-model overrides in
  `model-behaviors.json` needs no code change.
- Verified against Pi 1.5.2 only; Pi's `AssistantMessageComponent` internals are
  structural assumptions (`contentContainer.children`, `outputPad`,
  `hideThinkingBlock`, `thinkingVisibilityOverrides`).
