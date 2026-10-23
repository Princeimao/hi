// Integrations tab — a grid of service cards; a connected card opens a real
// in-app browser (repos, files, pages, deployments, bookings, voices). Tokens
// are added right on the card; nothing here is a dead-end link.
import React, { useCallback, useEffect, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Circle,
  ExternalLink,
  GitBranch,
  KeyRound,
  Link2,
  Loader2,
  ShieldCheck,
  Sparkles,
  Unlink,
  ChevronRight,
} from "lucide-react";
import { integration, type IntegrationInfo } from "../../api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GitHubBrowser } from "./github";
import { VercelBrowser } from "./vercel";
import { NotionBrowser } from "./notion";
import { CalBrowser } from "./calcom";
import { ElevenLabsBrowser } from "./elevenlabs";
import { openUrl, timeAgo } from "./shared";

const SERVICES: {
  id: string;
  name: string;
  placeholder: string;
  help: string;
  createUrl: string;
  ask: string;
  icon: React.ElementType;
}[] = [
  {
    id: "github",
    name: "GitHub",
    placeholder: "ghp_…",
    help: "github.com/settings/tokens",
    createUrl: "https://github.com/settings/personal-access-tokens/new",
    ask: "browse repos · read files · PRs, issues, commits",
    icon: GitBranch,
  },
  {
    id: "vercel",
    name: "Vercel",
    placeholder: "vrc_…",
    help: "vercel.com/account/tokens",
    createUrl: "https://vercel.com/account/tokens",
    ask: "projects · live deployments & status",
    icon: Sparkles,
  },
  {
    id: "notion",
    name: "Notion",
    placeholder: "secret_…",
    help: "notion.so/my-integrations",
    createUrl: "https://www.notion.so/my-integrations",
    ask: "search workspace · read pages in-app",
    icon: Circle,
  },
  {
    id: "calcom",
    name: "Cal.com",
    placeholder: "cal_…",
    help: "app.cal.com/settings/developer/api-keys",
    createUrl: "https://app.cal.com/settings/developer/api-keys",
    ask: "agenda · upcoming bookings & attendees",
    icon: Link2,
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    placeholder: "sk_…",
    help: "elevenlabs.io/app/settings/api-keys",
    createUrl: "https://elevenlabs.io/app/settings/api-keys",
    ask: "voice library · preview voices in-app",
    icon: BookOpen,
  },
];

const GRID_SIZE = { w: 720, h: 380 };
const DETAIL_SIZE = { w: 900, h: 580 };

