// Sessions: agent rail + live code card, all shadcn/tailwind — avatar chip,
// tool steps with lucide icons, structuredPatch diff rows in the code viewer.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { BookOpen, CloudDownload, PenLine, Search, SquareTerminal, CheckCircle2, CircleDashed, ListChecks, Bot, MessageSquareWarning, Radio } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import AnimatedList from "@/components/AnimatedList";
import { DotPattern } from "@/components/ui/dot-pattern";
import type { SessionView, SettingsStatus } from "../api";
import { agentColor, agentName, WATCHED_AGENTS } from "../../main/agents-meta";
import { cn } from "@/lib/utils";

function extLang(file: string): string {
  const dot = file.lastIndexOf(".");
  const ext = dot >= 0 ? file.slice(dot + 1).toLowerCase() : "";
  return ext ? ext.toUpperCase().slice(0, 4) : "TXT";
}

function stepMeta(label: string): { icon: React.ReactNode; cls: string } {
  if (label.startsWith("Runs")) return { icon: <SquareTerminal className="h-3 w-3" />, cls: "text-primary" };
  if (label.startsWith("Edits") || label.startsWith("Writes")) return { icon: <PenLine className="h-3 w-3" />, cls: "text-amber-400" };
  if (label.startsWith("Searches")) return { icon: <Search className="h-3 w-3" />, cls: "text-emerald-400" };
  if (label.startsWith("Reads")) return { icon: <BookOpen className="h-3 w-3" />, cls: "text-emerald-400" };
  if (label.startsWith("Fetches")) return { icon: <CloudDownload className="h-3 w-3" />, cls: "text-emerald-400" };
  if (label.startsWith("Needs input")) return { icon: <MessageSquareWarning className="h-3 w-3" />, cls: "text-rose-400" };
  if (label.startsWith("Tasks")) return { icon: <ListChecks className="h-3 w-3" />, cls: "text-neutral-300" };
  return { icon: <CircleDashed className="h-3 w-3" />, cls: "text-neutral-400" };
}

export function SessionsPanel({ sessions }: { sessions: SessionView[] }): React.ReactElement {
  const active =
    sessions.find((s) => s.status === "working" || s.status === "thinking") ?? sessions[0];

  if (!active) {
    return <SessionsEmpty liveIds={sessions.map((s) => s.agent ?? "claude")} />;
  }
  return <SessionCard session={active} count={sessions.length} />;
}

