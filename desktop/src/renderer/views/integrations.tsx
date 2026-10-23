// Integrations tab — add the token of a service, verify it against the real
// API, and inspect live data. No placeholder cards: everything visible here
// is a real connection or an explicit, actionable error.
import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  Circle,
  GitBranch,
  Link2,
  Loader2,
  Unlink,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { integration, type IntegrationInfo, type IntegrationRow } from "../api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

const SERVICES: { id: string; name: string; placeholder: string; help: string; ask: string; icon: React.ElementType }[] = [
  { id: "github", name: "GitHub", placeholder: "ghp_…", help: "github.com/settings/tokens", ask: "ask Hi: \"list my repos\", \"open PRs in owner/repo\", \"file an issue…\"", icon: GitBranch },
  { id: "vercel", name: "Vercel", placeholder: "vrc_…", help: "vercel.com/account/tokens", ask: "ask Hi: \"list my vercel projects\"", icon: Sparkles },
  { id: "notion", name: "Notion", placeholder: "secret_…", help: "notion.so/my-integrations", ask: "ask Hi: \"search my notes for X\"", icon: Circle },
  { id: "calcom", name: "Cal.com", placeholder: "cal_…", help: "app.cal.com/settings/developer/api-keys", ask: "ask Hi: \"what's on my calendar?\"", icon: Link2 },
  { id: "elevenlabs", name: "ElevenLabs", placeholder: "sk_…", help: "elevenlabs.io/app/settings/api-keys", ask: "voice in & out of the notch (Chat tab mic)", icon: ShieldCheck },
];

export function IntegrationsPanel(): React.ReactElement {
  const [rows, setRows] = useState<IntegrationInfo[]>([]);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspect, setInspect] = useState<Record<string, IntegrationRow[]>>({});

  useEffect(() => {
    let alive = true;
    void integration.list().then((list) => {
      if (alive) setRows(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  const connected = (service: string): IntegrationInfo | undefined => rows.find((r) => r.service === service);

  async function connect(service: string): Promise<void> {
    setBusy(service);
    setError(null);
    try {
      const token = (tokens[service] ?? "").trim();
      if (!token) throw new Error("Enter the token first");
      const next = await integration.connect(service, token);
      setRows((rows) => rows.map((r) => (r.service === service ? next : r)));
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
    setRows((rows) => rows.map((r) => (r.service === service ? { ...r, connected: false, account: null } : r)));
    setInspect((i) => {
      const copy = { ...i };
      delete copy[service];
      return copy;
    });
    setBusy(null);
  }

  async function load(service: string): Promise<void> {
    setBusy(service);
    setError(null);
    try {
      const got = await integration.items(service);
      setInspect((i) => ({ ...i, [service]: got }));
    } catch (err) {
      setError(`${service}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <div>
          <div className="text-[13px] font-semibold text-neutral-100">Services</div>
          <div className="flex items-center gap-1 text-[10px] text-neutral-500">
            <ShieldCheck className="h-3 w-3" /> tokens stay on your server, encrypted
          </div>
        </div>
      </div>
      <ScrollArea className="h-72 rounded-xl border border-border/60 bg-card/40">
        <div className="flex flex-col divide-y divide-border/40 p-1.5">
          {SERVICES.map((s) => {
            const info = connected(s.id);
            const Icon = s.icon;
            return (
              <div key={s.id} className="flex items-center gap-2.5 px-2 py-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-800/80 border border-border/50">
                  <Icon className="h-3.5 w-3.5 text-neutral-300" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-medium text-neutral-100">{s.name}</span>
                    {info?.connected ? (
                      <Badge className="gap-1 border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0 text-[9px] text-emerald-300">
                        <CheckCircle2 className="h-2.5 w-2.5" /> {info.account || "linked"}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="px-1.5 py-0 text-[9px] text-neutral-500">not linked</Badge>
                    )}
                  </div>
                  <div className="text-[10px] text-neutral-500">{s.help}</div>
                  {inspect[s.id] ? (
                    <div className="mt-1 rounded-lg bg-neutral-950/60 p-1 text-[10px] text-neutral-400">
                      {inspect[s.id].length === 0 ? (
                        "nothing to show"
                      ) : (
                        inspect[s.id].map((r, i) => (
                          <div key={i} className="truncate">
                            {r.title}
                            {r.state ? ` — ${r.state}` : ""}
                            {r.at ? ` · ${new Date(r.at).toLocaleString()}` : ""}
                          </div>
                        ))
                      )}
                    </div>
                  ) : null}
                  {error && error.toLowerCase().startsWith(s.id) ? (
                    <div className="mt-0.5 text-[10px] text-rose-400">{error.slice(s.id.length + 2)}</div>
                  ) : null}
                </div>
                <div className="flex flex-none items-center gap-1.5">
                  {!info?.connected ? (
                    <>
                      <Input
                        type="password"
                        className="h-8 w-40 text-[11px]"
                        placeholder={s.placeholder}
                        value={tokens[s.id] ?? ""}
                        onChange={(e) => setTokens((t) => ({ ...t, [s.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void connect(s.id);
                        }}
                      />
                      <Button size="sm" className="h-8 text-[11px]" disabled={busy === s.id} onClick={() => void connect(s.id)}>
                        {busy === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Link"}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" className="h-8 gap-1 text-[11px]" disabled={busy === s.id} onClick={() => void load(s.id)}>
                        <RefreshCw className="h-2.5 w-2.5" /> Inspect
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8 gap-1 text-[11px] text-neutral-400" disabled={busy === s.id} onClick={() => void disconnect(s.id)}>
                        <Unlink className="h-2.5 w-2.5" /> Unlink
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
