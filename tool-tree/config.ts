import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ToolTreeScope = "turn" | "assistant-message";
export type ToolTreeStyle = "unicode" | "ascii";
export type ToolTreeHandledTools = "auto" | "all";

export interface ToolTreeConfig {
  enabled: boolean;
  scope: ToolTreeScope;
  groupHeader: boolean;
  previewLines: number;
  treeStyle: ToolTreeStyle;
  handledTools: ToolTreeHandledTools;
  /** Collapse the whole tree to one summary line when the turn ends. */
  collapseAfterTurn: boolean;
  /** Extra tool names to handle in `auto` mode. */
  extraTools: string[];
}

export const DEFAULT_TOOL_TREE_CONFIG: ToolTreeConfig = {
  enabled: true,
  scope: "turn",
  groupHeader: true,
  previewLines: 6,
  treeStyle: "unicode",
  handledTools: "auto",
  collapseAfterTurn: true,
  extraTools: [],
};

export const TOOL_TREE_SETTINGS_NAMESPACE = "tool-tree";

export function getAgentDir(): string {
  const configured = process.env.PI_CONFIG_DIR?.trim();
  return configured ? configured : join(homedir(), ".pi", "agent");
}

export function getToolTreeConfigPath(): string {
  return join(getAgentDir(), "99extensions.json");
}

function readSettingsFile(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

export function normalizeToolTreeConfig(value: unknown): ToolTreeConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_TOOL_TREE_CONFIG };
  const input = value as Partial<Record<keyof ToolTreeConfig, unknown>>;
  const previewLines = Number(input.previewLines);
  const extraTools = Array.isArray(input.extraTools)
    ? input.extraTools.filter((name): name is string => typeof name === "string" && name.trim() !== "")
    : DEFAULT_TOOL_TREE_CONFIG.extraTools;

  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_TOOL_TREE_CONFIG.enabled,
    scope:
      input.scope === "turn" || input.scope === "assistant-message"
        ? input.scope
        : DEFAULT_TOOL_TREE_CONFIG.scope,
    groupHeader:
      typeof input.groupHeader === "boolean" ? input.groupHeader : DEFAULT_TOOL_TREE_CONFIG.groupHeader,
    previewLines:
      Number.isInteger(previewLines) && previewLines >= 1 && previewLines <= 40
        ? previewLines
        : DEFAULT_TOOL_TREE_CONFIG.previewLines,
    treeStyle:
      input.treeStyle === "unicode" || input.treeStyle === "ascii"
        ? input.treeStyle
        : DEFAULT_TOOL_TREE_CONFIG.treeStyle,
    handledTools:
      input.handledTools === "auto" || input.handledTools === "all"
        ? input.handledTools
        : DEFAULT_TOOL_TREE_CONFIG.handledTools,
    collapseAfterTurn:
      typeof input.collapseAfterTurn === "boolean"
        ? input.collapseAfterTurn
        : DEFAULT_TOOL_TREE_CONFIG.collapseAfterTurn,
    extraTools,
  };
}

export function loadToolTreeConfig(path = getToolTreeConfigPath()): ToolTreeConfig {
  return normalizeToolTreeConfig(readSettingsFile(path)[TOOL_TREE_SETTINGS_NAMESPACE]);
}

export function saveToolTreeConfig(config: ToolTreeConfig, path = getToolTreeConfigPath()): void {
  const settings = readSettingsFile(path);
  settings[TOOL_TREE_SETTINGS_NAMESPACE] = normalizeToolTreeConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

const AUTO_TOOL_PREFIXES = ["ctx_", "mcp__"];
const AUTO_TOOL_NAMES = ["bash", "web_search", "fetch_content"];

/** Which tool calls this package draws itself. Everything else keeps Pi's renderer. */
export function shouldHandleTool(toolName: string, config: ToolTreeConfig): boolean {
  if (!config.enabled) return false;
  if (config.extraTools.includes(toolName)) return true;
  if (config.handledTools === "all") return true;
  if (AUTO_TOOL_NAMES.includes(toolName)) return true;
  return AUTO_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}
