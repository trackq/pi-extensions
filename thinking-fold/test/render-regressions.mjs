#!/usr/bin/env node
/**
 * Regression harness for the thinking-fold renderer.
 *
 * Renders synthetic DeepSeek tool-call turns through Pi's real
 * AssistantMessageComponent in all three patch orderings that occur in practice:
 *
 *   native         - no other thinking extension installed
 *   foreign-before - another extension patched updateContent before us
 *                    (we are the outer wrapper; we see its panel)
 *   foreign-after  - another extension patched updateContent after us
 *                    (it is the outer wrapper and hides reasoning from us)
 *
 * Run from this package directory:
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
  const versions = readdirSync(releases).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const latest = versions.at(-1);
  if (!latest) throw new Error(`No Pi release found under ${releases}`);
  return { release: latest, root: join(releases, latest, "node_modules", "@earendil-works") };
}

const { release, root: piRoot } = piPackagesRoot();
const work = mkdtempSync(join(tmpdir(), "thinking-fold-test-"));
mkdirSync(join(work, "node_modules", "@earendil-works"), { recursive: true });
for (const pkg of ["pi-ai", "pi-coding-agent", "pi-tui"]) {
  symlinkSync(join(piRoot, pkg), join(work, "node_modules", "@earendil-works", pkg), "dir");
}
const ext = join(work, "ext");
mkdirSync(ext, { recursive: true });
for (const file of ["renderer.ts", "model-behaviors.ts", "model-behaviors.json", "config.ts"]) {
  cpSync(join(extensionRoot, file), join(ext, file));
}

const { AssistantMessageComponent } = await import(`${piRoot}/pi-coding-agent/dist/index.js`);
const themeMod = await import(`${piRoot}/pi-coding-agent/dist/modes/interactive/theme/theme.js`);
if (themeMod.initTheme) themeMod.initTheme("dark");
const { Spacer, Text } = await import(`${piRoot}/pi-tui/dist/index.js`);
const { installThinkingFoldPatch, resolveThinkingBehavior } = await import(`${ext}/renderer.ts`);

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (value) => value.replace(ANSI, "").replace(/\x1b\]133;[A-C]\x07/g, "");
const MARKER = /\uE000|\uE001/;

const thinking = (label, lines = 30) =>
  Array.from({ length: lines }, (_, i) => `${label} step ${i + 1}: considering the workspace`).join("\n");

function assistantMessage(timestamp, content) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-flash",
    content,
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

const base = Date.now();
const turn = [
  assistantMessage(base, [
    { type: "thinking", thinking: thinking("first"), signature: "s" },
    { type: "text", text: "Checking the workspace first." },
    { type: "toolCall", id: "t1", name: "bash", arguments: { command: "pwd" } },
    { type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } },
  ]),
  assistantMessage(base + 5000, [
    { type: "thinking", thinking: thinking("second", 12), signature: "s" },
    { type: "toolCall", id: "t3", name: "bash", arguments: { command: "python3 x.py" } },
  ]),
  assistantMessage(base + 9000, [
    { type: "thinking", thinking: thinking("third", 8), signature: "s" },
    { type: "text", text: "Done." },
  ]),
];

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function fakeForeignPatch({ after }) {
  const proto = AssistantMessageComponent.prototype;
  const install = () => {
    const previous = proto.updateContent;
    proto.updateContent = function (message, isStreaming) {
      this.lastMessage = message;
      // Like pi-thinking-steps: strip thinking for the native renderer, then add
      // an own panel that displays the reasoning.
      previous.call(
        this,
        { ...message, content: message.content.filter((c) => c.type !== "thinking") },
        isStreaming,
      );
      const blocks = message.content.filter((c) => c.type === "thinking" && c.thinking.trim());
      if (!blocks.length) return;
      const panel = new Text(`thinking panel: ${blocks.map((b) => b.thinking).join(" ")}`, 1, 0);
      this.contentContainer.children.unshift(new Spacer(1), panel);
    };
  };
  return { install, after };
}

async function runOrdering(name, { foreignBefore = false, foreignAfter = false } = {}) {
  // A fresh module instance per ordering keeps the prototype clean.
  const suffix = `?case=${name}-${Date.now()}`;
  const renderer = await import(`${ext}/renderer.ts${suffix}`);

  let foreignBeforeInstall;
  if (foreignBefore) {
    fakeForeignPatch({ after: false }).install();
    foreignBeforeInstall = true;
  }

  const patch = renderer.installThinkingFoldPatch({
    streamingBehavior: "auto",
    completedBehavior: "auto",
    previewLines: 4,
    toggleKey: "ctrl+t",
  });

  if (foreignAfter) fakeForeignPatch({ after: true }).install();
  void foreignBeforeInstall;

  console.log(`\n== ${name} (pi ${release}) ==`);

  const components = turn.map((message, index) => {
    patch.beginMessage(message, message.timestamp);
    patch.trackMessage(message);
    const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, []);
    void index;
    return component;
  });

  turn.forEach((message, index) => {
    const behavior = renderer.resolveThinkingBehavior(message, "auto");
    check(`${name}: deepseek resolves to trace`, behavior === "trace", `got ${behavior}`);

    const streaming = strip(components[index].render(100).join("\n"));
    const streamLines = streaming.split("\n").filter((line) => line.trim());
    check(
      `${name}: msg${index + 1} streaming header`,
      /Thinking \d+\.\d+s/.test(streaming),
      streaming.slice(0, 80).replace(/\n/g, " | "),
    );
    check(
      `${name}: msg${index + 1} streaming stays short`,
      streamLines.length <= 4 + 3,
      `${streamLines.length} non-empty rows`,
    );
    check(`${name}: msg${index + 1} no markers leaked`, !MARKER.test(streaming));
    check(
      `${name}: msg${index + 1} no foreign panel`,
      !/thinking panel:/i.test(streaming) && !/Thinking Steps/.test(streaming),
    );

    patch.completeMessage(message, message.timestamp + 3200);
    const completed = strip(components[index].render(100).join("\n"));
    const completedLabels = (completed.match(/Thought for \d+\.\d+s/g) ?? []).length;
    check(`${name}: msg${index + 1} completed label once`, completedLabels === 1, `${completedLabels} labels`);
    check(
      `${name}: msg${index + 1} completed hides reasoning`,
      !/step 25: considering/.test(completed),
      completed.slice(0, 100).replace(/\n/g, " | "),
    );

    patch.setExpanded(true);
    const expanded = strip(components[index].render(100).join("\n"));
    check(
      `${name}: msg${index + 1} expanded shows reasoning`,
      /step 1: considering/.test(expanded) && !MARKER.test(expanded),
    );
    patch.setExpanded(false);
  });

  patch.dispose();
}

await runOrdering("native");
await runOrdering("foreign-before", { foreignBefore: true });
await runOrdering("foreign-after", { foreignAfter: true });

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log("FAILURES:");
  for (const failure of failed) console.log(`- ${failure.name}: ${failure.detail}`);
  process.exit(1);
}
console.log("OK");
