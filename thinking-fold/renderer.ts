import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  type Component,
  type DefaultTextStyle,
  type MarkdownOptions,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { resolveConfiguredThinkingBehavior } from "./model-behaviors.ts";

export type ThinkingFoldMode = "auto" | "trace" | "summary";
export type ThinkingStreamingBehavior = "auto" | "preview" | "collapse";
export type ThinkingCompletedBehavior = "auto" | "collapse" | "preview" | "full";
type EffectiveThinkingDisplayBehavior = Exclude<ThinkingCompletedBehavior, "auto">;

export interface ThinkingFoldOptions {
  mode: ThinkingFoldMode;
  previewLines: number;
  streamingBehavior: ThinkingStreamingBehavior;
  completedBehavior: ThinkingCompletedBehavior;
  /** @deprecated Use completedBehavior instead. */
  autoCollapse?: boolean;
  toggleKey: string;
}

export interface ThinkingTiming {
  startedAt: number;
  completedAt?: number;
}

export interface ThinkingDisplayState {
  timing?: ThinkingTiming;
  now?: number;
}

export const DEFAULT_THINKING_CURSOR_LABEL = "Thinking...";

export const DEFAULT_THINKING_FOLD_OPTIONS: ThinkingFoldOptions = {
  mode: "auto",
  previewLines: 5,
  streamingBehavior: "auto",
  completedBehavior: "auto",
  toggleKey: "ctrl+t",
};

interface ComponentState {
  fullMessage?: AssistantMessage;
  renderedMessage?: AssistantMessage;
  isStreaming?: boolean;
  /** Set when the update-time fold already rendered this message folded. */
  folded?: boolean;
}

interface AssistantMessageInternals {
  contentContainer?: { children?: Component[] };
  hideThinkingBlock?: boolean;
  thinkingVisibilityOverrides?: Map<number, boolean>;
  outputPad?: number;
}

// Pi 0.85 wraps thinking Markdown in MouseRegion. Keep this structural so
// older Pi versions do not need to export MouseRegion or its event types.
interface ThinkingMouseRegion extends Component {
  child: Component;
  handleMouse(event: { type: string; button?: string }): { handled: true } | undefined;
}

function getThinkingMouseRegion(component: Component): ThinkingMouseRegion | undefined {
  const region = component as Partial<ThinkingMouseRegion>;
  return region.child &&
    (region.child instanceof Markdown || region.child instanceof RenderedThinkingSection) &&
    typeof region.handleMouse === "function"
    ? region as ThinkingMouseRegion
    : undefined;
}

interface MarkdownInternals {
  text?: string;
  paddingX?: number;
  paddingY?: number;
  defaultTextStyle?: DefaultTextStyle;
  theme?: MarkdownTheme;
  options?: MarkdownOptions;
}

interface RenderCacheEntry {
  key: string;
  lines: string[];
}

interface PatchRecord {
  owners: number;
  expanded: boolean;
  now: number;
  options: ThinkingFoldOptions;
  originalUpdate: (this: AssistantMessageComponent, message: AssistantMessage, isStreaming?: boolean) => void;
  originalRender: (this: AssistantMessageComponent, width: number) => string[];
  renderCache: WeakMap<AssistantMessageComponent, RenderCacheEntry>;
  /** Assistant messages seen through extension events, keyed by timestamp. */
  messages: Map<number, AssistantMessage>;
  currentMessage?: AssistantMessage;
  states: WeakMap<AssistantMessageComponent, ComponentState>;
  components: Set<WeakRef<AssistantMessageComponent>>;
  knownComponents: WeakSet<AssistantMessageComponent>;
  timings: Map<number, ThinkingTiming>;
  updateOptions(options: Partial<ThinkingFoldOptions>): void;
  setExpanded(expanded: boolean): void;
  setMessageTiming(timestamp: number, timing: ThinkingTiming): void;
  beginMessage(message: AssistantMessage, startedAt?: number): void;
  completeMessage(message: AssistantMessage, completedAt?: number): void;
  tick(now?: number): void;
  rerenderAll(): void;
  rerenderTimestamp(timestamp: number): void;
  trackMessage(message: AssistantMessage): void;
}

export interface ThinkingFoldPatchHandle {
  readonly expanded: boolean;
  readonly options: ThinkingFoldOptions;
  updateOptions(options: Partial<ThinkingFoldOptions>): void;
  setExpanded(expanded: boolean): void;
  toggle(): void;
  setMessageTiming(timestamp: number, timing: ThinkingTiming): void;
  beginMessage(message: AssistantMessage, startedAt?: number): void;
  completeMessage(message: AssistantMessage, completedAt?: number): void;
  tick(now?: number): void;
  /** Remember an assistant message from the live event stream. */
  trackMessage(message: AssistantMessage): void;
  dispose(): void;
}

const PATCH_SYMBOL = Symbol.for("@99percentpeople/pi-thinking-fold/assistant-message-patch");