export function IntegrationsPanel(): React.ReactElement {
  const [rows, setRows] = useState<IntegrationInfo[]>([]);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void integration.list().then(setRows);
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    const size = open ? DETAIL_SIZE : GRID_SIZE;
    void window.hi?.expand?.(size.w, size.h);
    return () => {
      void window.hi?.expand?.(GRID_SIZE.w, GRID_SIZE.h);
    };
  }, [open]);

  const connected = (service: string): IntegrationInfo | undefined => rows.find((r) => r.service === service);

  async function connect(service: string): Promise<void> {
    setBusy(service);
    setError(null);
    try {
      const token = (tokens[service] ?? "").trim();
      if (!token) throw new Error("Paste the token first");
      await integration.connect(service, token);
      refresh();
      setTokens((t) => ({ ...t, [service]: "" }));
    } catch (err) {
      setError(`${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(service: string): Promise<void> {
    setBusy(service);
    await integration.disconnect(service);
    setOpen(null);
    refresh();
    setBusy(null);
  }

  // ── Detail browsers ────────────────────────────────────────────────────────
  if (open === "github") return <GitHubBrowser onBack={() => setOpen(null)} onUnlink={() => void disconnect("github")} />;
  if (open === "vercel") return <VercelBrowser onBack={() => setOpen(null)} />;
  if (open === "notion") return <NotionBrowser onBack={() => setOpen(null)} />;
  if (open === "calcom") return <CalBrowser onBack={() => setOpen(null)} />;
  if (open === "elevenlabs") return <ElevenLabsBrowser onBack={() => setOpen(null)} />;

  // ── Service grid ───────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <div>
          <div className="text-[13px] font-semibold text-neutral-100">Services</div>
          <div className="flex items-center gap-1 text-[10px] text-neutral-500">
            <ShieldCheck className="h-3 w-3" /> tokens stay on your server, encrypted · browse everything in-app
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border/60 bg-card/40 p-2">
        <div className="grid grid-cols-2 gap-2">
          {SERVICES.map((s) => {
            const info = connected(s.id);
            const Icon = s.icon;
            const linked = Boolean(info?.connected);
            const cardError = error && error.toLowerCase().startsWith(s.id) ? error.slice(s.id.length + 2) : null;
            return (
              <div
                key={s.id}
                className={`flex flex-col gap-2 rounded-xl border border-border/60 bg-neutral-900/40 p-2.5 transition-colors ${
                  linked ? "cursor-pointer hover:border-violet-400/30 hover:bg-neutral-900/70" : ""
                }`}
                onClick={linked ? () => setOpen(s.id) : undefined}
              >
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-border/50 bg-neutral-800/80">
                    <Icon className="h-4 w-4 text-neutral-200" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-semibold text-neutral-100">{s.name}</span>
                      {linked ? (
                        <Badge className="gap-1 border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0 text-[9px] text-emerald-300">
                          <CheckCircle2 className="h-2.5 w-2.5" /> {info?.account || "linked"}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="px-1.5 py-0 text-[9px] text-neutral-500">
                          not linked
                        </Badge>
                      )}
                    </div>
                    <div className="truncate text-[10px] text-neutral-500">{s.ask}</div>
                  </div>
                </div>

                {linked ? (
                  <div className="flex items-center justify-between rounded-lg border border-border/40 bg-neutral-950/40 px-2 py-1.5">
                    <span className="flex items-center gap-1.5 text-[10px] text-neutral-300">
                      <BookOpen className="h-3 w-3 text-violet-300" />
                      Open browser
                      {info?.updatedAt ? <span className="text-neutral-600">· updated {timeAgo(info.updatedAt)}</span> : null}
                    </span>
                    <span className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void disconnect(s.id);
                        }}
                        className="flex h-5 w-5 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-rose-300"
                        title="Unlink"
                      >
                        <Unlink className="h-2.5 w-2.5" />
                      </button>
                      <ChevronRight className="h-3.5 w-3.5 text-neutral-500" />
                    </span>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openCreate(s.createUrl);
                      }}
                      className="flex items-center justify-between rounded-lg border border-border/50 bg-neutral-950/60 px-2 py-1.5 text-left transition-colors hover:border-violet-400/40 hover:bg-violet-400/5"
                    >
                      <span className="flex items-center gap-1.5 text-[10px] text-neutral-300">
                        <KeyRound className="h-3 w-3 text-violet-300" />
                        Create a {s.name} token
                      </span>
                      <ExternalLink className="h-3 w-3 text-neutral-500" />
                    </button>
                    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <Input
                        type="password"
                        className="h-8 min-w-0 flex-1 text-[11px]"
                        placeholder={s.placeholder}
                        value={tokens[s.id] ?? ""}
                        onChange={(e) => setTokens((t) => ({ ...t, [s.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void connect(s.id);
                        }}
                      />
                      <Button size="sm" className="h-8 flex-none text-[11px]" disabled={busy === s.id} onClick={() => void connect(s.id)}>
                        {busy === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Link"}
                      </Button>
                    </div>
                    <div className="truncate text-[9px] text-neutral-600">{s.help}</div>
                  </>
                )}

                {cardError ? <div className="text-[10px] text-rose-400">{cardError}</div> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function openCreate(url: string): void {
  openUrl(url);
}
