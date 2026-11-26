import type { Component } from "@earendil-works/pi-tui";
import type { ToolTreeConfig } from "./config.ts";
import type { ToolGroup, ToolNode, ToolTreeRegistry } from "./registry.ts";
import { expandedDetailRows, summarizeToolCall, type ToolSummary } from "./summaries.ts";

/** Minimal theme surface used here (Pi's theme object satisfies it). */
export interface NodeTheme {
  fg(token: string, text: string): string;
}

const TOOL_LABELS: Record<string, string> = {
  ctx_search: "search",
  ctx_execute: "run",
  ctx_execute_file: "file",
  ctx_batch: "batch",
  ctx_batch_execute: "batch",
  ctx_fetch_and_index: "fetch",
  ctx_index: "index",
  ctx_resume: "resume",
  ctx_doctor: "doctor",
  ctx_upgrade: "upgrade",
  bash: "bash",
  powershell: "ps",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  find: "find",
  ls: "ls",
  web_search: "web",
  fetch_content: "fetch",
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LABEL_WIDTH = 7;
const DETAIL_LABEL_WIDTH = 10;

export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName.replace(/^mcp__/, "").replace(/^ctx_/, "");
}

function charWidth(value: string): number {
  return Array.from(value).length;
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…` : chars.join("");
}

function pad(value: string, width: number): string {
  const length = charWidth(value);
  return length >= width ? value : `${value}${" ".repeat(width - length)}`;
}

/** Greedy word wrap; keeps the terminal height predictable for long output. */
export function wrapText(text: string, width: number): string[] {
  const limit = Math.max(8, width);
  const rows: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.trim() === "") {
      rows.push("");
      continue;
    }
    let current = "";
    for (const word of rawLine.split(/\s+/)) {
      if (current === "") {
        current = word;
        continue;
      }
      if (charWidth(`${current} ${word}`) <= limit) current = `${current} ${word}`;
      else {
        rows.push(current);
        current = word;
      }
    }
    if (current !== "") rows.push(current);
  }
  return rows;
}

function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function thinkingDetailRows(
  text: string,
  previewLines: number,
  full: boolean,
): { label: string; value: string }[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const all = trimmed.split("\n");
  const limit = full ? all.length : Math.min(previewLines, all.length);
  const remaining = all.length - limit;
  const preview = all.slice(0, limit).join("\n");
  return [
    {
      label: "reasoning",
      value: remaining > 0 ? `${preview}\n… ${remaining} more line${remaining === 1 ? "" : "s"}` : preview,
    },
  ];
}

export interface TreeComponentDeps {
  registry: ToolTreeRegistry;
  group: ToolGroup;
  config: ToolTreeConfig;
  theme: NodeTheme;
  /** Pi's per-row expanded flag (Ctrl+O). */
  piExpanded: boolean;
  /** Re-render this tool row through Pi's own invalidation path. */
  invalidate: () => void;
  now: () => number;
}

interface RowInfo {
  kind: "header" | "node" | "child";
  node?: ToolNode;
}

const CONNECTORS = {
  unicode: {
    branch: "├─",
    last: "└─",
    pipe: "│ ",
    space: "  ",
    headerOpen: "▾",
    headerClosed: "▸",
  },
  ascii: {
    branch: "|-",
    last: "`-",
    pipe: "| ",
    space: "  ",
    headerOpen: "v",
    headerClosed: ">",
  },
} as const;

/**
 * Renders a whole tool group as one tree block: header, one line per call, and
 * the expanded detail rows of the open nodes.
 *
 * Only the group's first tool row renders this component; Pi patches the other
 * rows of the group to render nothing, so the tree is a single contiguous block
 * instead of one bucket per call.
 */
export class TreeComponent implements Component {
  private rows: RowInfo[] = [];
  private cachedKey?: string;
  private cachedLines?: string[];

  constructor(private readonly deps: TreeComponentDeps) {}

  private isExpanded(node: ToolNode): boolean {
    return node.expanded || this.deps.group.expandedAll || this.deps.piExpanded;
  }

  private isFullDetail(node: ToolNode): boolean {
    return Boolean(node.fullDetail) || this.deps.piExpanded;
  }

