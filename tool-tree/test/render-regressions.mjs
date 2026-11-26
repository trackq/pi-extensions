#!/usr/bin/env node
/**
 * Offline regression harness for pi-tool-tree.
 *
 * Renders real `ToolExecutionComponent` instances with this package's renderers
 * and asserts on the produced lines plus click / double-click / Ctrl+O behaviour.
 *
 *   node --experimental-transform-types test/render-regressions.mjs
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));

function piPackagesRoot() {
  const override = process.env.PI_PACKAGES_ROOT;
  if (override) {
    const version = JSON.parse(readFileSync(join(override, "pi-coding-agent", "package.json"), "utf8")).version;
    return { release: `${version} (PI_PACKAGES_ROOT)`, root: override };
  }
  const releases = join(homedir(), ".pi", "agent", "install", "releases");
  const versions = readdirSync(releases).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const latest = versions.at(-1);
  if (!latest) throw new Error(`No Pi release found under ${releases}`);
  return { release: latest, root: join(releases, latest, "node_modules", "@earendil-works") };
}

const { release, root: piRoot } = piPackagesRoot();
const work = mkdtempSync(join(tmpdir(), "tool-tree-test-"));
mkdirSync(join(work, "node_modules", "@earendil-works"), { recursive: true });
for (const pkg of ["pi-ai", "pi-coding-agent", "pi-tui"]) {
  symlinkSync(join(piRoot, pkg), join(work, "node_modules", "@earendil-works", pkg), "dir");
}
const ext = join(work, "ext");
mkdirSync(ext, { recursive: true });
for (const file of ["config.ts", "registry.ts", "summaries.ts", "node-component.ts", "patch.ts"]) {
  cpSync(join(extensionRoot, file), join(ext, file));
}

const { ToolExecutionComponent } = await import(
  `${piRoot}/pi-coding-agent/dist/modes/interactive/components/tool-execution.js`
);
const themeMod = await import(`${piRoot}/pi-coding-agent/dist/modes/interactive/theme/theme.js`);
if (themeMod.initTheme) themeMod.initTheme("dark");
const { EmptyComponent, TreeComponent } = await import(`${ext}/node-component.ts`);
const { Text } = await import(`${piRoot}/pi-tui/dist/index.js`);
const { ToolTreeRegistry } = await import(`${ext}/registry.ts`);
const { DEFAULT_TOOL_TREE_CONFIG, shouldHandleTool } = await import(`${ext}/config.ts`);
const { installToolTreePatch } = await import(`${ext}/patch.ts`);
const { summarizeToolCall, expandedDetailRows } = await import(`${ext}/summaries.ts`);

const theme = themeMod.theme;
const strip = (value) => value.replace(/\x1b\[[0-9;]*m/g, "");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  if (!ok) console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};
const ui = { requestRender() {} };

/** Installs the patch, builds components for a list of calls, and disposes afterwards. */
function withScene(calls, run, config = { ...DEFAULT_TOOL_TREE_CONFIG }) {
  const registry = new ToolTreeRegistry(config);
  const rowRenderers = (toolName) => ({
    name: toolName,
    label: toolName,
    renderShell: "self",
    renderCall: (callArgs, t, ctx) => {
      const node = registry.node(ctx.toolCallId);
      const group = node ? registry.groupFor(node) : undefined;
      if (!group) return new EmptyComponent();
      return new TreeComponent({
        registry,
        group,
        config,
        theme: t,
        piExpanded: ctx.expanded,
        invalidate: () => {},
        now: () => Date.now(),
      });
    },
    renderResult: () => new EmptyComponent(),
  });
  const patch = installToolTreePatch(registry, (toolName) =>
    shouldHandleTool(toolName, config) ? rowRenderers(toolName) : undefined,
  );
  registry.startTurn();
  registry.startAssistantMessage(Date.now());

  const components = calls.map(({ toolName, callId, args, result = "", isError = false, durationMs = 120, handled = true, noNode = false }) => {
    if (!noNode) {
      registry.startNode({ toolCallId: callId, toolName, args });
      registry.endNode({
        toolCallId: callId,
        toolName,
        result: { content: [{ type: "text", text: result }] },
        isError,
        durationMs,
      });
    }
    const definition = handled
      ? rowRenderers(toolName)
      : {
          // Stand-in for Pi's own renderer (read/write/edit/…): a plain row that
          // this package must leave alone.
          name: toolName,
          label: toolName,
          renderCall: (callArgs, t) => new Text(`${toolName} native row`, 0, 0),
          renderResult: () => new EmptyComponent(),
        };
    const component = new ToolExecutionComponent(
      toolName,
      callId,
      args,
      { showImages: false, imageWidthCells: 60, outputPad: 1 },
      definition,
      ui,
      process.cwd(),
    );
    component.setArgsComplete();
    component.markExecutionStarted();
    component.updateResult({ content: [{ type: "text", text: result }], details: {} }, false);
    return component;
  });

  const lines = (component, width = 100) => {
    const rows = strip(component.render(width).join("\n")).split("\n");
    return rows[0] === "" ? rows.slice(1) : rows;
  };
  const clickTreeRow = (component, treeRow, clickCount = 1) => {
    // A real click always follows a drawn frame; render once so the row map exists.
    component.render(100);
    return component.handleMouse({
      type: "click",
      button: "left",
      x: 6,
      y: treeRow + 1, // self-shell rows start with one blank line
      clickCount,
      screenX: 6,
      screenY: treeRow + 1,
      width: 100,
      height: 10,
      shift: false,
      alt: false,
      ctrl: false,
    });
  };

  try {
    run({ registry, components, lines, clickTreeRow });
  } finally {
    patch.dispose();
  }
}

