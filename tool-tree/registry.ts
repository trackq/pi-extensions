import type { ToolTreeConfig } from "./config.ts";

export type ToolNodeStatus = "running" | "ok" | "error";

export type ToolNodeKind = "tool" | "thinking";

export interface ToolNode {
  /** "thinking" nodes are the assistant's reasoning for one assistant message. */
  kind: ToolNodeKind;
  toolCallId: string;
  toolName: string;
  args: unknown;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: ToolNodeStatus;
  resultText?: string;
  isError?: boolean;
  /** Node-level expansion (click). */
  expanded: boolean;
  /** Show the complete output instead of the preview (double-click). */
  fullDetail?: boolean;
  parentToolCallId?: string;
  children: ToolNode[];
  /** Reasoning text for thinking nodes. */
  thinkingText?: string;
}

export interface ToolGroup {
  id: string;
  startedAt: number;
  endedAt?: number;
  nodes: ToolNode[];
  /** Expansion of every node in this group (header click / Ctrl+O). */
  expandedAll: boolean;
  /** Collapsed to the summary line (set when the turn ends). */
  collapsed: boolean;
}

function textFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return typeof result === "string" ? result : undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const value = (block as { text?: unknown }).text;
        return typeof value === "string" ? value : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return text.trim() ? text : undefined;
}

/**
 * Groups tool executions into one tree per turn (or per assistant message).
 * Built purely from extension events, so it does not depend on Pi internals.
 */
export class ToolTreeRegistry {
  private readonly groups = new Map<string, ToolGroup>();
  private readonly nodes = new Map<string, ToolNode>();
  private readonly groupOfNode = new Map<string, ToolGroup>();
  private readonly invalidators = new Set<() => void>();
  private currentGroup?: ToolGroup;
  private currentTurnMessages: number[] = [];
  private claimedTurn = false;
  private claimedMessageTimestamps = new Set<number>();
  private thinkingByMessage = new Map<number, ToolNode>();
  private turnCounter = 0;
  private groupCounter = 0;
  private turnKey = "turn-0";
  private revisionCounter = 0;

  constructor(private config: ToolTreeConfig) {}

  setConfig(config: ToolTreeConfig): void {
    this.config = config;
  }

  /** Revision changes whenever the tree structure changes; components use it for caching. */
  get revision(): number {
    return this.revisionCounter;
  }

  startTurn(): void {
    this.turnCounter += 1;
    this.turnKey = `turn-${this.turnCounter}`;
    this.currentGroup = undefined;
    this.currentTurnMessages = [];
    this.claimedTurn = false;
    this.claimedMessageTimestamps.clear();
    this.thinkingByMessage.clear();
  }

  /**
   * True when this assistant message's turn contains handled tool calls, i.e. the
   * tool tree is showing the turn and owns its reasoning.
   */
  claimsMessage(timestamp: number): boolean {
    if (!this.config.enabled) return false;
    return this.claimedMessageTimestamps.has(timestamp);
  }

  /** A handled tool started: the turn's reasoning moves into the tree. */
  claimTurnForThinking(): void {
    if (this.claimedTurn) return;
    this.claimedTurn = true;
    for (const timestamp of this.currentTurnMessages) {
      this.claimedMessageTimestamps.add(timestamp);
    }
    this.bump();
  }

  /** Record one assistant message of the current turn (drives the claim). */
  noteAssistantMessage(timestamp: number): void {
    if (!this.currentTurnMessages.includes(timestamp)) this.currentTurnMessages.push(timestamp);
    if (this.claimedTurn) this.claimedMessageTimestamps.add(timestamp);
  }

  /** Create or update the reasoning node of one assistant message. */
  upsertThinking(timestamp: number, text: string): ToolNode | undefined {
    let node = this.thinkingByMessage.get(timestamp);
    if (!node) {
      const group = this.ensureGroup();
      node = {
        kind: "thinking",
        toolCallId: `thinking-${timestamp}`,
        toolName: "thinking",
        args: {},
        startedAt: Date.now(),
        status: "running",
        expanded: false,
        children: [],
        thinkingText: "",
      };
      this.nodes.set(node.toolCallId, node);
      group.nodes.push(node);
      this.groupOfNode.set(node.toolCallId, group);
      this.thinkingByMessage.set(timestamp, node);
    }
    if (text.trim()) node.thinkingText = text;
    this.bump();
    return node;
  }

