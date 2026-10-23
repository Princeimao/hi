// Port of mu/windows/src-tauri/src/config_file.rs — everything filesystem-shaped
// lives here: strict read, diff, dated backup that must succeed, fingerprint
// check, atomic write. The rule is strict: nothing is overwritten before a diff
// the user has looked at, and only what was looked at is written.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export function read(pathname: string): Buffer | null {
  try {
    return fs.readFileSync(pathname);
  } catch {
    return null;
  }
}

/// Strips a UTF-8 BOM (PowerShell 5 writes one) and parses an object.
function textOf(bytes: Buffer | null): string {
  if (bytes === null) return "";
  const str = bytes.toString("utf8");
  return bytes.subarray(0, 3).equals(BOM) ? str.slice(1) : str;
}

export function tryParse(bytes: Buffer | null): Record<string, unknown> | null {
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(textOf(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function fingerprint(bytes: Buffer | null): string {
  return createHash("sha256").update(bytes ?? Buffer.alloc(0)).digest("hex").slice(0, 16);
}

export function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function backupPath(forFile: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 23);
  const ext = path.extname(forFile);
  return `${forFile}.${stamp}${ext || ".bak"}.backup`;
}

export type EditOutcome = { value: string | null } | { error: string };

export interface EditContext {
  bytes: Buffer | null;
  /** Parsed JSON object, or null when the file is absent or not an object. */
  parsed: Record<string, unknown> | null;
  /** The current text (BOM stripped). */
  text: string;
  /** A short name for messages ("settings.json"). */
  label: string;
}

export interface FileEdit {
  path: string;
  edit: (current: EditContext) => EditOutcome;
}

export interface Plan {
  path: string;
  /** Diff preview (line-level, main file). */
  diff: string;
  /** Where the backup would go (main file). */
  backup: string;
  /** Identifies the main file's bytes this diff was computed from. */
  fingerprint: string;
  /** Files touched, one per line (for agents with several). */
  files: string[];
  /** Per-file fingerprints, same order as `files` (multi-file plans apply together). */
  fingerprints: string[];
}

function diffText(before: string, after: string): string {
  const a = before.length === 0 ? ["<none>"] : before.split("\n");
  const b = after.split("\n");
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < b.length) {
      lines.push(`+ ${b[j]}`);
      j++;
    } else {
      lines.push(`- ${a[i]}`);
      i++;
    }
  }
  return lines.slice(0, 200).join("\n");
}

/// The plan for a set of edits: the diff and fingerprint the user confirms.
export function preview(edits: FileEdit[]): Plan {
  if (edits.length === 0) throw new Error("no edits to plan");
  const main = edits[0];
  const results = edits.map((e) => {
    const bytes = read(e.path);
    const context: EditContext = {
      bytes,
      parsed: tryParse(bytes),
      text: textOf(bytes),
      label: path.basename(e.path),
    };
    return e.edit(context);
  });
  for (const r of results) {
    if ("error" in r) throw new Error(r.error);
  }
  const current = read(main.path);
  const fingerprints = edits.map((e) => fingerprint(read(e.path)));
  const beforeText = current === null ? "<none>" : textOf(current);
  const outcome = results[0] as { value: string | null };
  const afterText = outcome.value === null ? "<removed>" : outcome.value;
  return {
    path: main.path,
    diff: diffText(beforeText, afterText) || "(no changes)",
    backup: backupPath(main.path),
    fingerprint: fingerprints[0],
    files: edits.map((e) => e.path),
    fingerprints,
  };
}

/// Applies the plan after a dated backup that must succeed. `isFingerprint` is
/// the one the preview was computed from (or, for multi-file plans, one per
/// file in the same order): a file that changed in between is refused rather
/// than overwritten. Returns the backups taken, one per line.
export function apply(edits: FileEdit[], isFingerprint: string | string[]): string[] {
  const fps = Array.isArray(isFingerprint) ? isFingerprint : edits.map(() => isFingerprint);
  const backups: string[] = [];
  for (const [index, edit] of edits.entries()) {
    const current = read(edit.path);
    if (fingerprint(current) !== fps[index]) {
      throw new Error(`${path.basename(edit.path)} changed since the preview — take a new look before writing.`);
    }
    const context: EditContext = {
      bytes: current,
      parsed: tryParse(current),
      text: textOf(current),
      label: path.basename(edit.path),
    };
    const outcome = edit.edit(context);
    if ("error" in outcome) throw new Error(outcome.error);
    const dir = path.dirname(edit.path);
    fs.mkdirSync(dir, { recursive: true });
    if (current !== null) {
      const backup = backupPath(edit.path);
      fs.writeFileSync(backup, current);
      backups.push(backup);
    }
    if (outcome.value === null) {
      try {
        fs.rmSync(edit.path, { force: true });
      } catch {
        // A file that is already gone is fine.
      }
    } else {
      writeAtomic(edit.path, outcome.value);
    }
  }
  return backups;
}

/// The new contents land beside the file and are renamed over it: a process
/// reading at that moment sees either the old or the new, never half of one.
function writeAtomic(target: string, contents: string): void {
  const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, contents, "utf8");
  fs.renameSync(temp, target);
}