function normalizedOptions(options: Partial<ThinkingFoldOptions>): ThinkingFoldOptions {
  const previewLines = options.previewLines ?? DEFAULT_THINKING_FOLD_OPTIONS.previewLines;
  const completedBehavior =
    options.completedBehavior === "auto" ||
    options.completedBehavior === "collapse" ||
    options.completedBehavior === "preview" ||
    options.completedBehavior === "full"
      ? options.completedBehavior
      : options.autoCollapse === false
        ? "preview"
        : options.autoCollapse === true
          ? "collapse"
          : DEFAULT_THINKING_FOLD_OPTIONS.completedBehavior;
  return {
    mode: options.mode ?? DEFAULT_THINKING_FOLD_OPTIONS.mode,
    previewLines:
      Number.isInteger(previewLines) && previewLines > 0
        ? previewLines
        : DEFAULT_THINKING_FOLD_OPTIONS.previewLines,
    streamingBehavior:
      options.streamingBehavior === "auto" ||
      options.streamingBehavior === "collapse" ||
      options.streamingBehavior === "preview"
        ? options.streamingBehavior
        : DEFAULT_THINKING_FOLD_OPTIONS.streamingBehavior,
    completedBehavior,
    toggleKey: options.toggleKey?.trim() || DEFAULT_THINKING_FOLD_OPTIONS.toggleKey,
  };
}

function cleanSummaryHeadline(value: string): string {
  const cleaned = value
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\*\*(.*?)\*\*$/, "$1")
    .replace(/^__(.*?)__$/, "$1")
    .replace(/^\*\*/, "")
    .replace(/\*\*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).length > 96
    ? `${Array.from(cleaned).slice(0, 95).join("")}…`
    : cleaned;
}

function latestSummaryHeadlineFromText(text: string): string | undefined {
  const boldHeadings = [...text.matchAll(/^\s*\*\*(.+?)\*\*\s*$/gm)];
  const boldHeadline = boldHeadings.at(-1)?.[1];
  if (boldHeadline?.trim()) return cleanSummaryHeadline(boldHeadline);

  const latestParagraph = text
    .trim()
    .split(/\n\s*\n/)
    .filter((paragraph) => paragraph.trim())
    .at(-1);
  const latestLine = latestParagraph
    ?.split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const headline = latestLine ? cleanSummaryHeadline(latestLine) : "";
  return headline || undefined;
}

export function extractLatestSummaryHeadline(message: AssistantMessage): string | undefined {
  for (let index = message.content.length - 1; index >= 0; index -= 1) {
    const block = message.content[index];
    if (block?.type !== "thinking" || !block.thinking.trim()) continue;
    return latestSummaryHeadlineFromText(block.thinking);
  }
  return undefined;
}

export function resolveThinkingBehavior(
  message: AssistantMessage,
  mode: ThinkingFoldMode,
): Exclude<ThinkingFoldMode, "auto"> {
  if (mode !== "auto") return mode;

  return resolveConfiguredThinkingBehavior(message) ?? "trace";
}

export function resolveThinkingDisplayBehavior(
  message: AssistantMessage,
  options: Pick<
    ThinkingFoldOptions,
    "mode" | "streamingBehavior" | "completedBehavior"
  >,
  completed: boolean,
): EffectiveThinkingDisplayBehavior {
  if (completed) {
    return options.completedBehavior === "auto" ? "collapse" : options.completedBehavior;
  }
  if (options.streamingBehavior !== "auto") return options.streamingBehavior;
  return resolveThinkingBehavior(message, options.mode) === "summary" ? "collapse" : "preview";
}