  endThinking(timestamp: number): void {
    const node = this.thinkingByMessage.get(timestamp);
    if (!node || node.status !== "running") return;
    node.endedAt = Date.now();
    node.durationMs = Math.max(0, node.endedAt - node.startedAt);
    node.status = "ok";
    this.bump();
  }

  startAssistantMessage(timestamp: number): void {
    // A new assistant message starts a new tree. In "turn" scope the message
    // group joins the turn, so every call of the turn lands in one tree.
    this.groupCounter += 1;
    const id =
      this.config.scope === "turn"
        ? `${this.turnKey}`
        : `${this.turnKey}:msg-${timestamp}-${this.groupCounter}`;
    const existing = this.groups.get(id);
    if (existing) {
      existing.endedAt = undefined;
      this.currentGroup = existing;
    } else {
      const group: ToolGroup = {
        id,
        startedAt: timestamp,
        nodes: [],
        expandedAll: false,
        collapsed: false,
      };
      this.groups.set(id, group);
      this.currentGroup = group;
    }
    this.bump();
  }

  endTurn(): void {
    if (this.currentGroup) {
      this.currentGroup.endedAt = Date.now();
      if (this.config.collapseAfterTurn) this.currentGroup.collapsed = true;
    }
    this.currentGroup = undefined;
    this.bump();
  }

  /** Collapse the whole group to its summary line. */
  collapseGroup(group: ToolGroup): void {
    if (group.collapsed) return;
    group.collapsed = true;
    group.expandedAll = false;
    for (const node of group.nodes) {
      node.expanded = false;
      node.fullDetail = false;
    }
    this.bump();
  }

  /** Header click: expand a collapsed summary first, then toggle node details. */
  expandCollapsed(group: ToolGroup): boolean {
    if (!group.collapsed) return false;
    group.collapsed = false;
    group.expandedAll = false;
    this.bump();
    return true;
  }

  startNode(event: { toolCallId: string; toolName: string; args: unknown; parentToolCallId?: string }): ToolNode {
    const existing = this.nodes.get(event.toolCallId);
    if (existing) {
      existing.args = event.args;
      this.bump();
      return existing;
    }
    const node: ToolNode = {
      kind: "tool",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      startedAt: Date.now(),
      status: "running",
      expanded: false,
      parentToolCallId: event.parentToolCallId,
      children: [],
    };
    this.nodes.set(node.toolCallId, node);

    const parent = event.parentToolCallId ? this.nodes.get(event.parentToolCallId) : undefined;
    if (parent) {
      parent.children.push(node);
      this.groupOfNode.set(node.toolCallId, this.groupOfNode.get(parent.toolCallId) ?? this.ensureGroup());
    } else {
      const group = this.ensureGroup();
      group.nodes.push(node);
      this.groupOfNode.set(node.toolCallId, group);
    }
    this.bump();
    return node;
  }

  updateNode(toolCallId: string, partialResult: unknown): void {
    const node = this.nodes.get(toolCallId);
    if (!node) return;
    const text = textFromResult(partialResult);
    if (text) node.resultText = text;
    this.bump();
  }

  endNode(event: {
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
    durationMs?: number;
  }): void {
    const node = this.nodes.get(event.toolCallId) ?? this.startNode(event);
    node.endedAt = Date.now();
    node.durationMs = event.durationMs;
    node.isError = event.isError;
    node.status = event.isError ? "error" : "ok";
    const text = textFromResult(event.result);
    if (text) node.resultText = text;
    this.bump();
  }

