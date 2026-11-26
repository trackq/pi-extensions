import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getToolTreeConfigPath,
  loadToolTreeConfig,
  saveToolTreeConfig,
  shouldHandleTool,
  DEFAULT_TOOL_TREE_CONFIG,
  type ToolTreeConfig,
} from "./config.ts";
import { TreeComponent, EmptyComponent } from "./node-component.ts";
import { installToolTreePatch, type ToolTreePatchHandle } from "./patch.ts";
import {
  installAssistantThinkingPatch,
  rerenderAssistantMessages,
  type AssistantPatchHandle,
} from "./assistant-patch.ts";
import { ToolTreeRegistry } from "./registry.ts";

const RENDER_BRIDGE_WIDGET = "tool-tree-render-bridge";
const SPINNER_INTERVAL_MS = 200;

function configSummary(config: ToolTreeConfig): string {
  return [
    config.enabled ? "on" : "off",
    `scope: ${config.scope}`,
    `header: ${config.groupHeader ? "on" : "off"}`,
    `preview: ${config.previewLines} lines`,
    `style: ${config.treeStyle}`,
    `tools: ${config.handledTools}${config.extraTools.length > 0 ? ` + ${config.extraTools.join(", ")}` : ""}`,
  ].join(" · ");
}

/** Footer one-liner: always visible, unlike a transient toast. */
function footerStatus(config: ToolTreeConfig, nodes: number): string {
  return `tool-tree ${config.enabled ? "on" : "off"} · ${config.scope} · preview ${config.previewLines} · ${nodes} call${nodes === 1 ? "" : "s"}`;
}