console.log(`== tool-tree regressions (pi ${release}) ==`);

// ---- long output: preview vs full ---------------------------------------
withScene(
  [{ toolName: "bash", callId: "long1", args: { command: "seq 1 40" }, result: Array.from({ length: 40 }, (_, i) => `row ${i + 1}`).join("\n") }],
  ({ components, lines, clickTreeRow }) => {
    const component = components[0];
    clickTreeRow(component, 1, 1);
    const preview = lines(component);
    check("single click shows a capped preview", /more lines/.test(preview.join("\n")), preview.join(" | "));
    clickTreeRow(component, 1, 2);
    const full = lines(component);
    check("double click shows the full output", /row 40/.test(full.join("\n")) && !/more lines/.test(full.join("\n")));
    clickTreeRow(component, 1, 2);
    check("double click on a full node collapses it", lines(component).length === 2, String(lines(component).length));
    component.setExpanded(true);
    const ctrlO = lines(component);
    check("Ctrl+O shows full output", /row 40/.test(ctrlO.join("\n")));
    component.setExpanded(false);
    check("Ctrl+O off collapses the tree", lines(component).length === 2, lines(component).join(" | "));
  },
);

// ---- three calls, one failing -------------------------------------------
withScene(
  [
    { toolName: "bash", callId: "c1", args: { command: "pwd" }, result: "/tmp/project", durationMs: 90 },
    { toolName: "ctx_execute", callId: "c2", args: { language: "shell", code: "date" }, result: "Thu Jan 1 00:00:00 CET 2026", durationMs: 100 },
    { toolName: "ctx_search", callId: "c3", args: { queries: ["alpha", "beta"] }, result: 'Query "alpha":\n3 hits\n\nQuery "beta":\n1 hit', isError: true, durationMs: 130 },
  ],
  ({ components, lines, clickTreeRow }) => {
    const [head, second] = components;
    const rows = lines(head);
    check("head renders every call once", rows.filter((line) => /[├└]─/.test(line)).length === 3, rows.join(" | "));
    check("non-head rows render nothing", second.render(100).length === 0, JSON.stringify(second.render(100)));
    check("header counts calls and failures", /3 calls/.test(rows[0]) && /1 failed/.test(rows[0]), rows[0]);
    check("failed node uses the error glyph", /✗/.test(rows[3]), rows[3]);
    check("connectors: branch, branch, last", /├─/.test(rows[1]) && /├─/.test(rows[2]) && /└─/.test(rows[3]));
    check("collapsed rows show no output", !rows.some((line) => /output/.test(line)));
    check("search meta counts queries", /2 queries/.test(rows[3]), rows[3]);

    clickTreeRow(head, 2, 1);
    const expandedOne = lines(head);
    check(
  "single click expands only that node",
  /▾/.test(expandedOne[2]) && /command\s+date/.test(expandedOne.join("\n")),
  expandedOne.join(" | "),
);
    check(
      "siblings stay collapsed",
      /├─▸ ✓ bash/.test(expandedOne.join("\n")) && /└─▸ ✗ search/.test(expandedOne.join("\n")),
      expandedOne.join(" | "),
    );

    // A node is open, so the first header click collapses everything.
    clickTreeRow(head, 0, 1);
    const allClosed = lines(head).join("\n");
    check("header click collapses open nodes", !/▾/.test(allClosed) && !/command/.test(allClosed), allClosed);

    clickTreeRow(head, 0, 1);
    const allOpen = lines(head).join("\n");
    check(
      "header click expands every node",
      ["bash", "run", "search"].every((label) => new RegExp(`▾ [✓✗] ${label}`).test(allOpen)),
      allOpen,
    );

    for (const width of [60, 100, 160]) {
      const overflow = lines(head, width).filter((line) => Array.from(line).length > width);
      check(`no line exceeds ${width} columns`, overflow.length === 0, overflow[0]);
    }
  },
);

