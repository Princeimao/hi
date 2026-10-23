// Shared bits for the integration browsers: loading, errors, rows, dots.
import React from "react";
import { ChevronLeft, Loader2, Lock } from "lucide-react";

export function Spinner(): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center py-8">
      <Loader2 className="h-4 w-4 animate-spin text-neutral-500" />
    </div>
  );
}

export function ErrorNote({ message }: { message: string }): React.ReactElement {
  return (
    <div className="m-2 rounded-lg border border-rose-400/25 bg-rose-400/10 px-2 py-1.5 text-[10px] text-rose-300">
      {message}
    </div>
  );
}

export function EmptyBox({ title, hint }: { title: string; hint?: string }): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-8 text-center">
      <div className="text-[11px] text-neutral-400">{title}</div>
      {hint ? <div className="text-[10px] text-neutral-600">{hint}</div> : null}
    </div>
  );
}

export function LockedNote({ what }: { what: string }): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 py-10 text-center">
      <Lock className="h-4 w-4 text-neutral-600" />
      <div className="text-[11px] text-neutral-400">{what} needs the token first</div>
    </div>
  );
}

const STATE_COLORS: Record<string, string> = {
  ready: "bg-emerald-400",
  completed: "bg-emerald-400",
  success: "bg-emerald-400",
  succeeded: "bg-emerald-400",
  error: "bg-rose-400",
  failed: "bg-rose-400",
  canceled: "bg-neutral-500",
  cancelled: "bg-neutral-500",
  building: "bg-amber-400",
  queued: "bg-amber-400",
  initialized: "bg-amber-400",
};

export function StateDot({ state }: { state: string | null | undefined }): React.ReactElement {
  const cls = STATE_COLORS[String(state ?? "").toLowerCase()] ?? "bg-neutral-500";
  return <span className={`inline-block h-1.5 w-1.5 flex-none rounded-full ${cls}`} />;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "green" | "amber" | "rose" | "violet" }): React.ReactElement {
  const tones = {
    neutral: "border-border/60 bg-neutral-800/60 text-neutral-400",
    green: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
    amber: "border-amber-400/25 bg-amber-400/10 text-amber-300",
    rose: "border-rose-400/25 bg-rose-400/10 text-rose-300",
    violet: "border-violet-400/25 bg-violet-400/10 text-violet-300",
  } as const;
  return (
    <span className={`inline-flex flex-none items-center gap-1 rounded border px-1 py-0 text-[9px] ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function BackBar({
  title,
  sub,
  onBack,
  right,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  onBack: () => void;
  right?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-none items-center gap-2 border-b border-border/50 px-2 py-1.5">
      <button
        type="button"
        onClick={onBack}
        className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-semibold text-neutral-100">{title}</div>
        {sub ? <div className="truncate text-[9px] text-neutral-500">{sub}</div> : null}
      </div>
      {right}
    </div>
  );
}

export function Row({
  onClick,
  children,
  active,
}: {
  onClick?: () => void;
  children: React.ReactNode;
  active?: boolean;
}): React.ReactElement {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
        onClick ? "hover:bg-neutral-800/60" : ""
      } ${active ? "bg-neutral-800/70" : ""}`}
    >
      {children}
    </Tag>
  );
}

export function openUrl(url: string): void {
  void window.hi?.openExternal?.(url);
}
