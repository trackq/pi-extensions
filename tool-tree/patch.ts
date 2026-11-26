import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ToolTreeRegistry } from "./registry.ts";

export interface ToolTreePatchHandle {
  dispose(): void;
}

interface PatchRecord {
  owners: number;
  originalRender: (this: ToolExecutionComponent, width: number) => string[];
  originalSetExpanded: (this: ToolExecutionComponent, expanded: boolean) => void;
  registry: ToolTreeRegistry;
  hadOwnSetExpanded: boolean;
}

const PATCH_SYMBOL = Symbol.for("pi-tool-tree/tool-execution-patch");

function getPrototype(): Record<PropertyKey, unknown> {
  return ToolExecutionComponent.prototype as unknown as Record<PropertyKey, unknown>;
}

/**
 * Two cosmetic/behavioural hooks on Pi's per-call tool component:
 *
 * - drop the leading blank line of continuation rows so a tree has no gaps
 *   (self-shell rendering starts every row with one),
 * - forward Ctrl+O (`setExpanded`) to the whole tree group.
 *
 * Both are guarded: when the shape is unexpected the row renders natively.
 */
export function installToolTreePatch(registry: ToolTreeRegistry): ToolTreePatchHandle {
  const prototype = getPrototype();
  const existing = prototype[PATCH_SYMBOL] as PatchRecord | undefined;
  if (existing) {
    existing.owners += 1;
    existing.registry = registry;
    return {
      dispose() {
        existing.owners -= 1;
        if (existing.owners > 0) return;
        restore(prototype, existing);
      },
    };
  }

  const originalRender = ToolExecutionComponent.prototype.render;
  const originalSetExpanded = ToolExecutionComponent.prototype.setExpanded;
  if (typeof originalRender !== "function" || typeof originalSetExpanded !== "function") {
    throw new Error("ToolExecutionComponent render/setExpanded API is unavailable");
  }

  const record: PatchRecord = {
    owners: 1,
    originalRender,
    originalSetExpanded,
    registry,
    hadOwnSetExpanded: Object.prototype.hasOwnProperty.call(
      ToolExecutionComponent.prototype,
      "setExpanded",
    ),
  };

  ToolExecutionComponent.prototype.render = function (width: number): string[] {
    const lines = record.originalRender.call(this, width);
    try {
      if (!Array.isArray(lines) || lines.length === 0) return lines;
      const node = record.registry.node(this.toolCallId);
      if (!node) return lines;
      // Only the group's first row renders the tree; the remaining rows of the
      // group draw nothing so the whole block stays contiguous.
      if (!record.registry.isGroupHead(node)) return [];
      return lines;
    } catch {
      return lines;
    }
  };

  ToolExecutionComponent.prototype.setExpanded = function (expanded: boolean): void {
    record.originalSetExpanded.call(this, expanded);
    try {
      record.registry.notifyPiExpanded(this.toolCallId, expanded);
    } catch {
      // A stale call id must not break Ctrl+O.
    }
  };

  prototype[PATCH_SYMBOL] = record;

  return {
    dispose() {
      record.owners -= 1;
      if (record.owners > 0) return;
      restore(prototype, record);
    },
  };
}

function restore(prototype: Record<PropertyKey, unknown>, record: PatchRecord): void {
  prototype.render = record.originalRender;
  if (record.hadOwnSetExpanded) prototype.setExpanded = record.originalSetExpanded;
  else delete prototype.setExpanded;
  delete prototype[PATCH_SYMBOL];
}
