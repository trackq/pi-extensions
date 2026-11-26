import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_THINKING_FOLD_OPTIONS,
  type ThinkingCompletedBehavior,
  type ThinkingFoldOptions,
  type ThinkingStreamingBehavior,
} from "./renderer.ts";

export interface ThinkingFoldConfig {
  foldThreshold: number;
  streamingBehavior: ThinkingStreamingBehavior;
  completedBehavior: ThinkingCompletedBehavior;
}

export const DEFAULT_THINKING_FOLD_CONFIG: ThinkingFoldConfig = {
  foldThreshold: DEFAULT_THINKING_FOLD_OPTIONS.previewLines,
  streamingBehavior: DEFAULT_THINKING_FOLD_OPTIONS.streamingBehavior,
  completedBehavior: DEFAULT_THINKING_FOLD_OPTIONS.completedBehavior,
};

export const THINKING_FOLD_SETTINGS_NAMESPACE = "thinking-fold";

/**
 * Pi's agent directory. Honours PI_CONFIG_DIR like Pi itself does, so the
 * settings file lives next to Pi's own configuration.
 */
export function getAgentDir(): string {
  const configured = process.env.PI_CONFIG_DIR?.trim();
  return configured ? configured : join(homedir(), ".pi", "agent");
}

/**
 * Same file and namespace layout as `@99percentpeople/pi-shared-settings`, so
 * settings survive a swap between the upstream package and this fork.
 */
export function getThinkingFoldConfigPath(): string {
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

function isFoldThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 20;
}

function isStreamingBehavior(value: unknown): value is ThinkingStreamingBehavior {
  return value === "auto" || value === "preview" || value === "collapse";
}

function isCompletedBehavior(value: unknown): value is ThinkingCompletedBehavior {
  return value === "auto" || value === "collapse" || value === "preview" || value === "full";
}

export function normalizeThinkingFoldConfig(value: unknown): ThinkingFoldConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_THINKING_FOLD_CONFIG };
  const input = value as {
    foldThreshold?: unknown;
    previewLines?: unknown;
    streamingBehavior?: unknown;
    completedBehavior?: unknown;
    autoCollapse?: unknown;
  };

  return {
    // previewLines and autoCollapse are legacy upstream settings. Preserve
    // their visible behavior when migrating an existing configuration.
    foldThreshold: isFoldThreshold(input.foldThreshold)
      ? input.foldThreshold
      : isFoldThreshold(input.previewLines)
        ? input.previewLines
        : DEFAULT_THINKING_FOLD_CONFIG.foldThreshold,
    streamingBehavior: isStreamingBehavior(input.streamingBehavior)
      ? input.streamingBehavior
      : DEFAULT_THINKING_FOLD_CONFIG.streamingBehavior,
    completedBehavior: isCompletedBehavior(input.completedBehavior)
      ? input.completedBehavior
      : input.autoCollapse === false
        ? "preview"
        : input.autoCollapse === true
          ? "collapse"
          : DEFAULT_THINKING_FOLD_CONFIG.completedBehavior,
  };
}

export function loadThinkingFoldConfig(path = getThinkingFoldConfigPath()): ThinkingFoldConfig {
  return normalizeThinkingFoldConfig(readSettingsFile(path)[THINKING_FOLD_SETTINGS_NAMESPACE]);
}

export function saveThinkingFoldConfig(
  config: ThinkingFoldConfig,
  path = getThinkingFoldConfigPath(),
): void {
  const settings = readSettingsFile(path);
  settings[THINKING_FOLD_SETTINGS_NAMESPACE] = normalizeThinkingFoldConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

export function configToRenderOptions(
  config: ThinkingFoldConfig,
): Pick<ThinkingFoldOptions, "previewLines" | "streamingBehavior" | "completedBehavior"> {
  return {
    previewLines: config.foldThreshold,
    streamingBehavior: config.streamingBehavior,
    completedBehavior: config.completedBehavior,
  };
}
