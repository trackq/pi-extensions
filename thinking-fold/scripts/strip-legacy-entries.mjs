#!/usr/bin/env node
/**
 * Remove legacy `thinking-steps.*` custom entries from Pi session files.
 *
 * The retired `pi-thinking-steps` package appended one
 * `customType: "thinking-steps.rate-line"` entry after every assistant message
 * and rendered it as `in 1,030 tok/s · out 246 tok/s`. With the package gone the
 * entries are dead weight: they never enter the model context and only a loaded
 * renderer could ever show them again.
 *
 *   node thinking-fold/scripts/strip-legacy-entries.mjs                  # dry run
 *   node thinking-fold/scripts/strip-legacy-entries.mjs --apply           # rewrite, keep .bak
 *   node thinking-fold/scripts/strip-legacy-entries.mjs --apply --no-backup
 *   node thinking-fold/scripts/strip-legacy-entries.mjs --dir <sessions-dir>
 *
 * Rewriting is line-preserving: only the matching JSONL lines are dropped, every
 * other byte (including entry ids and parent links) stays exactly as it was.
 */
import { copyFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LEGACY_PREFIX = "thinking-steps.";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const backup = !args.includes("--no-backup");
const dirArgIndex = args.indexOf("--dir");
const configDir = process.env.PI_CONFIG_DIR?.trim() || join(homedir(), ".pi", "agent");
const sessionsDir = dirArgIndex >= 0 ? args[dirArgIndex + 1] : join(configDir, "sessions");

if (dirArgIndex >= 0 && !args[dirArgIndex + 1]) {
  console.error("--dir needs a path");
  process.exit(2);
}

function* walk(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

const isLegacyEntry = (line) => {
  if (!line.includes(LEGACY_PREFIX)) return false;
  try {
    const entry = JSON.parse(line);
    return (
      entry?.type === "custom" &&
      typeof entry.customType === "string" &&
      entry.customType.startsWith(LEGACY_PREFIX)
    );
  } catch {
    return false;
  }
};

const report = [];
let scanned = 0;
let touched = 0;
let removed = 0;
let saved = 0;

for (const path of walk(sessionsDir)) {
  scanned += 1;
  const original = readFileSync(path, "utf8");
  const lines = original.split("\n");
  const trailing = lines.at(-1) === "";
  const kept = [];
  let fileRemoved = 0;

  for (const line of lines) {
    if (line !== "" && isLegacyEntry(line)) {
      fileRemoved += 1;
      continue;
    }
    kept.push(line);
  }
  if (fileRemoved === 0) continue;

  const rebuilt = kept.join("\n");
  const finalText = trailing && !rebuilt.endsWith("\n") ? `${rebuilt}\n` : rebuilt;
  touched += 1;
  removed += fileRemoved;
  saved += Buffer.byteLength(original) - Buffer.byteLength(finalText);
  report.push({ path, fileRemoved, bytes: Buffer.byteLength(original) - Buffer.byteLength(finalText) });

  if (!apply) continue;
  if (backup) copyFileSync(path, `${path}.bak`);
  writeFileSync(path, finalText, "utf8");
}

const relative = (path) => path.replace(`${sessionsDir}/`, "");
report
  .sort((a, b) => b.fileRemoved - a.fileRemoved)
  .slice(0, 15)
  .forEach((row) => {
    console.log(`  ${String(row.fileRemoved).padStart(4)} lines  ${relative(row.path)}`);
  });
if (report.length > 15) console.log(`  … ${report.length - 15} more file(s)`);

const kib = (bytes) => `${(bytes / 1024).toFixed(0)} KiB`;
console.log(
  `\n${apply ? "Removed" : "Would remove"} ${removed} legacy entr${removed === 1 ? "y" : "ies"} ` +
    `from ${touched} of ${scanned} session file(s) (${kib(saved)} smaller).`,
);
if (!apply && removed > 0) {
  console.log(`Apply with: node ${import.meta.filename} --apply`);
}
