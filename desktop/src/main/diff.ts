// File-edit accounting for PostToolUse events, ported from Coucou's
// `recap.rs::file_change` + `line_diff` (MIT © 2026 Louis Raillé): CRLF-safe
// line splitting, LCS-based added/removed counts with the same size limits
// (past the limits every old line counts as removed, every new one as added).

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

const DIFF_MAX_BYTES = 200 * 1024;
const DIFF_MAX_LINES = 4000;
const DIFF_MAX_CELLS = 1_000_000;

/** CRLF → LF, no trailing empty line. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function count(n: number): number {
  return Math.min(n, Number.MAX_SAFE_INTEGER);
}

/** Lines added and removed between `old` and `new`, computed from their
 *  longest common subsequence — the counts mu's DiffEngine reports. */
export function lineDiff(oldText: string, newText: string): [number, number] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const fallback: [number, number] = [count(b.length), count(a.length)];
  if (
    oldText.length + newText.length > DIFF_MAX_BYTES ||
    a.length + b.length > DIFF_MAX_LINES ||
    a.length * b.length > DIFF_MAX_CELLS
  ) {
    return fallback;
  }
  let prev = new Array<number>(b.length + 1).fill(0);
  let row = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    for (let j = 0; j < b.length; j++) {
      row[j + 1] = x === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], row[j]);
    }
    [prev, row] = [row, prev];
  }
  const lcs = prev[b.length];
  return [count(b.length - lcs), count(a.length - lcs)];
}

/** The file an Edit, MultiEdit or Write touched, or null for other tools and
 *  no-op edits. Recognises the exact payloads Claude's tools send. */
export function fileChange(tool: string, input: Record<string, unknown> | null | undefined): FileChange | null {
  if (!input || typeof input !== "object") return null;
  const path = typeof input["file_path"] === "string" ? (input["file_path"] as string) : null;
  if (!path) return null;
  let added = 0;
  let removed = 0;
  if (tool === "Edit" || tool === "NotebookEdit") {
    const oldText = input["old_string"];
    const newText = input["new_string"];
    if (typeof oldText !== "string" || typeof newText !== "string") return null;
    [added, removed] = lineDiff(oldText, newText);
  } else if (tool === "MultiEdit") {
    const edits = Array.isArray(input["edits"]) ? (input["edits"] as unknown[]) : [];
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue;
      const e = edit as Record<string, unknown>;
      const oldText = typeof e["old_string"] === "string" ? e["old_string"] : "";
      const newText = typeof e["new_string"] === "string" ? e["new_string"] : "";
      const [da, dr] = lineDiff(oldText, newText);
      added += da;
      removed += dr;
    }
  } else if (tool === "Write") {
    const content = input["content"];
    if (typeof content !== "string") return null;
    added = count(splitLines(content).length);
    removed = 0;
  } else {
    return null;
  }
  if (added === 0 && removed === 0) return null;
  return { path, added, removed };
}

/** The island-only label: basename with a short parent hint, numbers first. */
export function editLabel(change: FileChange, cwd?: string): string {
  let shown = change.path;
  if (cwd && showRelative(cwd)) shown = change.path.startsWith(cwd) ? change.path.slice(cwd.length).replace(/^[\\/]/, "") : change.path;
  return `✎ ${shown} +${change.added} −${change.removed}`;
}

function showRelative(cwd: string): boolean {
  return cwd.length > 0 && cwd.length < 200;
}
