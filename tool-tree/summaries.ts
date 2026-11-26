/**
 * One-line summaries for tool calls.
 *
 * `context-mode` results carry `details: {}`, so summaries come from the call
 * arguments plus a light parse of the result text. Everything here is pure and
 * never throws: an unknown shape degrades to a generic label.
 */

export interface ToolSummary {
  /** Short subject shown after the tool label. */
  subject: string;
  /** Right-aligned metric: hits, lines, exit code, failure count … */
  meta?: string;
  /** Extra rows shown when the node is expanded. */
  details?: { label: string; value: string }[];
  /** Streamed/last result text, used for the expanded body. */
  output?: string;
}

export interface SummaryInput {
  toolName: string;
  args: unknown;
  resultText?: string;
  isError?: boolean;
  durationMs?: number;
  isPartial?: boolean;
}

const MAX_SUBJECT_WIDTH = 96;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    if (parts.length > 0) return parts.join(", ");
  }
  return undefined;
}

function firstLine(value: string): string {
  const line = value.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.trim();
}

function clamp(value: string, max = MAX_SUBJECT_WIDTH): string {
  const chars = Array.from(value.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

/** Keep the tail of a path, which is the part that identifies the file. */
function clampPath(value: string, max = 60): string {
  const chars = Array.from(value.replace(/\s+/g, " ").trim());
  return chars.length > max ? `…${chars.slice(chars.length - max + 1).join("")}` : chars.join("");
}

function countLines(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return value.replace(/\n+$/, "").split("\n").length;
}

function matchesLabel(count: number | undefined, singular: string, plural: string): string | undefined {
  if (count === undefined) return undefined;
  return `${count} ${count === 1 ? singular : plural}`;
}

function quoteList(values: string[], max = 2): string {
  const quoted = values.slice(0, max).map((value) => `"${clamp(value, 40)}"`);
  const rest = values.length - quoted.length;
  return rest > 0 ? `${quoted.join(", ")} +${rest}` : quoted.join(", ");
}

function linesLabel(count: number | undefined): string | undefined {
  if (count === undefined) return undefined;
  return `${count} line${count === 1 ? "" : "s"}`;
}

function lineCount(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const lines = text.replace(/\n+$/, "").split("\n");
  return lines.length;
}

function exitCode(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match = text.match(/\bexit(?:ed)?(?: with)?(?: code)?[ :]+(-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

/** `Query "…":` sections are how ctx_search reports per-query hits. */
function countQueries(text: string | undefined): { queries: number; hits: number } | undefined {
  if (!text) return undefined;
  const sections = [...text.matchAll(/^Query "(.+?)":\s*$/gm)];
  if (sections.length === 0) return undefined;
  return {
    queries: sections.length,
    hits: sections.length,
  };
}

function hostList(values: string[], max = 2): string {
  const hosts = values
    .map((value) => {
      try {
        return new URL(value).host;
      } catch {
        return value;
      }
    })
    .filter(Boolean);
  const shown = hosts.slice(0, max).join(", ");
  const rest = hosts.length - Math.min(hosts.length, max);
  return rest > 0 ? `${shown} +${rest}` : shown;
}

function sectionsAndSize(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const sections = text.match(/(\d+)\s+sections?/i);
  const size = text.match(/([\d.]+)\s*(KB|MB)/i);
  const parts = [sections ? `${sections[1]} sections` : undefined, size ? `${size[1]} ${size[2]}` : undefined]
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function genericSubject(toolName: string, args: unknown): string {
  const record = asRecord(args);
  if (!record) return "";
  for (const key of ["query", "path", "file", "pattern", "url", "command", "cmd", "name", "id"]) {
    const value = textOf(record[key]);
    if (value) return clamp(firstLine(value), 60);
  }
  try {
    return clamp(JSON.stringify(args), 60);
  } catch {
    return "";
  }
}

export function summarizeToolCall(input: SummaryInput): ToolSummary {
  const { toolName, args, resultText, isError } = input;
  const record = asRecord(args) ?? {};
  const details: { label: string; value: string }[] = [];
  const lines = lineCount(resultText);
  const failed = isError === true;

  const addDetails = (entries: (readonly [string, string | undefined])[]) => {
    for (const [label, value] of entries) {
      if (value && value.trim()) details.push({ label, value: value.trim() });
    }
  };

  switch (toolName) {
    case "ctx_search": {
      const queries = (Array.isArray(record.queries) ? record.queries : []).filter(
        (value): value is string => typeof value === "string",
      );
      const parsed = countQueries(resultText);
      addDetails([
        ["queries", queries.join("\n")],
        ["scope", textOf(record.scope)],
        ["source", textOf(record.source)],
      ]);
      return {
        subject: queries.length > 0 ? quoteList(queries) : textOf(record.query) ?? "search",
        meta:
          queries.length > 0
            ? `${queries.length} quer${queries.length === 1 ? "y" : "ies"}`
            : parsed
              ? `${parsed.hits} quer${parsed.hits === 1 ? "y" : "ies"}`
              : linesLabel(lines),
        details,
        output: resultText,
      };
    }
    case "ctx_execute":
    case "bash":
    case "powershell": {
      const command =
        textOf(record.command) ??
        textOf(record.cmd) ??
        textOf(record.script) ??
        textOf(record.code);
      const code = exitCode(resultText);
      addDetails([
        ["command", command],
        ["language", textOf(record.language)],
        ["cwd", textOf(record.cwd)],
      ]);
      return {
        subject: command ? clamp(firstLine(command), 64) : toolName,
        meta: [
          failed ? "failed" : code !== undefined ? `exit ${code}` : undefined,
          linesLabel(lines),
        ]
          .filter(Boolean)
          .join(" · ") || undefined,
        details,
        output: resultText,
      };
    }
    case "read": {
      const path = textOf(record.path) ?? textOf(record.file);
      const offset = typeof record.offset === "number" ? record.offset : undefined;
      const limit = typeof record.limit === "number" ? record.limit : undefined;
      const range =
        offset !== undefined || limit !== undefined
          ? `${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : "+"}`
          : undefined;
      addDetails([
        ["file", path],
        ["range", range],
      ]);
      return {
        subject: path ? clampPath(path) : "read",
        meta: [failed ? "failed" : undefined, linesLabel(lines)].filter(Boolean).join(" · ") || undefined,
        details,
        output: resultText,
      };
    }
    case "write": {
      const path = textOf(record.path) ?? textOf(record.file);
      const content = typeof record.content === "string" ? record.content : undefined;
      const written = countLines(content);
      addDetails([
        ["file", path],
        ["content", content],
      ]);
      return {
        subject: path ? clampPath(path) : "write",
        meta:
          [failed ? "failed" : undefined, written !== undefined ? `+${written} lines` : linesLabel(lines)]
            .filter(Boolean)
            .join(" · ") || undefined,
        details,
        output: resultText,
      };
    }
    case "edit": {
      const path = textOf(record.path) ?? textOf(record.file);
      const edits = Array.isArray(record.edits) ? record.edits : [];
      let added = 0;
      let removed = 0;
      for (const entry of edits) {
        const edit = asRecord(entry);
        if (!edit) continue;
        added += countLines(typeof edit.newText === "string" ? edit.newText : undefined) ?? 0;
        removed += countLines(typeof edit.oldText === "string" ? edit.oldText : undefined) ?? 0;
      }
      addDetails([
        ["file", path],
        ["blocks", edits.length > 0 ? `${edits.length} edit${edits.length === 1 ? "" : "s"}` : undefined],
      ]);
      return {
        subject: path ? clampPath(path) : "edit",
        meta: failed ? "failed" : `+${added} −${removed}`,
        details,
        output: resultText,
      };
    }
    case "grep": {
      const pattern = textOf(record.pattern);
      const noMatches = /no matches found/i.test(resultText ?? "");
      addDetails([
        ["pattern", pattern],
        ["path", textOf(record.path)],
        ["glob", textOf(record.glob)],
      ]);
      return {
        subject: pattern ? `"${clamp(pattern, 48)}"` : "grep",
        meta: [
          failed ? "failed" : undefined,
          noMatches ? "no matches" : matchesLabel(lines, "match", "matches"),
        ]
          .filter(Boolean)
          .join(" · ") || undefined,
        details,
        output: resultText,
      };
    }
    case "find": {
      const pattern = textOf(record.pattern);
      const none = /no files found/i.test(resultText ?? "");
      addDetails([
        ["pattern", pattern],
        ["path", textOf(record.path)],
      ]);
      return {
        subject: pattern ? `"${clamp(pattern, 48)}"` : "find",
        meta:
          [failed ? "failed" : undefined, none ? "no files" : matchesLabel(lines, "file", "files")]
            .filter(Boolean)
            .join(" · ") || undefined,
        details,
        output: resultText,
      };
    }
    case "ls": {
      const path = textOf(record.path);
      addDetails([["path", path]]);
      return {
        subject: path ? clampPath(path) : ".",
        meta: [failed ? "failed" : undefined, matchesLabel(lines, "entry", "entries")]
          .filter(Boolean)
          .join(" · ") || undefined,
        details,
        output: resultText,
      };
    }
    case "ctx_batch_execute": {
      const commands = Array.isArray(record.commands) ? record.commands : [];
      const entries = commands.map((entry) => asRecord(entry) ?? {});
      const labels = entries
        .map((entry) => textOf(entry.label) ?? textOf(entry.command))
        .filter((value): value is string => Boolean(value));
      addDetails([
        ["commands", entries.map((entry) => `${textOf(entry.label) ?? "?"}: ${textOf(entry.command) ?? ""}`).join("\n")],
        ["language", textOf(record.language)],
      ]);
      const failedBatches = (resultText?.match(/\b(?:error|failed|exit code [1-9])/gi) ?? []).length;
      return {
        subject:
          labels.length > 0
            ? labels.length <= 2
              ? quoteList(labels, 2).replace(/"/g, "")
              : `${labels[0].replace(/"/g, "")} +${labels.length - 1}`
            : `${commands.length} commands`,
        meta: [
          commands.length > 0 ? `${commands.length} cmd${commands.length === 1 ? "" : "s"}` : undefined,
          failed || failedBatches > 0 ? "failed" : undefined,
          linesLabel(lines),
        ]
          .filter(Boolean)
          .join(" · ") || undefined,
        details,
        output: resultText,
      };
    }
    case "ctx_batch": {
      const calls = Array.isArray(record.calls) ? record.calls : [];
      const names = calls
        .map((call) => {
          const entry = asRecord(call);
          return entry ? textOf(entry.tool) ?? textOf(entry.name) : undefined;
        })
        .filter((value): value is string => Boolean(value));
      addDetails([["calls", names.join(", ")]]);
      return {
        subject: names.length > 0 ? quoteList(names, 3) : `${calls.length} calls`,
        meta: linesLabel(lines),
        details,
        output: resultText,
      };
    }
    case "ctx_execute_file":
    case "ctx_index":
    case "ctx_fetch_and_index":
    case "fetch_content": {
      const requestUrls = (Array.isArray(record.requests) ? record.requests : [])
        .map((entry) => asRecord(entry)?.url)
        .filter((value): value is string => typeof value === "string");
      const urls = [
        ...(Array.isArray(record.urls) ? record.urls : []),
        ...(typeof record.url === "string" ? [record.url] : []),
        ...requestUrls,
      ].filter((value): value is string => typeof value === "string");
      const sources = (Array.isArray(record.requests) ? record.requests : [])
        .map((entry) => asRecord(entry)?.source)
        .filter((value): value is string => typeof value === "string");
      if (sources.length > 0) addDetails([["sources", sources.join(", ")]]);
      const path = textOf(record.path) ?? textOf(record.file);
      addDetails([
        ["source", path ?? urls.join("\n")],
        ["mode", textOf(record.mode)],
      ]);
      return {
        subject: path ? clamp(path, 64) : urls.length > 0 ? hostList(urls) : "fetch",
        meta: sectionsAndSize(resultText) ?? (linesLabel(lines)),
        details,
        output: resultText,
      };
    }
    case "web_search": {
      const queries = (Array.isArray(record.queries) ? record.queries : [record.query]).filter(
        (value): value is string => typeof value === "string",
      );
      const resultCount = resultText?.match(/(\d+)\s+(?:results?|hits?)/i);
      addDetails([["queries", queries.join("\n")]]);
      return {
        subject: queries.length > 0 ? quoteList(queries) : "web search",
        meta: resultCount ? `${resultCount[1]} results` : linesLabel(lines),
        details,
        output: resultText,
      };
    }
    case "ctx_resume": {
      addDetails([["scope", textOf(record.scope)]]);
      return { subject: "resume context", meta: linesLabel(lines), details, output: resultText };
    }
    case "ctx_doctor":
    case "ctx_upgrade":
      return { subject: toolName === "ctx_doctor" ? "health check" : "upgrade", meta: linesLabel(lines), details, output: resultText };
    default: {
      const subject = genericSubject(toolName, args);
      const errorLine = failed ? firstLine(resultText ?? "") : undefined;
      return {
        subject: subject || toolName,
        meta: errorLine
          ? clamp(errorLine, 32)
          : failed
            ? "failed"
            : linesLabel(lines),
        details,
        output: resultText,
      };
    }
  }
}

/** Rows for the expanded body: command/args, then a preview or full output. */
export function expandedDetailRows(
  summary: ToolSummary,
  options: { previewLines: number; expanded: boolean },
): { label: string; value: string }[] {
  const rows = [...(summary.details ?? [])];
  const output = summary.output?.trim();
  if (!output) return rows;

  const lines = output.split("\n");
  const limit = options.expanded ? lines.length : Math.min(options.previewLines, lines.length);
  const preview = lines.slice(0, limit).join("\n");
  const remaining = lines.length - limit;
  rows.push({
    label: "output",
    value: remaining > 0 ? `${preview}\n… ${remaining} more line${remaining === 1 ? "" : "s"}` : preview,
  });
  return rows;
}
