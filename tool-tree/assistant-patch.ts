import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { ToolTreeRegistry } from "./registry.ts";

export const THINKING_CLAIMS_SYMBOL = Symbol.for("pi-tool-tree/thinking-claims");

export interface AssistantPatchHandle {
  dispose(): void;
}

interface PatchState {
  realMessage?: AssistantMessage;
  renderedMessage?: AssistantMessage;
}

interface PatchRecord {
  owners: number;
  registry: ToolTreeRegistry;
  originalUpdate: (this: AssistantMessageComponent, message: AssistantMessage, isStreaming?: boolean) => void;
  states: WeakMap<AssistantMessageComponent, PatchState>;
  components: Set<WeakRef<AssistantMessageComponent>>;
  known: WeakSet<AssistantMessageComponent>;
}

const PATCH_SYMBOL = Symbol.for("pi-tool-tree/assistant-message-patch");

function stripThinking(message: AssistantMessage): AssistantMessage {
  if (!message.content.some((block) => block.type === "thinking")) return message;
  return {
    ...message,
    content: message.content.filter((block) => block.type !== "thinking"),
  };
}

/**
 * Removes the assistant message's own reasoning block when the turn is owned by
 * the tool tree, so a turn shows one tree instead of a tree plus one
 * "Thought for …" line per assistant message.
 *
 * Messages in turns without handled tools are untouched and keep Pi's normal
 * thinking rendering (or thinking-fold's folded line).
 */
export function installAssistantThinkingPatch(registry: ToolTreeRegistry): AssistantPatchHandle {
  const prototype = AssistantMessageComponent.prototype as unknown as Record<PropertyKey, unknown>;
  const existing = prototype[PATCH_SYMBOL] as PatchRecord | undefined;
  if (existing) {
    existing.owners += 1;
    existing.registry = registry;
    publishClaims(existing.registry);
    return {
      dispose() {
        existing.owners -= 1;
        if (existing.owners === 0) restore(prototype, existing);
      },
    };
  }

  const originalUpdate = AssistantMessageComponent.prototype.updateContent;
  if (typeof originalUpdate !== "function") {
    throw new Error("AssistantMessageComponent.updateContent is unavailable");
  }

  const record: PatchRecord = {
    owners: 1,
    registry,
    originalUpdate,
    states: new WeakMap(),
    components: new Set(),
    known: new WeakSet(),
  };

  AssistantMessageComponent.prototype.updateContent = function (
    message: AssistantMessage,
    isStreaming?: boolean,
  ): void {
    const state = record.states.get(this) ?? {};
    // Container.invalidate() feeds the rendered clone back in; keep the source.
    if (message !== state.renderedMessage) state.realMessage = message;

    record.states.set(this, state);
    if (!record.known.has(this)) {
      record.known.add(this);
      record.components.add(new WeakRef(this));
    }

    const real = state.realMessage ?? message;
    const claimed = record.registry.claimsMessage(real.timestamp);
    const display = claimed ? stripThinking(real) : real;
    state.renderedMessage = display;
    record.originalUpdate.call(this, display, isStreaming);
  };

  prototype[PATCH_SYMBOL] = record;
  publishClaims(registry);

  return {
    dispose() {
      record.owners -= 1;
      if (record.owners === 0) restore(prototype, record);
    },
  };
}

function publishClaims(registry: ToolTreeRegistry): void {
  const bag = globalThis as unknown as Record<PropertyKey, unknown>;
  const previous = bag[THINKING_CLAIMS_SYMBOL] as { claims?: (timestamp: number) => boolean } | undefined;
  const entry = {
    claims: (timestamp: number) => registry.claimsMessage(timestamp),
    // Keep one entry per owner; the newest registry wins.
    previous: previous?.claims,
  };
  bag[THINKING_CLAIMS_SYMBOL] = entry;
}

function restore(prototype: Record<PropertyKey, unknown>, record: PatchRecord): void {
  prototype.updateContent = record.originalUpdate;
  delete prototype[PATCH_SYMBOL];
  delete (globalThis as unknown as Record<PropertyKey, unknown>)[THINKING_CLAIMS_SYMBOL];
}

/** Re-render every tracked assistant message (used when a turn becomes claimed). */
export function rerenderAssistantMessages(): void {
  const prototype = AssistantMessageComponent.prototype as unknown as Record<PropertyKey, unknown>;
  const record = prototype[PATCH_SYMBOL] as PatchRecord | undefined;
  if (!record) return;
  for (const reference of record.components) {
    const component = reference.deref();
    if (!component) {
      record.components.delete(reference);
      continue;
    }
    const state = record.states.get(component);
    if (!state?.realMessage) continue;
    try {
      component.updateContent(state.realMessage, false);
    } catch {
      // Best effort: a stale component must not break the session.
    }
  }
}