// ---- summary table ------------------------------------------------------
const summaryCases = [
  ["ctx_search", { queries: ["a", "b"] }, 'Query "a":\n2 hits', /"a", "b"/, /2 queries/],
  ["ctx_execute", { language: "shell", code: "date" }, "Thu Jan 1", /date/, /1 line/],
  ["ctx_batch_execute", { commands: [{ label: "tree", command: "find ." }] }, "ok", /tree/, /1 cmd/],
  ["ctx_fetch_and_index", { requests: [{ url: "https://example.com/x" }] }, "3 sections 12KB", /example\.com/, /3 sections/],
  ["bash", { command: "ls -la" }, "a\nb", /ls -la/, /2 lines/],
  ["read", { path: "/tmp/x.ts", limit: 80 }, "a\nb\nc", /x\.ts/, /3 lines/],
  ["write", { path: "/tmp/x.ts", content: "a\nb" }, "Successfully wrote to /tmp/x.ts", /x\.ts/, /\+2 lines/],
  ["edit", { path: "/tmp/x.ts", edits: [{ oldText: "a", newText: "b\nc" }] }, "ok", /x\.ts/, /\+2 −1/],
  ["grep", { pattern: "TODO", path: "src" }, "src/a.ts:1: TODO\nsrc/b.ts:9: TODO", /TODO/, /2 matches/],
  ["find", { pattern: "*.ts", path: "src" }, "src/a.ts\nsrc/b.ts", /\*\.ts/, /2 files/],
  ["ls", { path: "src" }, "a.ts\nb.ts", /src/, /2 entries/],
  ["web_search", { queries: ["q"] }, "3 results", /"q"/, /3 results/],
  ["unknown_tool", { path: "/tmp/x" }, "one", /\/tmp\/x/, /1 line/],
];
for (const [toolName, args, resultText, subjectRe, metaRe] of summaryCases) {
  const summary = summarizeToolCall({ toolName, args, resultText });
  check(
    `summary ${toolName}`,
    subjectRe.test(summary.subject) && metaRe.test(summary.meta ?? ""),
    `${summary.subject} | ${summary.meta}`,
  );
  check(`details ${toolName}`, expandedDetailRows(summary, { previewLines: 6, expanded: false }).length > 0);
}

