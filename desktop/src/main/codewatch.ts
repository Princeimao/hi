// The live code surface for a session: from Claude Code hook payloads.
// structuredPatch (documented hook field) gives real hunks — exact numbers,
// +/- lines — so the island shows what the agent is editing right now.
// Fallbacks: old/new strings for edits, the command itself for shells.

export interface CodeRow {
  /** one-based line number when known */
  n?: number;
  t: string;
  k: "ctx" | "add" | "del";
}

export interface CodeView {
  file: string;
  path: string;
  kind: "code" | "diff" | "shell";
  rows: CodeRow[];
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "replace_file_content"]);
const WRITE_TOOLS = new Set(["Write", "write_to_file", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "run_command"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function rowsFromStructuredPatches(patches: unknown): CodeRow[] {
  if (!Array.isArray(patches) || patches.length === 0) return [];
  const rows: CodeRow[] = [];
  for (const hunk of patches) {
    if (hunk === null || typeof hunk !== "object") continue;
    const h = hunk as { newStart?: unknown; lines?: unknown };
    const lines = Array.isArray(h.lines) ? (h.lines as string[]) : [];
    let n = Number(h.newStart ?? 1);
    for (const raw of lines) {
      const sign = typeof raw === "string" && raw[0] === "+" ? "add" : typeof raw === "string" && raw[0] === "-" ? "del" : "ctx";
      const t = typeof raw === "string" ? raw.slice(1) : "";
      if (sign === "del") {
        rows.push({ t, k: "del", n: Math.max(1, n) });
      } else {
        rows.push({ t, k: sign, n });
        n += 1;
      }
    }
  }
  return rows.slice(0, 240);
}

function numbered(text: string, start: number, k: CodeRow["k"]): CodeRow[] {
  const lines = text.replace(/\t/g, "  ").split(/\r?\n/);
  return lines.slice(0, 240).map((t, i) => ({ t, k, n: start + i }));
}

function plainSplit(text: string): string[] {
  return text.replace(/\t/g, "  ").split(/\r?\n/);
}

/** The view for one tool payload (PreToolUse sees the input, PostToolUse both). */
export function codeViewFrom(
  tool: string,
  input: Record<string, unknown> | null | undefined,
  toolResponse: unknown,
): CodeView | null {
  if (!input) return null;
  const fileRaw = [input["file_path"], input["path"], input["notebook_path"], input["filePath"]].map(str).find((s) => s.length > 0);
  const file = fileRaw ? fileRaw.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "" : "";

  if (SHELL_TOOLS.has(tool)) {
    const command = str(input["command"]).trim() || str(input["cmd"]);
    if (!command) return null;
    return {
      file: "",
      path: "",
      kind: "shell",
      rows: command.split(/\r?\n/).slice(0, 240).map((t) => ({ t, k: "ctx" as const })),
    };
  }

  if (WRITE_TOOLS.has(tool)) {
    const content = str(input["content"]) || str(input["new_string"]) || str(input["new_str"]);
    if (!content && !file) return null;
    return { file, path: fileRaw ?? "", kind: "code", rows: content ? numbered(content, 1, "add") : [] };
  }

  if (EDIT_TOOLS.has(tool)) {
    const oldText = str(input["old_string"]) || str(input["old_str"]);
    const newText = str(input["new_string"]) || str(input["new_str"]);
    // Claude Code documents tool_response.structuredPatch — real hunks.
    const patchRows = rowsFromStructuredPatches((toolResponse as { structuredPatch?: unknown } | null | undefined)?.structuredPatch);
    if (patchRows.length > 0) return { file, path: fileRaw ?? "", kind: "diff", rows: patchRows };
    const oldRows = oldText ? numbered(oldText, 1, "del") : [];
    const newRows = newText ? numbered(newText, 1, "add") : [];
    const rows = [...oldRows.slice(0, 120), ...newRows.slice(0, 120)];
    if (rows.length === 0) return null;
    return { file, path: fileRaw ?? "", kind: "diff", rows };
  }

  return null;
}