  /** Restore nodes from session entries so earlier turns render as trees. */
  restoreFromEntries(
    entries: readonly { type: string; timestamp?: string | number; message?: unknown }[],
  ): void {
    let group: ToolGroup | undefined;
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.message as
        | { role?: string; timestamp?: number; content?: unknown }
        | undefined;
      if (!message) continue;

      if (message.role === "assistant" && Array.isArray(message.content)) {
        const messageTimestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
        const thinkingText = message.content
          .filter((block) => (block as { type?: string }).type === "thinking")
          .map((block) => String((block as { thinking?: string }).thinking ?? ""))
          .join("\n\n");
        const ownToolCalls = message.content.filter((block) => (block as { type?: string }).type === "toolCall");
        if (ownToolCalls.length > 0) {
          group = group ?? this.ensureGroup();
          this.claimedMessageTimestamps.add(messageTimestamp);
          if (thinkingText.trim()) {
            const thinkingNode: ToolNode = {
              kind: "thinking",
              toolCallId: `thinking-${messageTimestamp}`,
              toolName: "thinking",
              args: {},
              startedAt: messageTimestamp,
              endedAt: messageTimestamp,
              durationMs: 0,
              status: "ok",
              expanded: false,
              children: [],
              thinkingText,
            };
            this.nodes.set(thinkingNode.toolCallId, thinkingNode);
            group.nodes.push(thinkingNode);
            this.groupOfNode.set(thinkingNode.toolCallId, group);
          }
        }
        if (ownToolCalls.length > 0) {
          const started = typeof message.timestamp === "number" ? message.timestamp : Date.now();
          const id = `${this.turnKey}:restored-${started}-${this.groups.size}`;
          group = this.groups.get(id) ?? { id, startedAt: started, nodes: [], expandedAll: false, collapsed: false };
          this.groups.set(id, group);
        }
        for (const block of message.content) {
          const call = block as { type?: string; id?: string; name?: string; arguments?: unknown };
          if (call.type !== "toolCall" || !call.id || !call.name) continue;
          if (!group) continue;
          const node: ToolNode = {
            kind: "tool",
            toolCallId: call.id,
            toolName: call.name,
            args: call.arguments ?? {},
            startedAt: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
            status: "ok",
            expanded: false,
            children: [],
          };
          this.nodes.set(node.toolCallId, node);
          group.nodes.push(node);
          this.groupOfNode.set(node.toolCallId, group);
        }
      }

      if (message.role === "toolResult") {
        const result = message as {
          toolCallId?: string;
          isError?: boolean;
          durationMs?: number;
          content?: unknown;
          timestamp?: number;
        };
        const node = result.toolCallId ? this.nodes.get(result.toolCallId) : undefined;
        if (!node) continue;
        const text = textFromResult({ content: result.content });
        if (text) node.resultText = text;
        node.isError = result.isError === true;
        node.status = node.isError ? "error" : "ok";
        node.durationMs = result.durationMs;
        node.endedAt = typeof result.timestamp === "number" ? result.timestamp : node.endedAt;
      }
    }
    this.bump();
  }

  /** True while any node is still executing (drives the spinner timer). */
  hasRunning(): boolean {
    for (const node of this.nodes.values()) {
      if (node.status === "running") return true;
    }
    return false;
  }

  /** All nodes across groups, in execution order (1-based index for commands). */
  allNodes(): ToolNode[] {
    return this.allGroups().flatMap((group) => group.nodes);
  }

  /** All groups in creation order (used by /tool-tree expand|collapse). */
  allGroups(): ToolGroup[] {
    return [...this.groups.values()];
  }

  node(toolCallId: string): ToolNode | undefined {
    return this.nodes.get(toolCallId);
  }

  groupFor(node: ToolNode): ToolGroup | undefined {
    return this.groupOfNode.get(node.toolCallId);
  }

  /** Position of the node among its group's top-level nodes. */
  nodePosition(node: ToolNode): { index: number; isLast: boolean } {
    const group = this.groupFor(node);
    const siblings = group ? group.nodes : [];
    const index = siblings.findIndex((candidate) => candidate.toolCallId === node.toolCallId);
    return { index, isLast: index === siblings.length - 1 };
  }

  /**
   * True for the first node of a group that has a tool row of its own. Thinking
   * nodes are rendered by that row too, so they never anchor the tree.
   */
  isGroupHead(node: ToolNode): boolean {
    if (node.kind !== "tool") return false;
    const group = this.groupFor(node);
    if (!group) return false;
    const firstTool = group.nodes.find((candidate) => candidate.kind === "tool");
    return firstTool?.toolCallId === node.toolCallId;
  }

  groupSummary(group: ToolGroup): {
    calls: number;
    thoughts: number;
    failed: number;
    running: number;
    durationMs?: number;
  } {
    const nodes = group.nodes.filter((node) => node.kind === "tool");
    const failed = nodes.filter((node) => node.status === "error").length;
    const running = nodes.filter((node) => node.status === "running").length;
    // Wall-clock span of the group (thoughts + tools), not a sum of tool times.
    const starts = group.nodes
      .map((node) => node.startedAt)
      .filter((value): value is number => Number.isFinite(value));
    const ends = group.nodes.map((node) => node.endedAt ?? Date.now());
    const durationMs =
      starts.length > 0 && ends.length > 0
        ? Math.max(0, Math.max(...ends) - Math.min(...starts))
        : group.startedAt && group.endedAt
          ? group.endedAt - group.startedAt
          : undefined;
    const thoughts = group.nodes.filter((node) => node.kind === "thinking").length;
    return { calls: nodes.length, thoughts, failed, running, durationMs };
  }

  /** Bump the revision so views re-render after an external state change. */
  touch(): void {
    this.bump();
  }

  setNodeExpanded(node: ToolNode, expanded: boolean): void {
    if (node.expanded === expanded) return;
    node.expanded = expanded;
    this.bump();
  }

  toggleNode(node: ToolNode): void {
    node.expanded = !node.expanded;
    if (!node.expanded) node.fullDetail = false;
    for (const child of node.children) child.expanded = node.expanded;
    this.bump();
  }

  /** Double-click: show the full output, or collapse a node that is already full. */
  expandNodeFully(node: ToolNode): void {
    if (node.expanded && node.fullDetail) {
      node.expanded = false;
      node.fullDetail = false;
    } else {
      node.expanded = true;
      node.fullDetail = true;
    }
    for (const child of node.children) {
      child.expanded = node.expanded;
      child.fullDetail = node.fullDetail;
    }
    this.bump();
  }

  anyNodeExpanded(group: ToolGroup): boolean {
    return group.expandedAll || group.nodes.some((node) => node.expanded);
  }

  toggleGroup(group: ToolGroup): void {
    if (this.anyNodeExpanded(group)) {
      group.expandedAll = false;
      for (const node of group.nodes) {
        node.expanded = false;
        node.fullDetail = false;
        for (const child of node.children) {
          child.expanded = false;
          child.fullDetail = false;
        }
      }
    } else {
      group.expandedAll = true;
    }
    this.bump();
  }

  /** Ctrl+O in Pi expands every tool row; mirror it on the whole group. */
  setGroupExpandedAll(group: ToolGroup, expanded: boolean): void {
    const changed = group.expandedAll !== expanded || (expanded === false && group.nodes.some((node) => node.expanded));
    if (!changed) return;
    group.expandedAll = expanded;
    if (!expanded) {
      for (const node of group.nodes) {
        node.expanded = false;
        node.fullDetail = false;
        for (const child of node.children) {
          child.expanded = false;
          child.fullDetail = false;
        }
      }
    }
    this.bump();
  }

  /**
   * Register a redraw callback so sibling nodes pick up connector/header
   * changes when the tree grows.
   */
  onTreeChange(invalidate: () => void): () => void {
    this.invalidators.add(invalidate);
    return () => this.invalidators.delete(invalidate);
  }

  /** Called by the patched ToolExecutionComponent so Ctrl+O reaches the tree. */
  notifyPiExpanded(toolCallId: string, expanded: boolean): void {
    const node = this.nodes.get(toolCallId);
    const group = node ? this.groupFor(node) : undefined;
    if (group) this.setGroupExpandedAll(group, expanded);
  }

  private ensureGroup(): ToolGroup {
    if (this.currentGroup) return this.currentGroup;
    const id = `${this.turnKey}:group-${this.groups.size}`;
    const group: ToolGroup = { id, startedAt: Date.now(), nodes: [], expandedAll: false, collapsed: false };
    this.groups.set(id, group);
    this.currentGroup = group;
    return group;
  }

  private bump(): void {
    this.revisionCounter += 1;
    for (const invalidate of this.invalidators) {
      try {
        invalidate();
      } catch {
        // A stale component must never break the tree.
      }
    }
  }
}