export function formatThinkingSeconds(milliseconds: number): string {
  return `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
}

export function formatStreamingThinkingSeconds(milliseconds: number): string {
  return `${Math.floor(Math.max(0, milliseconds) / 1000)}s`;
}

export function createThinkingCursorLabel(
  message: AssistantMessage,
  mode: ThinkingFoldMode,
): string {
  const headline =
    resolveThinkingBehavior(message, mode) === "summary"
      ? extractLatestSummaryHeadline(message)
      : undefined;
  return headline ?? DEFAULT_THINKING_CURSOR_LABEL;
}

function foldThinkingText(
  text: string,
  previewLines: number,
  width: number,
  outputPad: number,
): string {
  const availableWidth = Math.max(10, width - outputPad * 2);
  const stableText = text
    .replace(/\r\n|\r/g, "\n")
    .replace(/\t/g, "   ")
    .replace(/\n+$/, "");
  const result = truncateToVisualLines(stableText, previewLines, availableWidth);
  return result.visualLines.map((line) => line.trimEnd()).join("\n").replace(/\n+$/, "");
}

function hasFoldedThinkingContent(
  message: AssistantMessage,
  previewLines: number,
  width: number,
  outputPad: number,
): boolean {
  const availableWidth = Math.max(10, width - outputPad * 2);
  return message.content.some(
    (block) =>
      block.type === "thinking" &&
      truncateToVisualLines(block.thinking, previewLines, availableWidth).skippedCount > 0,
  );
}

interface NativeThinkingRun {
  start: number;
  end: number;
  text: string;
}

interface MarkedThinkingSection {
  marker: string;
  text: string;
  showLabel: boolean;
}

interface MarkedThinkingMessage {
  message: AssistantMessage;
  sections: MarkedThinkingSection[];
}

/**
 * Shared render state for all thinking sections in one assistant message.
 * Every section is rendered first; only then do we decide whether content is
 * actually hidden and whether the expansion hint belongs in the header.
 */
class RenderedThinkingContext {
  readonly sections: RenderedThinkingSection[] = [];
  canExpand = false;
  private preparedWidth?: number;

  constructor(
    readonly behavior: EffectiveThinkingDisplayBehavior,
    readonly previewLines: number,
    readonly collapseCanExpand: boolean,
    readonly labelFor: (canExpand: boolean) => string,
  ) {}

  add(section: RenderedThinkingSection): void {
    this.sections.push(section);
  }

  prepare(width: number): void {
    if (this.preparedWidth === width) return;
    for (const section of this.sections) section.prepare(width);
    this.canExpand =
      this.behavior === "collapse"
        ? this.collapseCanExpand
        : this.behavior === "preview"
          ? this.sections.some((section) => section.renderedLineCount > this.previewLines)
          : false;
    this.preparedWidth = width;
  }

  invalidate(): void {
    this.preparedWidth = undefined;
  }
}

/** Render Pi's native Markdown first, then retain its final terminal rows. */
class RenderedThinkingSection implements Component {
  private fullLines: string[] = [];
  private preparedWidth?: number;
  private labelText?: string;

  constructor(
    private readonly content: Markdown,
    private readonly label: Markdown | undefined,
    private readonly context: RenderedThinkingContext,
  ) {
    context.add(this);
  }

  get renderedLineCount(): number {
    return this.fullLines.length;
  }

  prepare(width: number): void {
    if (this.preparedWidth === width) return;
    this.fullLines = this.content.render(width);
    this.preparedWidth = width;
  }

  render(width: number): string[] {
    this.context.prepare(width);
    const contentLines =
      this.context.behavior === "collapse"
        ? []
        : this.context.behavior === "preview"
          ? this.fullLines.slice(-this.context.previewLines)
          : this.fullLines;
    if (!this.label) return contentLines;

    const labelText = this.context.labelFor(this.context.canExpand);
    if (labelText !== this.labelText) {
      this.label.setText(labelText);
      this.labelText = labelText;
    }
    return [...this.label.render(width), ...contentLines];
  }

  invalidate(): void {
    this.content.invalidate();
    this.label?.invalidate();
    this.preparedWidth = undefined;
    this.context.invalidate();
  }
}

function collectThinkingRuns(message: AssistantMessage): NativeThinkingRun[] {
  const runs: NativeThinkingRun[] = [];
  let index = 0;
  while (index < message.content.length) {
    const block = message.content[index];
    if (!block || block.type !== "thinking") {
      index++;
      continue;
    }

    const start = index;
    const fragments: string[] = [];
    while (index < message.content.length) {
      const thinkingBlock = message.content[index];
      if (!thinkingBlock || thinkingBlock.type !== "thinking") break;
      const text = thinkingBlock.thinking.trim();
      if (text) fragments.push(text);
      index++;
    }
    runs.push({ start, end: index, text: fragments.join("\n\n") });
  }
  return runs;
}

function createMarkedThinkingMessage(
  message: AssistantMessage,
  behavior: EffectiveThinkingDisplayBehavior,
): MarkedThinkingMessage | undefined {
  const runs = collectThinkingRuns(message);
  const firstRun = runs[0];
  if (!firstRun) return undefined;

  const content = [...message.content];
  const sections: MarkedThinkingSection[] = [];
  const clearRun = (run: NativeThinkingRun) => {
    for (let index = run.start; index < run.end; index++) {
      const block = content[index];
      if (block?.type === "thinking") content[index] = { ...block, thinking: "" };
    }
  };
  const markRun = (run: NativeThinkingRun, runIndex: number, showLabel: boolean) => {
    clearRun(run);
    const block = content[run.start];
    if (!block || block.type !== "thinking") return;
    const marker = `\uE000thinking-fold:${message.timestamp}:${runIndex}\uE001`;
    content[run.start] = { ...block, thinking: marker };
    sections.push({ marker, text: run.text, showLabel });
  };

  if (behavior === "collapse") {
    for (const run of runs) clearRun(run);
    markRun(firstRun, 0, true);
  } else if (behavior === "preview") {
    for (const run of runs) clearRun(run);
    runs.forEach((run, runIndex) => {
      if (runIndex === 0 || run.text) markRun(run, runIndex, runIndex === 0);
    });
  } else {
    markRun(firstRun, 0, true);
  }

  return { message: { ...message, content }, sections };
}

const identityThemeText = (text: string): string => text;

/**
 * Minimal, color-free Markdown theme. Used only when no native Markdown child is
 * available to clone Pi's real theme from (for example a thinking-only message
 * that another extension intercepted).
 */
const PLAIN_MARKDOWN_THEME: MarkdownTheme = {
  heading: identityThemeText,
  link: identityThemeText,
  linkUrl: identityThemeText,
  code: identityThemeText,
  codeBlock: identityThemeText,
  codeBlockBorder: identityThemeText,
  quote: identityThemeText,
  quoteBorder: identityThemeText,
  hr: identityThemeText,
  listBullet: identityThemeText,
  bold: identityThemeText,
  italic: identityThemeText,
  strikethrough: identityThemeText,
  underline: identityThemeText,
};

function createPlainMarkdown(text: string, outputPad: number): Markdown {
  return new Markdown(text, outputPad, 0, PLAIN_MARKDOWN_THEME, { italic: true });
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const PROBE_WIDTH = 120;

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function normalizedProbeText(value: string): string {
  return stripAnsi(value).replace(/[\s\u2500-\u257f\u2580-\u259f|]/gu, "");
}

/**
 * Render a foreign child to a probe width and report whether it displays any of
 * the given needles. Other thinking extensions (for example a thinking-steps
 * renderer) consume the marked thinking text and re-render it themselves, so the
 * marker or the raw reasoning text ends up in their own component.
 */
function childDisplaysAny(
  child: Component,
  needles: string[],
  normalize: boolean,
  width = PROBE_WIDTH,
): boolean {
  if (needles.length === 0) return false;
  let rendered: string[];
  try {
    rendered = child.render(width);
  } catch {
    return false;
  }
  const raw = rendered.join("\n");
  const haystack = normalize ? normalizedProbeText(raw) : stripAnsi(raw);
  return needles.some((needle) => haystack.includes(needle));
}

function findMarkdownTemplate(children: Component[]): Component | undefined {
  for (const child of children) {
    if (!child) continue;
    if (getMarkdownInternals(child)) return child;
    const region = getThinkingMouseRegion(child);
    if (region && getMarkdownInternals(region.child)) return region.child;
  }
  return undefined;
}

/**
 * A thinking renderer installed by another extension usually names its panel
 * `*Thinking*`/`*Reasoning*` and is not one of Pi's own Markdown children. Such
 * panels may paraphrase the reasoning, so naming is the reliable last signal.
 */
function isForeignThinkingComponent(child: Component): boolean {
  if (child instanceof RenderedThinkingSection) return false;
  if (getMarkdownInternals(child)) return false;
  const name = (child as { constructor?: { name?: string } }).constructor?.name ?? "";
  return /thinking|reasoning/i.test(name);
}

function isSpacerComponent(child: Component | undefined): boolean {
  if (!child) return false;
  return /^Spacer$/.test((child as { constructor?: { name?: string } }).constructor?.name ?? "");
}

function getMarkdownInternals(component: Component): MarkdownInternals | undefined {
  if (!(component instanceof Markdown)) return undefined;
  const internals = component as unknown as MarkdownInternals;
  return typeof internals.text === "string" &&
    typeof internals.paddingX === "number" &&
    typeof internals.paddingY === "number" &&
    internals.theme
    ? internals
    : undefined;
}

function cloneNativeMarkdown(component: Component, text: string): Markdown | undefined {
  const internals = getMarkdownInternals(component);
  if (!internals?.theme || internals.paddingX === undefined || internals.paddingY === undefined) {
    return undefined;
  }
  return new Markdown(
    text,
    internals.paddingX,
    internals.paddingY,
    internals.theme,
    internals.defaultTextStyle,
    internals.options,
  );
}

function replaceMarkedThinkingSections(
  component: AssistantMessageComponent,
  marked: MarkedThinkingMessage,
  behavior: EffectiveThinkingDisplayBehavior,
  previewLines: number,
  collapseCanExpand: boolean,
  labelFor: (canExpand: boolean) => string,
): boolean {
  const internals = component as unknown as AssistantMessageInternals;
  const children = internals.contentContainer?.children;
  if (!children) return false;

  const pending = new Map(marked.sections.map((section) => [section.marker, section]));
  const context = new RenderedThinkingContext(
    behavior,
    previewLines,
    collapseCanExpand,
    labelFor,
  );
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (!child) continue;
    const region = getThinkingMouseRegion(child);
    const nativeMarkdown = region?.child ?? child;
    const markdown = getMarkdownInternals(nativeMarkdown);
    const section = markdown?.text ? pending.get(markdown.text) : undefined;
    if (!section) continue;

    const content = cloneNativeMarkdown(nativeMarkdown, section.text);
    const label = section.showLabel ? cloneNativeMarkdown(nativeMarkdown, "") : undefined;
    if (!content || (section.showLabel && !label)) return false;
    const replacement = new RenderedThinkingSection(content, label, context);
    if (region) region.child = replacement;
    else children[index] = replacement;
    pending.delete(section.marker);
  }
  return pending.size === 0;
}

/**
 * Last-resort folding for the case where another thinking renderer consumed the
 * marked message and rendered the reasoning itself (for example a thinking-steps
 * extension patching `updateContent`).
 *
 * Instead of relying on Pi's native thinking `Markdown` children, the foreign
 * thinking children are located by their rendered output and replaced with this
 * package's folded sections. This keeps folding working for DeepSeek and other
 * reasoning models no matter which extension renders the message first.
 */
function replaceForeignThinkingSections(
  component: AssistantMessageComponent,
  marked: MarkedThinkingMessage,
  behavior: EffectiveThinkingDisplayBehavior,
  previewLines: number,
  collapseCanExpand: boolean,
  labelFor: (canExpand: boolean) => string,
  outputPad: number,
): boolean {
  const internals = component as unknown as AssistantMessageInternals;
  const children = internals.contentContainer?.children;
  if (!children || marked.sections.length === 0) return false;

  const markerNeedles = marked.sections.map((section) => section.marker);
  const textNeedles = marked.sections
    .map((section) => {
      const flat = normalizedProbeText(section.text);
      if (flat.length < 12) return flat;
      const length = Math.min(48, Math.max(12, Math.floor(flat.length / 2)));
      return flat.slice(0, length);
    })
    .filter((needle) => needle.length >= 12);

  const victims: number[] = [];
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (!child) continue;
    // Native Pi thinking Markdown is handled by the marker route.
    if (getMarkdownInternals(child)) continue;
    if (
      childDisplaysAny(child, markerNeedles, false) ||
      childDisplaysAny(child, textNeedles, true) ||
      isForeignThinkingComponent(child)
    ) {
      victims.push(index);
    }
  }
  if (victims.length === 0) return false;

  const template = findMarkdownTemplate(children);
  const context = new RenderedThinkingContext(behavior, previewLines, collapseCanExpand, labelFor);
  const sections: RenderedThinkingSection[] = [];
  for (const section of marked.sections) {
    const content = template
      ? cloneNativeMarkdown(template, section.text)
      : createPlainMarkdown(section.text, outputPad);
    if (!content) return false;
    const label = section.showLabel
      ? template
        ? cloneNativeMarkdown(template, "")
        : createPlainMarkdown("", outputPad)
      : undefined;
    if (section.showLabel && !label) return false;
    sections.push(new RenderedThinkingSection(content, label, context));
  }

  const insertionIndex = victims[0]!;
  const victimSet = new Set(victims);
  const remaining: Component[] = [];
  children.forEach((child, index) => {
    if (child && !victimSet.has(index)) remaining.push(child);
  });
  remaining.splice(Math.min(insertionIndex, remaining.length), 0, ...sections);
  children.length = 0;
  children.push(...compactSpacers(remaining));
  return true;
}

/** Collapse spacer runs left behind by a removed thinking panel. */
function compactSpacers(components: Component[]): Component[] {
  const compacted: Component[] = [];
  for (const child of components) {
    if (isSpacerComponent(child) && isSpacerComponent(compacted.at(-1))) continue;
    compacted.push(child);
  }
  return compacted;
}

function createStreamingThinkingLabel(
  options: ThinkingFoldOptions,
  timing: ThinkingTiming | undefined,
  now: number,
  canExpand: boolean,
): string {
  const duration = timing ? formatThinkingSeconds(now - timing.startedAt) : "0.0s";
  return `Thinking ${duration}${canExpand ? `  (${options.toggleKey} to expand)` : ""}`;
}

function createCompletedThinkingLabel(
  options: ThinkingFoldOptions,
  timing: ThinkingTiming,
  canExpand: boolean,
): string {
  const duration = formatThinkingSeconds(timing.completedAt! - timing.startedAt);
  return `Thought for ${duration}${canExpand ? `  (${options.toggleKey} to expand)` : ""}`;
}

/**
 * @deprecated Preview folding now happens after native Markdown rendering and
 * cannot be represented faithfully as an AssistantMessage. Use
 * installThinkingFoldPatch() for the TUI behavior; this source-level helper is
 * retained for compatibility with existing consumers.
 */
export function createThinkingDisplayMessage(
  message: AssistantMessage,
  options: ThinkingFoldOptions,
  expanded: boolean,
  width: number,
  outputPad = 1,
  display: ThinkingDisplayState = {},
): AssistantMessage {
  if (expanded) return message;

  const firstThinkingIndex = message.content.findIndex((block) => block.type === "thinking");
  if (firstThinkingIndex === -1) return message;

  const timing = display.timing;
  const completed = timing?.completedAt !== undefined;
  const displayBehavior = resolveThinkingDisplayBehavior(message, options, completed);
  const hasThinkingContent = message.content.some(
    (block) => block.type === "thinking" && block.thinking.trim(),
  );
  const canExpand =
    displayBehavior === "collapse"
      ? hasThinkingContent
      : displayBehavior === "preview" &&
        hasFoldedThinkingContent(message, options.previewLines, width, outputPad);
  const label =
    completed && timing
      ? createCompletedThinkingLabel(options, timing, canExpand)
      : createStreamingThinkingLabel(options, timing, display.now ?? Date.now(), canExpand);
  let changed = false;
  const content = message.content.map((block, index) => {
    if (block.type !== "thinking") return block;

    const visibleThinking =
      displayBehavior === "collapse"
        ? ""
        : displayBehavior === "preview"
          ? foldThinkingText(block.thinking, options.previewLines, width, outputPad)
          : block.thinking;
    const thinking =
      index === firstThinkingIndex
        ? visibleThinking
          ? `${label}\n${visibleThinking}`
          : label
        : visibleThinking;

    if (thinking === block.thinking) return block;
    changed = true;
    return { ...block, thinking };
  });

  return changed ? { ...message, content } : message;
}

function getPatchRecord(): PatchRecord | undefined {
  return (AssistantMessageComponent.prototype as unknown as Record<PropertyKey, unknown>)[
    PATCH_SYMBOL
  ] as PatchRecord | undefined;
}

function setPatchRecord(record: PatchRecord | undefined): void {
  const prototype = AssistantMessageComponent.prototype as unknown as Record<PropertyKey, unknown>;
  if (record) prototype[PATCH_SYMBOL] = record;
  else delete prototype[PATCH_SYMBOL];
}

const THINKING_CLAIMS_SYMBOL = Symbol.for("pi-tool-tree/thinking-claims");

/**
 * When tool-tree owns a turn, it renders the reasoning inside its tree. Skip the
 * folded line here so one turn shows one tree instead of a tree plus one
 * "Thought for …" line per assistant message.
 */
function reasoningClaimedByToolTree(timestamp: number): boolean {
  const bag = globalThis as unknown as Record<PropertyKey, unknown>;
  const entry = bag[THINKING_CLAIMS_SYMBOL] as { claims?: (ts: number) => boolean } | undefined;
  try {
    return entry?.claims?.(timestamp) === true;
  } catch {
    return false;
  }
}

function messageHasThinking(message: AssistantMessage | undefined): boolean {
  return !!message?.content.some((block) => block.type === "thinking" && block.thinking.trim());
}

/**
 * Resolve the assistant message that should be folded.
 *
 * Another extension can patch `updateContent` before this one and hand every
 * later patch a message with the reasoning removed. The real message is still
 * visible in the extension event stream, so the tracked copy is preferred
 * whenever the received message carries no reasoning.
 */
function resolveDisplayMessage(
  record: PatchRecord,
  component: AssistantMessageComponent,
): AssistantMessage | undefined {
  const base = record.states.get(component)?.fullMessage;
  if (!base) return record.currentMessage;
  const tracked = record.messages.get(base.timestamp);
  if (tracked && messageHasThinking(tracked)) return tracked;
  if (messageHasThinking(base)) return base;
  return base;
}

function rebuild(
  component: AssistantMessageComponent,
  state: ComponentState,
  record: PatchRecord,
): void {
  const received = state.fullMessage;
  if (!received) return;
  const message = resolveDisplayMessage(record, component) ?? received;

  const internals = component as unknown as AssistantMessageInternals;
  const nativeHidden = internals.hideThinkingBlock;
  const nativeOverrides = internals.thinkingVisibilityOverrides;
  internals.hideThinkingBlock = false;
  // Native per-run hiding must not prevent marker discovery or Ctrl+T expansion.
  if (nativeOverrides) internals.thinkingVisibilityOverrides = new Map();
  try {
    state.folded = false;
    if (reasoningClaimedByToolTree(message.timestamp)) {
      const withoutThinking: AssistantMessage = {
        ...message,
        content: message.content.filter((block) => block.type !== "thinking"),
      };
      state.renderedMessage = withoutThinking;
      state.folded = true;
      record.originalUpdate.call(component, withoutThinking, state.isStreaming);
      return;
    }
    if (record.expanded || !message.content.some((block) => block.type === "thinking")) {
      state.renderedMessage = message;
      record.originalUpdate.call(component, message, state.isStreaming);
      return;
    }

    const timing = record.timings.get(message.timestamp);
    const completed = timing?.completedAt !== undefined;
    const behavior = resolveThinkingDisplayBehavior(message, record.options, completed);
    const marked = createMarkedThinkingMessage(message, behavior);
    if (!marked) {
      state.renderedMessage = message;
      record.originalUpdate.call(component, message, state.isStreaming);
      return;
    }

    const hasThinkingContent = message.content.some(
      (block) => block.type === "thinking" && block.thinking.trim(),
    );
    const labelFor = (canExpand: boolean) =>
      completed && timing
        ? createCompletedThinkingLabel(record.options, timing, canExpand)
        : createStreamingThinkingLabel(record.options, timing, record.now, canExpand);

    state.renderedMessage = marked.message;
    record.originalUpdate.call(component, marked.message, state.isStreaming);
    const replaced = replaceMarkedThinkingSections(
      component,
      marked,
      behavior,
      record.options.previewLines,
      hasThinkingContent,
      labelFor,
    );
    if (replaced) {
      state.folded = true;
      return;
    }

    // Another extension (for example a thinking-steps renderer) may have
    // consumed the marked message and rendered the reasoning in its own
    // component. Fold that component instead of silently disabling folding.
    const foldedForeign = replaceForeignThinkingSections(
      component,
      marked,
      behavior,
      record.options.previewLines,
      hasThinkingContent,
      labelFor,
      typeof internals.outputPad === "number" ? internals.outputPad : 1,
    );
    if (foldedForeign) {
      state.folded = true;
      return;
    }

    // Pi changed its internal child layout. Never leak markers or damage the
    // message: fall back to the complete native rendering for this component.
    state.renderedMessage = message;
    record.originalUpdate.call(component, message, state.isStreaming);
  } finally {
    internals.hideThinkingBlock = nativeHidden;
    if (nativeOverrides) internals.thinkingVisibilityOverrides = nativeOverrides;
    // Mouse clicks and Ctrl+T share one persistent display preference rather
    // than letting native per-run overrides fight the folded representation.
    for (const child of internals.contentContainer?.children ?? []) {
      const region = getThinkingMouseRegion(child);
      if (!region) continue;
      region.handleMouse = (event) => {
        if (event.type !== "click" || event.button !== "left") return undefined;
        record.setExpanded(!record.expanded);
        return { handled: true };
      };
    }
  }
}

function forEachLiveComponent(
  record: PatchRecord,
  callback: (component: AssistantMessageComponent, state: ComponentState) => void,
): void {
  for (const reference of record.components) {
    const component = reference.deref();
    if (!component) {
      record.components.delete(reference);
      continue;
    }
    const state = record.states.get(component);
    if (state) callback(component, state);
  }
}

/**
 * Fold at render time.
 *
 * Another extension can install its `updateContent` patch after this package,
 * making it the outer wrapper. It then hands this package's patch a
 * thinking-free message and renders the reasoning itself, so the marker route
 * never sees the reasoning. Such panels are found and hidden while the native
 * render runs, and this package's folded section is prepended in their place.
 */
function renderWithForeignFold(
  component: AssistantMessageComponent,
  record: PatchRecord,
  width: number,
): string[] {
  const message = resolveDisplayMessage(record, component);
  const internals = component as unknown as AssistantMessageInternals;
  const children = internals.contentContainer?.children;
  if (
    !message ||
    record.expanded ||
    !children?.length ||
    !message.content.some((block) => block.type === "thinking")
  ) {
    return record.originalRender.call(component, width);
  }

  const runs = collectThinkingRuns(message).filter((run) => run.text.trim());
  if (runs.length === 0) return record.originalRender.call(component, width);

  const timing = record.timings.get(message.timestamp);
  const completed = timing?.completedAt !== undefined;
  const behavior = resolveThinkingDisplayBehavior(message, record.options, completed);
  if (behavior === "full") return record.originalRender.call(component, width);

  const hasThinkingContent = message.content.some(
    (block) => block.type === "thinking" && block.thinking.trim(),
  );
  const labelFor = (canExpand: boolean) =>
    completed && timing
      ? createCompletedThinkingLabel(record.options, timing, canExpand)
      : createStreamingThinkingLabel(record.options, timing, record.now, canExpand);

  const cacheKey = [
    message.timestamp,
    runs.length,
    runs.reduce((total, run) => total + run.text.length, 0),
    width,
    behavior,
    record.options.previewLines,
    labelFor(false),
  ].join("|");
  const cached = record.renderCache.get(component);
  if (cached?.key === cacheKey) return cached.lines;

  const foreignIndices = findForeignThinkingChildren(children, runs, width);
  if (foreignIndices.length === 0) return record.originalRender.call(component, width);

  // The update-time fold already rendered the reasoning; only remove the panel
  // the outer extension appended afterwards instead of folding a second time.
  if (record.states.get(component)?.folded) {
    const snapshot = [...children];
    const victimSet = new Set(foreignIndices);
    children.length = 0;
    children.push(...compactSpacers(snapshot.filter((_child, index) => !victimSet.has(index))));
    try {
      return record.originalRender.call(component, width);
    } finally {
      children.length = 0;
      children.push(...snapshot);
    }
  }

  const lines = runFoldedSection(component, record, {
    runs,
    children,
    foreignIndices,
    behavior,
    width,
    hasThinkingContent,
    labelFor,
  });
  if (!lines) return record.originalRender.call(component, width);
  record.renderCache.set(component, { key: cacheKey, lines });
  return lines;
}

interface ForeignFoldRequest {
  runs: NativeThinkingRun[];
  children: Component[];
  foreignIndices: number[];
  behavior: EffectiveThinkingDisplayBehavior;
  width: number;
  hasThinkingContent: boolean;
  labelFor: (canExpand: boolean) => string;
}

/**
 * Find children rendered by another thinking extension: either by component name
 * (`*Thinking*`/`*Reasoning*`) or because their rendered output still contains
 * the reasoning text.
 */
function findForeignThinkingChildren(
  children: Component[],
  runs: NativeThinkingRun[],
  width: number,
): number[] {
  const textNeedles = runs
    .map((run) => {
      const flat = normalizedProbeText(run.text);
      if (flat.length < 12) return flat;
      const length = Math.min(48, Math.max(12, Math.floor(flat.length / 2)));
      return flat.slice(0, length);
    })
    .filter((needle) => needle.length >= 12);

  return children.flatMap((child, index) => {
    if (!child || getMarkdownInternals(child)) return [];
    if (isForeignThinkingComponent(child)) return [index];
    return childDisplaysAny(child, textNeedles, true, width) ? [index] : [];
  });
}

function runFoldedSection(
  component: AssistantMessageComponent,
  record: PatchRecord,
  request: ForeignFoldRequest,
): string[] | undefined {
  const { runs, children, foreignIndices, behavior, width, hasThinkingContent, labelFor } = request;
  const internals = component as unknown as AssistantMessageInternals;
  const outputPad = typeof internals.outputPad === "number" ? internals.outputPad : 1;
  const template = findMarkdownTemplate(children);
  const context = new RenderedThinkingContext(
    behavior,
    record.options.previewLines,
    hasThinkingContent,
    labelFor,
  );
  const sections: RenderedThinkingSection[] = [];
  for (const run of runs) {
    const content = template
      ? cloneNativeMarkdown(template, run.text)
      : createPlainMarkdown(run.text, outputPad);
    if (!content) return undefined;
    const label = template
      ? cloneNativeMarkdown(template, "")
      : createPlainMarkdown("", outputPad);
    if (!label) return undefined;
    sections.push(new RenderedThinkingSection(content, label, context));
  }

  // The caller caches the final lines per component and message timestamp.
  const snapshot = [...children];
  const victimSet = new Set(foreignIndices);
  const kept = children.filter((_child, index) => !victimSet.has(index));
  children.length = 0;
  children.push(...kept);

  let nativeLines: string[];
  try {
    nativeLines = record.originalRender.call(component, width);
  } finally {
    children.length = 0;
    children.push(...snapshot);
  }

  let foldedLines: string[];
  try {
    foldedLines = sections.flatMap((section) => section.render(width));
  } catch {
    return undefined;
  }
  const merged = [...foldedLines, "", ...nativeLines];
  return merged;
}

function createPatchRecord(options: Partial<ThinkingFoldOptions>): PatchRecord {
  const prototype = AssistantMessageComponent.prototype;
  const originalUpdate = prototype.updateContent;
  const originalRender = prototype.render;
  const record: PatchRecord = {
    owners: 0,
    expanded: false,
    now: Date.now(),
    options: normalizedOptions(options),
    originalUpdate,
    originalRender,
    renderCache: new WeakMap(),
    messages: new Map(),
    states: new WeakMap(),
    components: new Set(),
    knownComponents: new WeakSet(),
    timings: new Map(),
    updateOptions(next) {
      this.options = normalizedOptions({ ...this.options, ...next });
      this.rerenderAll();
    },
    setExpanded(expanded) {
      if (this.expanded === expanded) return;
      this.expanded = expanded;
      this.rerenderAll();
    },
    setMessageTiming(timestamp, timing) {
      this.timings.set(timestamp, { ...timing });
      this.rerenderTimestamp(timestamp);
    },
    trackMessage(message) {
      this.currentMessage = message;
      this.messages.set(message.timestamp, message);
      if (this.messages.size > 50) {
        const oldest = this.messages.keys().next().value;
        if (oldest !== undefined) this.messages.delete(oldest);
      }
    },
    beginMessage(message, startedAt = Date.now()) {
      this.timings.set(message.timestamp, { startedAt });
      this.now = startedAt;
      this.rerenderTimestamp(message.timestamp);
    },
    completeMessage(message, completedAt = Date.now()) {
      const timing = this.timings.get(message.timestamp) ?? {
        startedAt: Math.min(message.timestamp, completedAt),
      };
      if (timing.completedAt !== undefined) return;
      this.timings.set(message.timestamp, { ...timing, completedAt });
      this.now = completedAt;
      // Ctrl+T is a persistent global display preference. Auto-collapse only
      // controls the folded representation; completing a later turn must not
      // override an explicit expanded choice.
      this.rerenderTimestamp(message.timestamp);
    },
    tick(now = Date.now()) {
      this.now = now;
      forEachLiveComponent(this, (component, state) => {
        const timestamp = state.fullMessage?.timestamp;
        if (timestamp === undefined || this.timings.get(timestamp)?.completedAt !== undefined) return;
        rebuild(component, state, this);
      });
    },
    rerenderAll() {
      forEachLiveComponent(this, (component, state) => rebuild(component, state, this));
    },
    rerenderTimestamp(timestamp) {
      forEachLiveComponent(this, (component, state) => {
        if (state.fullMessage?.timestamp === timestamp) rebuild(component, state, this);
      });
    },
  };

  prototype.updateContent = function (message: AssistantMessage, isStreaming?: boolean): void {
    const state = record.states.get(this) ?? {};
    if (isStreaming !== undefined) state.isStreaming = isStreaming;

    // Container.invalidate() passes Pi's last display-only marker clone back
    // through updateContent(). Never mistake that clone for session source data.
    if (message !== state.renderedMessage) state.fullMessage = message;

    record.states.set(this, state);
    if (!record.knownComponents.has(this)) {
      record.knownComponents.add(this);
      record.components.add(new WeakRef(this));
    }
    rebuild(this, state, record);
  };

  prototype.render = function (width: number): string[] {
    // A render-time fold must never be able to break Pi's TUI: any failure falls
    // back to the untouched native rendering.
    try {
      return renderWithForeignFold(this, record, width);
    } catch {
      return record.originalRender.call(this, width);
    }
  };

  setPatchRecord(record);
  return record;
}

export function installThinkingFoldPatch(
  options: Partial<ThinkingFoldOptions> = {},
): ThinkingFoldPatchHandle {
  const prototype = AssistantMessageComponent.prototype;
  if (typeof prototype.updateContent !== "function" || typeof prototype.render !== "function") {
    throw new Error("Pi's AssistantMessageComponent rendering API is unavailable");
  }

  const record = getPatchRecord() ?? createPatchRecord(options);
  record.owners += 1;
  record.updateOptions(options);
  let disposed = false;

  return {
    get expanded() {
      return record.expanded;
    },
    get options() {
      return { ...record.options };
    },
    updateOptions(next) {
      record.updateOptions(next);
    },
    setExpanded(expanded) {
      record.setExpanded(expanded);
    },
    toggle() {
      record.setExpanded(!record.expanded);
    },
    setMessageTiming(timestamp, timing) {
      record.setMessageTiming(timestamp, timing);
    },
    beginMessage(message, startedAt) {
      record.beginMessage(message, startedAt);
    },
    completeMessage(message, completedAt) {
      record.completeMessage(message, completedAt);
    },
    tick(now) {
      record.tick(now);
    },
    trackMessage(message) {
      record.trackMessage(message);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      record.owners -= 1;
      if (record.owners > 0 || getPatchRecord() !== record) return;

      prototype.updateContent = record.originalUpdate;
      prototype.render = record.originalRender;
      setPatchRecord(undefined);
      // Drop display clones and mouse callbacks that close over this record.
      forEachLiveComponent(record, (component, state) => {
        if (state.fullMessage) {
          record.originalUpdate.call(component, state.fullMessage, state.isStreaming);
        }
      });
    },
  };
}