// ---- thoughts join the tree --------------------------------------------
const thinkingScene = (() => {
  const registry = new ToolTreeRegistry({ ...DEFAULT_TOOL_TREE_CONFIG });
  registry.startTurn();
  registry.startAssistantMessage(1000);
  registry.noteAssistantMessage(1000);
  registry.upsertThinking(1000, "Reasoning line one\nReasoning line two");
  registry.endThinking(1000);
  registry.startNode({ toolCallId: "th1", toolName: "bash", args: { command: "pwd" } });
  registry.claimTurnForThinking();
  registry.endNode({ toolCallId: "th1", toolName: "bash", result: { content: [{ type: "text", text: "/tmp" }] }, isError: false, durationMs: 50 });
  return registry;
})();
const thinkingGroup = thinkingScene.allGroups()[0];
check("thought node is part of the group", thinkingGroup.nodes[0]?.kind === "thinking", JSON.stringify(thinkingGroup.nodes.map((n) => n.kind)));
check("thought node is finalized", thinkingGroup.nodes[0]?.status === "ok");
check("turn claims its reasoning", thinkingScene.claimsMessage(1000) === true);
check("group head is the first tool, not the thought", thinkingScene.isGroupHead(thinkingGroup.nodes[0]) === false && thinkingScene.isGroupHead(thinkingGroup.nodes[1]) === true);
const totals = thinkingScene.groupSummary(thinkingGroup);
check("summary separates calls and thoughts", totals.calls === 1 && totals.thoughts === 1, JSON.stringify(totals));

// ---- grouping scope -----------------------------------------------------
function scopeGroups(scope) {
  const registry = new ToolTreeRegistry({ ...DEFAULT_TOOL_TREE_CONFIG, scope });
  registry.startTurn();
  registry.startAssistantMessage(1000);
  registry.startNode({ toolCallId: "a1", toolName: "bash", args: { command: "one" } });
  registry.startAssistantMessage(2000);
  registry.startNode({ toolCallId: "a2", toolName: "bash", args: { command: "two" } });
  return registry.allGroups().map((group) => group.nodes.length);
}
check("scope turn merges a whole turn into one tree", JSON.stringify(scopeGroups("turn")) === "[2]", JSON.stringify(scopeGroups("turn")));
check(
  "scope assistant-message yields one tree per message",
  JSON.stringify(scopeGroups("assistant-message")) === "[1,1]",
  JSON.stringify(scopeGroups("assistant-message")),
);

// ---- native tools keep their own rows -----------------------------------
withScene(
  [
    { toolName: "get_search_content", callId: "r1", args: { url: "x" }, result: "a\nb", handled: false },
    { toolName: "bash", callId: "b1", args: { command: "pwd" }, result: "/tmp" },
  ],
  ({ components, lines }) => {
    const [nativeRow, head] = components;
    check("native row is never hidden", lines(nativeRow).length > 0, JSON.stringify(nativeRow.render(100)));
    const rows = lines(head);
    check("tree is anchored on the first handled call", /1 call/.test(rows[0]), rows[0]);
    check(
      "native tool does not get a tree row",
      rows.filter((line) => /[├└]─/.test(line)).length === 1,
      rows.join(" | "),
    );
  },
);

withScene(
  [
    { toolName: "get_search_content", callId: "r2", args: { url: "x" }, result: "a", handled: false },
    { toolName: "get_search_content", callId: "w2", args: { url: "y" }, result: "b", handled: false },
  ],
  ({ components }) => {
    check(
      "a group of native tools hides nothing",
      components.every((component) => component.render(100).length > 0),
      components.map((component) => component.render(100).length).join(","),
    );
  },
);

