// Structured tool-result cards. The server emits chat.tool.result with the raw
// output; this component detects what kind of result it is and renders it with
// the right reactbits component instead of dumping text into the chat bubble.
import React, { useState } from "react";
import { Folder, FileText, Terminal, Code2, Trash2 } from "lucide-react";
import BranchedMenu, { type BranchedMenuItem } from "./BranchedMenu";
import SwipeRow, { type SwipeAction } from "./SwipeRow";

export interface ToolCardData {
  tool: string;
  label: string;
  ok: boolean;
  output: string;
}

interface FileEntry {
  name: string;
  isDir: boolean;
  size?: string;
  date?: string;
}

/** Parse a Windows `dir` listing or a simple file list into entries. */
function parseFileList(output: string): FileEntry[] | null {
  const entries: FileEntry[] = [];
  const dirRe = /<DIR>\s+(.+)$/i;
  const fileRe = /^\s*[\d,]+\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s+(.+)$/i;
  for (const line of output.split("\n")) {
    const d = dirRe.exec(line);
    if (d) {
      const name = d[1].trim();
      if (name && name !== "." && name !== "..") entries.push({ name, isDir: true });
      continue;
    }
    const f = fileRe.exec(line);
    if (f) {
      entries.push({ name: f[3].trim(), isDir: false, date: `${f[1]} ${f[2]}` });
      continue;
    }
    // fallback: bare filename on its own line
    const bare = line.trim();
    if (bare && !/^(Volume|Directory|File\(s\)|bytes|<|---)/i.test(bare) && bare.length < 120 && !bare.includes(" ")) {
      entries.push({ name: bare, isDir: false });
    }
  }
  return entries.length ? entries : null;
}

/** Build BranchedMenu items from parsed entries, grouped root + children. */
function toBranchedItems(entries: FileEntry[], rootLabel: string): BranchedMenuItem[] {
  return [
    {
      label: rootLabel,
      children: entries.map((e) => ({
        value: e.name,
        label: e.isDir ? `${e.name}/` : e.name,
        icon: (e.isDir ? Folder : FileText) as never,
      })),
    },
  ];
}

/** Detect the kind of tool output. */
function detectKind(t: ToolCardData): "files" | "todos" | "code" | "terminal" {
  const o = t.output;
  if (/<DIR>|Directory of|Volume in drive|File\(s\)/i.test(o)) return "files";
  if (/^\s*[-*]\s+\[.\]\s+/m.test(o) || /todo/i.test(t.label)) return "todos";
  if (/```|function |const |import |class |def /i.test(o)) return "code";
  return "terminal";
}

export function ToolCard({ card }: { card: ToolCardData }): React.ReactElement | null {
  const [items] = useState(() => {
    const kind = detectKind(card);
    if (kind === "files") {
      const entries = parseFileList(card.output);
      if (!entries) return null;
      return { kind, menu: toBranchedItems(entries, card.label) };
    }
    if (kind === "todos") {
      const todos = card.output
        .split("\n")
        .map((l) => l.replace(/^\s*[-*]\s+\[[ x]\]\s*/, "").trim())
        .filter(Boolean);
      return { kind, todos };
    }
    return { kind, text: card.output };
  });

  if (!items) return null;

  if (items.kind === "files") {
    return (
      <div className="self-start rounded-xl border border-border/60 bg-card/70 px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] text-neutral-400">
          <Folder className="h-3 w-3" />
          {card.label}
        </div>
        <BranchedMenu
          items={items.menu}
          defaultOpen={0}
          width={260}
          rowHeight={30}
          fontSize={12}
          color="#d4d4d8"
          accentColor="#a78bfa"
          lineColor="#3f3f46"
        />
      </div>
    );
  }

  if (items.kind === "todos") {
    const actions: SwipeAction[] = [{ id: "done", label: "Done", color: "#059669" }];
    return (
      <div className="flex w-full max-w-[280px] flex-col gap-1.5 self-start">
        <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
          <Trash2 className="h-3 w-3" />
          {card.label} — swipe to complete
        </div>
        {items.todos.map((t, i) => (
          <SwipeRow
            key={i}
            actions={actions}
            height={38}
            radius={10}
            actionWidth={70}
            rowColor="#1c1c1f"
            drawerColor="#27272a"
            textColor="#e4e4e7"
            label={t}
          >
            <span className="truncate text-xs">{t}</span>
          </SwipeRow>
        ))}
      </div>
    );
  }

  if (items.kind === "code") {
    return (
      <div className="max-w-full self-start overflow-hidden rounded-xl border border-border/60 bg-card/70">
        <div className="flex items-center gap-1.5 border-b border-border/40 px-2.5 py-1 text-[10px] text-neutral-400">
          <Code2 className="h-3 w-3" />
          {card.label}
        </div>
        <pre className="max-h-40 overflow-auto px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-neutral-300">
          {items.text.slice(0, 2000)}
        </pre>
      </div>
    );
  }

  return (
    <div className="max-w-full self-start overflow-hidden rounded-xl border border-border/60 bg-card/70">
      <div className="flex items-center gap-1.5 border-b border-border/40 px-2.5 py-1 text-[10px] text-neutral-400">
        <Terminal className="h-3 w-3" />
        {card.label}
      </div>
      <pre className="max-h-32 overflow-auto px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-neutral-400">
        {items.text.slice(0, 1500)}
      </pre>
    </div>
  );
}