  render(width: number): string[] {
    const { registry, group, config, theme } = this.deps;
    const totals = registry.groupSummary(group);
    const key = [
      width,
      registry.revision,
      group.expandedAll ? "g" : "",
      this.deps.piExpanded ? "p" : "",
      Math.floor(this.deps.now() / 120),
      config.groupHeader ? "h" : "",
      group.collapsed ? "c" : "",
      config.treeStyle,
      config.previewLines,
    ].join("|");
    if (this.cachedKey === key && this.cachedLines) return this.cachedLines;

    const connectors = CONNECTORS[config.treeStyle];
    const lines: string[] = [];
    const rows: RowInfo[] = [];

    if (config.groupHeader) {
      const anyOpen = registry.anyNodeExpanded(group);
      const chevron = anyOpen ? connectors.headerOpen : connectors.headerClosed;
      const duration = formatDuration(totals.durationMs);
      const thoughts = totals.thoughts;
      const parts = [
        `tools · ${totals.calls} call${totals.calls === 1 ? "" : "s"}`,
        thoughts > 0 ? `${thoughts} thought${thoughts === 1 ? "" : "s"}` : undefined,
        duration,
        totals.failed > 0 ? `${totals.failed} failed` : undefined,
        totals.running > 0 ? `${totals.running} running` : undefined,
      ].filter(Boolean) as string[];
      lines.push(`${theme.fg("muted", chevron)} ${theme.fg("muted", parts.join(" · "))}`);
      rows.push({ kind: "header" });
    }

    const renderNode = (node: ToolNode, depth: number, isLast: boolean) => {
      const prefix = depth === 0 ? "" : `${connectors.pipe.repeat(depth)}`;
      const connector = isLast ? connectors.last : connectors.branch;
      const isThinking = node.kind === "thinking";
      const summary: ToolSummary = isThinking
        ? {
            subject: "",
            meta: node.thinkingText
              ? `${node.thinkingText.trim().split("\n").length} line${
                  node.thinkingText.trim().split("\n").length === 1 ? "" : "s"
                }`
              : undefined,
            details: [],
            output: undefined,
          }
        : summarizeToolCall({
            toolName: node.toolName,
            args: node.args,
            resultText: node.resultText,
            isError: node.isError,
            durationMs: node.durationMs,
            isPartial: node.status === "running",
          });
      const expanded = this.isExpanded(node);
      const statusGlyph =
        node.status === "running"
          ? SPINNER[Math.floor(this.deps.now() / 120) % SPINNER.length]
          : node.status === "error"
            ? "✗"
            : "✓";
      const statusColor =
        node.status === "error" ? "error" : node.status === "running" ? "muted" : "success";
      const metaParts = [summary.meta, formatDuration(node.durationMs)].filter(Boolean);
      const meta = metaParts.join(" · ");
      const label = pad(isThinking ? "thought" : toolLabel(node.toolName), LABEL_WIDTH);
      const headWidth = charWidth(prefix) + charWidth(connector) + 4 + LABEL_WIDTH + 1;
      const available = Math.max(12, width - headWidth - charWidth(meta) - 2);
      const subject = truncate(summary.subject, available);
      const leftWidth = headWidth + charWidth(subject);
      const gap = meta ? Math.max(1, width - leftWidth - charWidth(meta)) : 0;

      lines.push(
        `${theme.fg("borderMuted", `${prefix}${connector}`)}` +
          `${theme.fg("muted", expanded ? connectors.headerOpen : connectors.headerClosed)} ` +
          `${theme.fg(statusColor, statusGlyph)} ` +
          `${theme.fg("accent", label)} ` +
          `${theme.fg("text", subject)}` +
          `${" ".repeat(gap)}` +
          `${theme.fg("muted", meta)}`,
      );
      rows.push({ kind: "node", node });

      if (expanded) {
        const childPrefix = `${prefix}${isLast ? connectors.space : connectors.pipe}  `;
        const detailRows = isThinking
          ? thinkingDetailRows(node.thinkingText ?? "", config.previewLines, this.isFullDetail(node))
          : expandedDetailRows(summary, {
              previewLines: config.previewLines,
              expanded: this.isFullDetail(node),
            });
        const detailWidth = Math.max(10, width - charWidth(childPrefix) - DETAIL_LABEL_WIDTH - 1);
        for (const row of detailRows) {
          const valueLines = wrapText(row.value, detailWidth);
          valueLines.forEach((valueLine, index) => {
            const labelText = index === 0 ? pad(row.label, DETAIL_LABEL_WIDTH) : " ".repeat(DETAIL_LABEL_WIDTH);
            lines.push(
              `${theme.fg("borderMuted", childPrefix)}${theme.fg("muted", labelText)}` +
                `${theme.fg("toolOutput" as string, valueLine)}`,
            );
            rows.push({ kind: "child", node });
          });
        }
        if (detailRows.length === 0) {
          lines.push(`${theme.fg("borderMuted", childPrefix)}${theme.fg("muted", "(no output)")}`);
          rows.push({ kind: "child", node });
        }
      }

      node.children.forEach((child, index) => {
        renderNode(child, depth + 1, index === node.children.length - 1);
      });
    };

    if (!group.collapsed) {
      // Only the calls this tree owns get a row here; tools that keep Pi's own
      // renderer stay in the transcript as their own rows.
      const visible = registry.treeNodes(group);
      visible.forEach((node, index) => {
        renderNode(node, 0, index === visible.length - 1);
      });
    }

    this.cachedKey = key;
    this.cachedLines = lines;
    this.rows = rows;
    return lines;
  }

  invalidate(): void {
    this.cachedKey = undefined;
    this.cachedLines = undefined;
  }

  handleMouse(event: {
    type: string;
    button: string;
    y: number;
    clickCount?: number;
  }): { handled: true; render: true } | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    const row = this.rows[event.y];
    if (!row) return undefined;
    const { registry, group } = this.deps;
    let handled = false;
    if (row.kind === "header") {
      if (!registry.expandCollapsed(group)) registry.toggleGroup(group);
      handled = true;
    } else if (row.kind === "node" && row.node) {
      if ((event.clickCount ?? 1) >= 2) registry.expandNodeFully(row.node);
      else registry.toggleNode(row.node);
      handled = true;
    }
    if (handled) {
      // Pi's own invalidation repaints this row; the widget bridge is only a
      // fallback for redraws that no single row owns.
      try {
        this.deps.invalidate();
      } catch {
        // Repainting is best-effort; the state change is already applied.
      }
      // `render: true` asks Pi to repaint even though the click is handled, so a
      // click expands the node immediately in fullscreen mode.
      return { handled: true, render: true };
    }
    return undefined;
  }
}

/** Placeholder for Pi's separate "result" render slot; the tree renders everything. */
export class EmptyComponent implements Component {
  render(): string[] {
    return [];
  }
  invalidate(): void {}
}

export { type ToolSummary };