// ---- file tools live in the tree too -----------------------------------
withScene(
  [
    { toolName: "read", callId: "f1", args: { path: "/tmp/a.ts" }, result: "one\ntwo" },
    { toolName: "write", callId: "f2", args: { path: "/tmp/b.ts", content: "one\ntwo\nthree" }, result: "Successfully wrote to /tmp/b.ts" },
    { toolName: "edit", callId: "f3", args: { path: "/tmp/c.ts", edits: [{ oldText: "a", newText: "b\nc" }] }, result: "ok" },
  ],
  ({ components, lines }) => {
    const rows = lines(components[0]);
    check("file tools share one tree", /3 calls/.test(rows[0] ?? ""), rows[0]);
    check(
      "read/write/edit rows are all folded in",
      ["read", "write", "edit"].every((label) => new RegExp(`[├└]─▸ [✓✗] ${label}`).test(rows.join("\n"))),
      rows.join(" | "),
    );
    check(
      "write subject is the file and the size is visible",
      /b\.ts/.test(rows.join("\n")) && /\+3 lines/.test(rows.join("\n")),
      rows.join(" | "),
    );
    check("edit shows the line delta", /\+2 −1/.test(rows.join("\n")), rows.join(" | "));
    check("continuation file rows are hidden", components.slice(1).every((c) => c.render(100).length === 0));
  },
);

// ---- off means Pi's rendering, rows untouched ---------------------------
withScene(
  [
    { toolName: "bash", callId: "off1", args: { command: "pwd" }, result: "/tmp" },
    { toolName: "bash", callId: "off2", args: { command: "date" }, result: "now" },
  ],
  ({ components }) => {
    check(
      "disabled: continuation rows are not hidden",
      components.every((component) => component.render(100).length > 0),
      components.map((component) => component.render(100).length).join(","),
    );
  },
  { ...DEFAULT_TOOL_TREE_CONFIG, enabled: false },
);

// ---- Ctrl+O after the turn collapsed ------------------------------------
withScene(
  [
    { toolName: "bash", callId: "e1", args: { command: "pwd" }, result: "/tmp" },
    { toolName: "bash", callId: "e2", args: { command: "date" }, result: "now" },
  ],
  ({ registry, components, lines }) => {
    const head = components[0];
    registry.endTurn();
    check("turn end collapses the tree", lines(head).length === 1, lines(head).join(" | "));
    head.setExpanded(true);
    const expanded = lines(head);
    check(
      "Ctrl+O after collapse reveals the rows",
      expanded.filter((line) => /[├└]─/.test(line)).length === 2 && /▾/.test(expanded[0]),
      expanded.join(" | "),
    );
    head.setExpanded(false);
    check(
      "Ctrl+O off collapses the nodes again",
      lines(head).filter((line) => /[├└]─/.test(line)).length === 2 && !/command/.test(lines(head).join("\n")),
      lines(head).join(" | "),
    );
  },
);

// ---- claims survive a new turn ------------------------------------------
const claimRegistry = new ToolTreeRegistry({ ...DEFAULT_TOOL_TREE_CONFIG });
claimRegistry.startTurn();
claimRegistry.startAssistantMessage(500);
claimRegistry.noteAssistantMessage(500);
claimRegistry.startNode({ toolCallId: "k1", toolName: "bash", args: { command: "pwd" } });
claimRegistry.claimTurnForThinking();
claimRegistry.startTurn();
check(
  "earlier turns stay claimed (no returning 'Thought for …' line)",
  claimRegistry.claimsMessage(500) === true,
);

// ---- rows created with Pi's renderer are adopted -------------------------
withScene(
  [
    { toolName: "bash", callId: "ad1", args: { command: "pwd" }, result: "/tmp", handled: false },
    { toolName: "bash", callId: "ad2", args: { command: "date" }, result: "now", handled: false },
  ],
  ({ components, lines }) => {
    const first = lines(components[0]);
    check("a handled row built with Pi's renderer joins the tree", /2 calls/.test(first[0] ?? ""), first.join(" | "));
    check("adopted continuation rows are hidden", components[1].render(100).length === 0);
  },
);

// ---- rows the event stream missed still join the tree --------------------
withScene(
  [{ toolName: "bash", callId: "miss1", args: { command: "cd /tmp && pwd" }, result: "/tmp", handled: false, noNode: true }],
  ({ registry, lines, components }) => {
    const rows = lines(components[0]);
    check("a handled row with no node is adopted on first paint", /1 call/.test(rows[0] ?? ""), rows.join(" | "));
    check("the adopted call now has a node", Boolean(registry.node("miss1")));
  },
);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
console.log("OK");