function SessionsEmpty({ liveIds }: { liveIds: string[] }): React.ReactElement {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  useEffect(() => {
    void window.hi.status().then(setStatus).catch(() => setStatus(null));
  }, []);
  const live = new Set(liveIds);
  const installedMap = new Map<string, boolean>();
  if (status?.claude) installedMap.set("claude", status.claude.installed);
  for (const a of status?.agents ?? []) installedMap.set(a.id, a.installed);
  const rows = WATCHED_AGENTS.map((id) => {
    const installed = installedMap.get(id) ?? false;
    const connected = live.has(id);
    return { id, installed, connected };
  });

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden rounded-xl border bg-card/60">
      <DotPattern className="[mask-image:radial-gradient(280px_circle_at_center,white,transparent)] opacity-50" />
      <div className="absolute inset-0 flex flex-col gap-3 overflow-y-auto p-4">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-violet-400" />
          <div>
            <div className="text-sm font-medium">Watching your agents</div>
            <div className="text-[11px] text-neutral-400">
              Open any of these and the session lands here live. Nothing is running right now.
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {rows.map((r) => (
            <div
              key={r.id}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-2 py-1.5",
                r.connected ? "border-emerald-400/40 bg-emerald-400/10" : "border-border/40 bg-card/40",
              )}
            >
              <span
                className={cn("h-2 w-2 flex-none rounded-full", r.connected ? "bg-emerald-400 animate-pulse" : r.installed ? "bg-neutral-500" : "bg-neutral-700")}
              />
              <span className="truncate text-[10.5px] text-neutral-200">{agentName(r.id)}</span>
              <span className="ml-auto text-[9px] text-neutral-500">
                {r.connected ? "live" : r.installed ? "ready" : "—"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SessionCard({ session, count }: { session: SessionView; count: number }): React.ReactElement {
  const label = session.agent ? agentName(session.agent) : "Claude Code";
  const color = agentColor(session.agent ?? "claude");
  const shownSteps = session.steps.slice(-6);
  const code = session.code;
  const relPath =
    code?.path && session.cwd && code.path.toLowerCase().startsWith(session.cwd.toLowerCase())
      ? code.path.slice(session.cwd.length).replace(/^[\\/]/, "")
      : code?.path ?? "";
  const live = session.status === "working" || session.status === "thinking";
  const rowsRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (rowsRef.current) rowsRef.current.scrollTop = rowsRef.current.scrollHeight;
  }, [code?.rows.length]);

  return (
    <div className="flex flex-1 min-h-0 gap-2">
      {/* agent rail */}
      <div className="flex w-[168px] flex-none flex-col gap-2">
        <div className="relative rounded-xl border bg-card p-3">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: color }}>
              <span className={cn("block h-2.5 w-2 h-2.5 rounded-full bg-neutral-950", live && "animate-pulse")} style={{ marginRight: -4 }} />
              <span className="block h-2.5 w-2 h-2.5 rounded-full bg-neutral-950" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold text-neutral-200">hi</div>
              <div className="truncate text-[10px] text-neutral-400">{label}</div>
            </div>
          </div>
          <Badge variant={live ? "default" : "secondary"} className="mt-2 text-[10px]">
            {live ? "working" : session.status}
          </Badge>
          {count > 1 ? <div className="mt-1 text-[10px] text-neutral-500">{count - 1} other session(s)</div> : null}
        </div>
        <ScrollArea className="flex-1 min-h-0 rounded-xl border bg-card">
          <div className="flex flex-col gap-1 p-2">
            <AnimatedList
              items={shownSteps}
              animation="slide"
              stagger={0.04}
              displayScrollbar={false}
              className="min-h-0"
              itemClassName="flex items-center gap-2 rounded-lg px-2 py-1 text-[10.5px] text-neutral-300 hover:bg-accent"
              renderItem={(item) => {
                const k = stepMeta(String(item));
                return (
                  <>
                    <span className={cn("flex-none", k.cls)}>{k.icon}</span>
                    <span className="truncate">{String(item)}</span>
                  </>
                );
              }}
            />
            {live ? (
              <div className="flex items-center gap-2 px-2 py-1 text-[10.5px] text-neutral-500">
                <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.1, ease: "linear" }}>
                  <CircleDashed className="h-3 w-3" />
                </motion.span>
                working…
              </div>
            ) : session.finalLine ? (
              <div className="mt-1 flex items-start gap-2 rounded-lg bg-emerald-500/10 px-2 py-1.5 text-[10.5px] text-emerald-300">
                <CheckCircle2 className="mt-0.5 h-3 w-3 flex-none" />
                <span className="line-clamp-2">{session.finalLine.slice(0, 90)}</span>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </div>

      {/* code card */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
        {code ? (
          <>
            <div className="flex items-center gap-2 border-b bg-secondary/40 px-3 py-2">
              <Badge variant="secondary" className="text-[9px] tracking-wide">{code.kind === "shell" ? "SH" : extLang(code.file)}</Badge>
              <span className="text-xs font-semibold">{code.kind === "shell" ? "shell" : code.file}</span>
              {live ? <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" /> : null}
              <span className="ml-auto max-w-[45%] truncate text-[10px] text-neutral-500">{relPath}</span>
            </div>
            <ScrollArea className="flex-1 min-h-0">
              <div ref={rowsRef} className="font-mono text-[11px] leading-[19px]">
                {code.rows.slice(-38).map((row, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0.4, x: row.k === "add" ? 10 : row.k === "del" ? -10 : 0 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.25, ease: "easeOut" }}
                    className={cn(
                      "flex px-2",
                      row.k === "add" && "border-l-2 border-emerald-500 bg-emerald-500/10 pl-2",
                      row.k === "del" && "border-l-2 border-rose-500 bg-rose-500/10 pl-2",
                    )}
                  >
                    <span className="w-9 flex-none pr-3 text-right text-[9px] text-neutral-600">{row.n ?? ""}</span>
                    <span className={cn("text-neutral-300", row.k === "del" && "text-rose-200/80 line-through")}>{row.t || " "}</span>
                  </motion.div>
                ))}
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <Bot className="h-4 w-4 text-neutral-500" />
              <span className="line-clamp-1">{session.finalLine || session.steps[session.steps.length - 1] || "Working…"}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
