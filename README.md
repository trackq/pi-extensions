# pi-extensions — trackq

Two [Pi](https://pi.dev) extensions that change how a turn is drawn in the TUI:
one drill-down block per turn instead of one block per tool call, and reasoning
folded into a single line you can expand. Each lives in its own publishable
package; the repo root is a private workspace that loads both at once, so one git
install gives you the whole set.

| Package | npm | What it does |
|---|---|---|
| [tool-tree](tool-tree) | `pi-tool-tree` | Collapses a turn's thoughts and tool calls into one drill-down tree |
| [thinking-fold](thinking-fold) | `pi-thinking-fold-deepseek` | Folds streaming reasoning into a live tail preview, expands with `Ctrl+T` |

They are independent packages that know about each other: when `tool-tree` owns a
turn, `thinking-fold` stays out of the way (via
`Symbol.for("pi-tool-tree/thinking-claims")`). Either can be installed alone.

```text
▾ tools · 2 calls · 2 thoughts · 2.4s
├─▸ ✓ thought             9 lines · 984ms
├─▸ ✓ bash    pwd         1 line · 29ms
├─▸ ✓ thought             1 line · 589ms
└─▸ ✓ bash    date        1 line · 50ms
```

## Install

Both extensions from git:

```bash
pi install git:github.com/trackq/pi-extensions
```

One extension from npm:

```bash
pi install npm:pi-tool-tree
pi install npm:pi-thinking-fold-deepseek
```

From a local clone:

```bash
git clone https://github.com/trackq/pi-extensions.git
pi install ./pi-extensions/tool-tree
pi install ./pi-extensions/thinking-fold
```

Try it without installing: `pi -e git:github.com/trackq/pi-extensions`.

`pi config` disables one extension after install; `pi remove <source>` uninstalls
the package.

## Requirements

- Pi 1.5.2 or newer. Both extensions patch TUI components and are verified
  against that release; each fails back to Pi's native rendering if an internal
  it depends on moves.
- Mouse interaction needs fullscreen mode (`tuiMode`, Pi's default). Every mouse
  action has a slash-command equivalent.

## Layout

```text
pi-extensions/
├── package.json            private workspace root, loads both extensions
├── tool-tree/              pi-tool-tree
├── thinking-fold/          pi-thinking-fold-deepseek
├── docs/tool-tree-plan.md  design notes and measured internals for tool-tree
└── .github/workflows/      tests and tag-driven npm publish
```

## Development

```bash
npm test                      # both offline render harnesses
npm run test:tool-tree
npm run test:thinking-fold
```

The harnesses render real Pi components and assert on the produced lines. They
read Pi from `~/.pi/agent/install/releases` by default; set `PI_PACKAGES_ROOT` to
a directory holding `pi-ai`, `pi-coding-agent` and `pi-tui` to point them
elsewhere (that is what CI does).

Each package documents its own behavior and settings in its `README.md`, with
manual checks in `TESTING.md`.

## Release

Versions are per package. Publish one:

```bash
npm run publish:tool-tree
npm run publish:thinking-fold
```

Or push a tag and let [the publish workflow](.github/workflows/publish.yml) do it:

```bash
git tag tool-tree-v0.1.1 && git push origin tool-tree-v0.1.1
```

It needs an `NPM_TOKEN` repository secret (an npm automation token). Discovery in
the [Pi package gallery](https://pi.dev/packages) comes from the `pi-package`
keyword in each `package.json`, so a published package appears without further
registration.

## License

MIT — see [LICENSE](LICENSE). `thinking-fold` is a fork of
[`@99percentpeople/pi-thinking-fold`](https://github.com/99percentpeople/pi-extensions/tree/master/extensions/thinking-fold)
by Zach Yuen (MIT); its original license text is kept in
[thinking-fold/LICENSE](thinking-fold/LICENSE).
