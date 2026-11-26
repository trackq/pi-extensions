import {
  ToolExecutionComponent,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { ToolTreeRegistry } from "./registry.ts";

export interface ToolTreePatchHandle {
  dispose(): void;
}

type RenderersFor = (toolName: string) => ToolRenderers | undefined;

/**
 * The fields this patch touches. Pi keeps them `private` in its .d.ts, but they
 * are plain instance fields at runtime; everything is guarded so an upstream
 * rename degrades to native rendering instead of crashing.
 */
interface RowInternals {
  toolName: string;
  toolCallId: string;
  args: unknown;
  toolDefinition?: { renderShell?: string; [key: string]: unknown };
  contentBox?: unknown;
  contentTextRegion?: unknown;
  selfRenderContainer?: unknown;
  children: unknown[];
  removeChild(component: never): void;
  addChild(component: never): void;
  updateDisplay(): void;
}

interface PatchRecord {
  owners: number;
  originalRender: (this: ToolExecutionComponent, width: number) => string[];
  originalSetExpanded: (this: ToolExecutionComponent, expanded: boolean) => void;
  registry: ToolTreeRegistry;
  renderersFor?: RenderersFor;
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
 * - forward Ctrl+O (`setExpanded`) to the whole tree group,
 * - adopt rows Pi built before this package could render them (created while
 *   the tree was off, or with Pi's own renderer) so a handled call can never
 *   stay outside the tree.
 *
 * Both are guarded: when the shape is unexpected the row renders natively.
 */
export function installToolTreePatch(
  registry: ToolTreeRegistry,
  renderersFor?: RenderersFor,
): ToolTreePatchHandle {
  const prototype = getPrototype();
  const existing = prototype[PATCH_SYMBOL] as PatchRecord | undefined;
  if (existing) {
    existing.owners += 1;
    existing.registry = registry;
    if (renderersFor) existing.renderersFor = renderersFor;
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
    renderersFor,
    hadOwnSetExpanded: Object.prototype.hasOwnProperty.call(
      ToolExecutionComponent.prototype,
      "setExpanded",
    ),
  };

  ToolExecutionComponent.prototype.render = function (width: number): string[] {
    try {
      // Rows Pi created before this package drew them keep Pi's own renderer in
      // their captured tool definition. Swap ours in so the call still lands in
      // the tree instead of showing up as a stray native row.
      adoptHandledRow(this, record);
    } catch {
      // Adoption is best-effort; the row still renders below.
    }

    const lines = record.originalRender.call(this, width);
    try {
      if (!Array.isArray(lines) || lines.length === 0) return lines;
      // A row with no node may still be a handled call; adoption above creates
      // or repairs it, so look again before falling through to native output.
      const node = record.registry.node(this.toolCallId);
      if (!node) return lines;
      // Tools that keep Pi's renderer never join the tree, so their rows stay.
      if (!record.registry.rendersInTree(node)) return lines;
      // Only the group's head row renders the tree; the remaining rows of the
      // group draw nothing so the whole block stays contiguous.
      if (record.registry.isGroupHead(node)) return lines;
      // No head means nothing draws this group: hide nothing rather than
      // swallow the call entirely.
      if (!record.registry.hasGroupHead(node)) return lines;
      return [];
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

/**
 * `true` when this row already renders itself through the tree.
 * Pi captures the tool definition when it constructs the component, so a row
 * built while the tree was disabled (or by another renderer earlier in the
 * chain) keeps Pi's renderer forever unless we replace it here.
 */
function adoptHandledRow(component: ToolExecutionComponent, record: PatchRecord): void {
  const row = component as unknown as RowInternals;
  const renderers = record.renderersFor?.(row.toolName);
  if (!renderers) return;
  // A handled call that this package never saw start (row built before the
  // extension was active, missed event) still gets a node, so it can join the
  // tree instead of lingering as a native row.
  let node = record.registry.node(row.toolCallId);
  if (!node) {
    node = record.registry.startNode({
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      args: row.args,
    });
  }
  if (!record.registry.rendersInTree(node)) return;
  if (row.toolDefinition?.renderShell === "self") return;
  if (!row.selfRenderContainer || !row.contentBox) return;

  row.toolDefinition = {
    ...(row.toolDefinition ?? {}),
    name: row.toolName,
    ...renderers,
  };

  // Pi chose the colour-bucket container at construction time; the tree draws
  // itself, so switch the component over to the self-render container.
  for (const child of [row.contentBox, row.contentTextRegion]) {
    if (child && row.children.includes(child)) row.removeChild(child as never);
  }
  if (!row.children.includes(row.selfRenderContainer)) {
    row.addChild(row.selfRenderContainer as never);
  }
  row.updateDisplay();
}

function restore(prototype: Record<PropertyKey, unknown>, record: PatchRecord): void {
  prototype.render = record.originalRender;
  if (record.hadOwnSetExpanded) prototype.setExpanded = record.originalSetExpanded;
  else delete prototype.setExpanded;
  delete prototype[PATCH_SYMBOL];
}