export default function (pi: ExtensionAPI) {
  let config = loadToolTreeConfig();
  const registry = new ToolTreeRegistry(config);
  let requestRedraw: (() => void) | undefined;
  let patch: ToolTreePatchHandle | undefined;
  let assistantPatch: AssistantPatchHandle | undefined;
  let patchError: string | undefined;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let lastFooterCount = -1;

  const redraw = () => requestRedraw?.();

  registry.onTreeChange(redraw);

  pi.registerToolRenderer((toolName, next) => {
    if (!shouldHandleTool(toolName, config)) return next();
    return {
      renderShell: "self",
      renderCall: (args, theme, ctx) => {
        const node =
          registry.node(ctx.toolCallId) ??
          registry.startNode({ toolCallId: ctx.toolCallId, toolName, args });
        node.args = args ?? node.args;
        const group = registry.groupFor(node);
        if (!group) return new EmptyComponent();
        // Every row of a group returns the same tree view; Pi hides all but the
        // group's first row, so the block renders exactly once.
        return new TreeComponent({
          registry,
          group,
          config,
          theme,
          piExpanded: ctx.expanded,
          invalidate: ctx.invalidate,
          now: () => Date.now(),
        });
      },
      // The node renders its own output; Pi's second slot stays empty.
      renderResult: () => new EmptyComponent(),
    };
  });

  const applyConfig = (next: ToolTreeConfig, ctx: ExtensionContext) => {
    config = next;
    registry.setConfig(next);
    try {
      saveToolTreeConfig(config);
    } catch (error) {
      ctx.ui.notify(
        `Failed to save tool-tree settings: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
    // Turning the tree off must restore Pi's (or thinking-fold's) own rendering.
    rerenderAssistantMessages();
    redraw();
  };

  pi.registerCommand("tool-tree", {
    description: "Collapse tool calls into a drill-down tree (status, expand, collapse, scope)",
    getArgumentCompletions: (prefix) => {
      const options = [
        "status",
        "expand",
        "collapse",
        "toggle",
        "on",
        "off",
        "scope turn",
        "scope assistant-message",
        "header on",
        "header off",
        "style unicode",
        "style ascii",
        "open",
        "close",
        "full",
        ...["2", "4", "6", "8", "10", "15"].map((value) => `lines ${value}`),
        "handled auto",
        "handled all",
        "collapse-after on",
        "collapse-after off",
      ];
      const trimmed = prefix.trim().toLowerCase();
      return options
        .filter((option) => option.startsWith(trimmed))
        .map((option) => ({ value: option, label: option }));
    },
    handler: async (args, ctx) => {
      const [verb, value] = args.trim().toLowerCase().split(/\s+/, 2);
      const notifyConfig = () =>
        ctx.ui.notify(`Tool tree · ${configSummary(config)}\\n${getToolTreeConfigPath()}`, "info");

      if (!verb || verb === "status") {
        const nodes = registry.allNodes();
        const text = footerStatus(config, nodes.length);
        ctx.ui.setStatus("tool-tree", text);
        const listing =
          nodes.length === 0
            ? "no tool calls yet"
            : nodes
                .slice(-6)
                .map(
                  (node, index) =>
                    `${nodes.length - Math.min(nodes.length, 6) + index + 1}.${node.toolName}`,
                )
                .join(" ");
        ctx.ui.notify(`${text} — ${listing} — /tool-tree for help`, "info");
        return;
      }
      if (verb === "on" || verb === "off") {
        applyConfig({ ...config, enabled: verb === "on" }, ctx);
        notifyConfig();
        return;
      }
      if (verb === "scope" && (value === "turn" || value === "assistant-message")) {
        applyConfig({ ...config, scope: value }, ctx);
        notifyConfig();
        return;
      }
      if (verb === "header" && (value === "on" || value === "off")) {
        applyConfig({ ...config, groupHeader: value === "on" }, ctx);
        notifyConfig();
        return;
      }
      if (verb === "style" && (value === "unicode" || value === "ascii")) {
        applyConfig({ ...config, treeStyle: value }, ctx);
        notifyConfig();
        return;
      }
      if (verb === "lines") {
        const lines = Number(value);
        if (!Number.isInteger(lines) || lines < 1 || lines > 40) {
          ctx.ui.notify("tool-tree: lines must be an integer from 1 to 40", "warning");
          return;
        }
        applyConfig({ ...config, previewLines: lines }, ctx);
        notifyConfig();
        return;
      }
      if (verb === "collapse-after" && (value === "on" || value === "off")) {
        applyConfig({ ...config, collapseAfterTurn: value === "on" }, ctx);
        notifyConfig();
        return;
      }
      if (verb === "handled" && (value === "auto" || value === "all")) {
        applyConfig({ ...config, handledTools: value }, ctx);
        notifyConfig();
        return;
      }
      if (verb === "open" || verb === "close" || verb === "full") {
        const nodes = registry.allNodes();
        const index = Number(value);
        if (!Number.isInteger(index) || index < 1 || index > nodes.length) {
          ctx.ui.notify(
            `tool-tree: ${verb} needs a node number 1-${nodes.length} (see /tool-tree status)`,
            "warning",
          );
          return;
        }
        const node = nodes[index - 1]!;
        const group = registry.groupFor(node);
        if (group) registry.expandCollapsed(group);
        if (verb === "open") {
          node.expanded = true;
        } else if (verb === "close") {
          node.expanded = false;
          node.fullDetail = false;
        } else {
          node.expanded = true;
          node.fullDetail = true;
        }
        registry.touch();
        redraw();
        ctx.ui.notify(
          `#${index} ${node.toolName} · ${verb === "close" ? "collapsed" : verb === "full" ? "full output" : "expanded"}`,
          "info",
        );
        return;
      }
      if (verb === "expand" || verb === "collapse" || verb === "toggle") {
        const groups = registry.allGroups();
        for (const group of groups) {
          if (verb === "expand") {
            registry.expandCollapsed(group);
            registry.setGroupExpandedAll(group, true);
          } else if (verb === "collapse") {
            registry.setGroupExpandedAll(group, false);
            registry.collapseGroup(group);
          } else if (group.collapsed) {
            registry.expandCollapsed(group);
          } else {
            registry.setGroupExpandedAll(group, !group.expandedAll);
          }
        }
        redraw();
        ctx.ui.notify(`Tool tree: ${verb === "toggle" ? "toggled" : verb === "expand" ? "expanded" : "collapsed"} ${groups.length} group(s)`, "info");
        return;
      }
      ctx.ui.notify(
        "Usage: /tool-tree [status|on|off|expand|collapse|toggle|scope turn|assistant-message|header on|off|style unicode|ascii|lines <1-40>|handled auto|all]",
        "warning",
      );
    },
  });

  const startSpinner = () => {
    if (spinnerTimer) return;
    spinnerTimer = setInterval(() => {
      if (!registry.hasRunning()) {
        if (spinnerTimer) clearInterval(spinnerTimer);
        spinnerTimer = undefined;
      }
      redraw();
    }, SPINNER_INTERVAL_MS);
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    try {
      patch = installToolTreePatch(registry);
      assistantPatch = installAssistantThinkingPatch(registry);
    } catch (error) {
      patchError = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`tool-tree disabled: ${patchError}`, "warning");
    }

    registry.restoreFromEntries(ctx.sessionManager.getEntries());
    // Persistent footer feedback so the current mode is always visible.
    ctx.ui.setStatus("tool-tree", footerStatus(config, registry.allNodes().length));

    // Zero-row widget: captures Pi's live TUI so the tree can request a redraw
    // after a click without replacing any visible UI.
    ctx.ui.setWidget(
      RENDER_BRIDGE_WIDGET,
      (tui) => {
        requestRedraw = () => tui.requestRender();
        return {
          render: () => [],
          invalidate() {},
          dispose() {
            requestRedraw = undefined;
          },
        };
      },
      { placement: "belowEditor" },
    );
    redraw();
  });

  pi.on("message_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (event.message.role === "user") {
      registry.startTurn();
      return;
    }
    if (event.message.role === "assistant") {
      registry.startAssistantMessage(event.message.timestamp);
      registry.noteAssistantMessage(event.message.timestamp);
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    registry.endThinking(event.message.timestamp);
    redraw();
  });

  pi.on("message_update", (event, ctx) => {
    if (ctx.mode !== "tui" || event.message.role !== "assistant") return;
    const reasoning = event.message.content
      .filter((block) => block.type === "thinking")
      .map((block) => (block.type === "thinking" ? block.thinking : ""))
      .join("\n\n");
    if (!reasoning.trim()) return;
    // Reasoning joins the same tree as this turn's tool calls.
    registry.upsertThinking(event.message.timestamp, reasoning);
    redraw();
  });

  pi.on("tool_execution_start", (event) => {
    if (shouldHandleTool(event.toolName, config)) {
      registry.claimTurnForThinking();
      rerenderAssistantMessages();
    }
    registry.startNode({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      parentToolCallId: event.parentToolCallId,
    });
    startSpinner();
    redraw();
  });

  pi.on("tool_execution_update", (event) => {
    registry.updateNode(event.toolCallId, event.partialResult);
  });

  pi.on("tool_execution_end", (event) => {
    registry.endNode({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
      durationMs: event.durationMs,
    });
    redraw();
  });

  pi.on("turn_end", (_event, ctx) => {
    registry.endTurn();
    redraw();
    // Keep the footer count in step with the session without repainting per event.
    const count = registry.allNodes().length;
    if (ctx.mode !== "tui" || count === lastFooterCount) return;
    lastFooterCount = count;
    ctx.ui.setStatus("tool-tree", footerStatus(config, count));
  });



  pi.on("agent_end", () => {
    registry.endTurn();
    redraw();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (spinnerTimer) clearInterval(spinnerTimer);
    spinnerTimer = undefined;
    patch?.dispose();
    patch = undefined;
    assistantPatch?.dispose();
    assistantPatch = undefined;
    if (ctx.hasUI) {
      ctx.ui.setWidget(RENDER_BRIDGE_WIDGET, undefined);
      ctx.ui.setStatus("tool-tree", undefined);
    }
    requestRedraw = undefined;
  });
}

export {
  DEFAULT_TOOL_TREE_CONFIG,
  getToolTreeConfigPath,
  loadToolTreeConfig,
  normalizeToolTreeConfig,
  saveToolTreeConfig,
  shouldHandleTool,
  type ToolTreeConfig,
  type ToolTreeHandledTools,
  type ToolTreeScope,
  type ToolTreeStyle,
} from "./config.ts";
export { ToolTreeRegistry, type ToolGroup, type ToolNode, type ToolNodeStatus } from "./registry.ts";
export { summarizeToolCall, expandedDetailRows, type SummaryInput, type ToolSummary } from "./summaries.ts";
export { EmptyComponent, TreeComponent, toolLabel, wrapText, type NodeTheme } from "./node-component.ts";
export { installToolTreePatch, type ToolTreePatchHandle } from "./patch.ts";
export {
  installAssistantThinkingPatch,
  THINKING_CLAIMS_SYMBOL,
  type AssistantPatchHandle,
} from "./assistant-patch.ts";
