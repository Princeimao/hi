// Friends tab: your connected external agents (Agentverse), their status,
// unread counts, the thread, and discovery via the official search API.
// Delivery is honest: a message you send shows sent → delivered (acks from the
// chat protocol) or failed (gateways refuse to invent a delivery).
import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { dockStore } from "../dockstore";
import type { RestAuth } from "../api";

interface DiscoverHit {
  address: string;
  name: string;
  readme: string;
  status: string;
  type: string;
  interactions: number;
}

interface Friend {
  id: string;
  address: string;
  name: string;
  agentStatus: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

interface FMessage {
  id: string;
  friendId: string;
  role: "user" | "agent";
  content: string;
  state: "sent" | "delivered" | "failed" | "replied";
  createdAt: string;
}

function rest(): Promise<RestAuth> {
  return window.hi.restAuth();
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const { restBase, token } = await rest();
  const res = await fetch(`${restBase}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

// Discovery state lives at module scope on purpose: the island unmounts this
// panel every time it collapses, and the search + results must survive that.
const discoveryCache: { query: string; hits: DiscoverHit[] | null } = { query: "", hits: null };

/** Readme text arrives with markdown badge junk ([![tag](img.shields.io/…)) —
 *  strip images/links/bracket noise so discovery cards read cleanly. */
function cleanReadme(raw: string): string {
  return raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[!\[\]\([^)]*\)\]\([^)]*\)/g, "")
    .replace(/[#*_`>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function FriendsPanel(): React.ReactElement {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [selected, setSelected] = useState<Friend | null>(null);
  const [messages, setMessages] = useState<FMessage[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [query, setQuery] = useState(discoveryCache.query);
  const [hits, setHits] = useState<DiscoverHit[] | null>(discoveryCache.hits);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const lastSeenRef = useRef<string | null>(null);

  // Mirror discovery state into the module cache so closing the island (which
  // unmounts this panel) never loses the search or its results.
  useEffect(() => {
    discoveryCache.query = query;
    discoveryCache.hits = hits;
  }, [query, hits]);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api<Friend[]>("/api/friends");
        setFriends(list);
      } catch (err) {
        setError(String(err));
      }
    })();
  }, []);

  useEffect(() => {
    window.hi.onHubEvent((event) => {
      const type = event["type"];
      if (type === "friend.delivered") {
        const messageId = String(event["messageId"] ?? "");
        setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, state: "delivered" } : m)));
        return;
      }
      if (type === "friend.reply") {
        const friendId = String(event["friendId"] ?? "");
        const text = String(event["text"] ?? "");
        const at = new Date().toISOString();
        const id = `fm_live_${Date.now()}`;
        setMessages((prev) => [...prev, { id, friendId, role: "agent", content: text, state: "replied", createdAt: at }]);
        setSelected((current) => {
          if (current && current.id === friendId) lastSeenRef.current = id;
          return current;
        });
        setUnread((u) => ({ ...u, [friendId]: (u[friendId] ?? 0) + (selectedRef.current?.id === friendId ? 0 : 1) }));
        return;
      }
      if (type === "friend.error") {
        const messageId = String(event["messageId"] ?? "");
        const reason = String(event["reason"] ?? "");
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, state: "failed" as const } : m)),
        );
        setError(messageId ? `Delivery failed: ${reason}` : reason);
        dockStore.setMood("angry", 4000);
        return;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedRef = useRef<Friend | null>(null);
  selectedRef.current = selected;

  async function open(f: Friend): Promise<void> {
    setSelected(f);
    setUnread((u) => ({ ...u, [f.id]: 0 }));
    setError(null);
    setBusy(`open:${f.id}`);
    try {
      const history = await api<FMessage[]>(`/api/friends/${f.id}/messages`);
      setMessages(history);
      lastSeenRef.current = history.length ? history[history.length - 1].id : null;
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function discover(): Promise<void> {
    setBusy("discover");
    setError(null);
    try {
      const q = query.trim();
      if (!q) throw new Error("Type what to search for");
      const got = await api<DiscoverHit[]>(`/api/friends/discover?q=${encodeURIComponent(q)}&limit=8`);
      setHits(got);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function connect(hit: DiscoverHit): Promise<void> {
    setBusy(`connect:${hit.address.slice(0, 10)}`);
    setError(null);
    try {
      const f = await api<Friend>("/api/friends", {
        method: "POST",
        body: JSON.stringify({ address: hit.address, name: hit.name, readme: hit.readme.slice(0, 3000), status: hit.status }),
      });
      setFriends((prev) => [f, ...prev.filter((x) => x.id !== f.id)]);
      await open(f);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function send(): Promise<void> {
    const f = selected;
    const text = draft.trim();
    if (!f || !text) return;
    setDraft("");
    try {
      const msg = await api<FMessage>(`/api/friends/${f.id}/message`, { method: "POST", body: JSON.stringify({ text }) });
      setMessages((prev) => [...prev, msg]);
      setFriends((prev) => prev.map((x) => (x.id === f.id ? { ...x, lastMessage: text, lastMessageAt: msg.createdAt } : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(f: Friend): Promise<void> {
    setBusy(`del:${f.id}`);
    await fetch(`${(await rest()).restBase}/api/friends/${f.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${(await rest()).token}` },
    }).catch(() => undefined);
    setFriends((prev) => prev.filter((x) => x.id !== f.id));
    if (selected?.id === f.id) {
      setSelected(null);
      setMessages([]);
    }
    setBusy(null);
  }

  const agentStatusClass: Record<string, string> = { active: "on", offline: "off" };

  return (
    <div className="flex h-full min-h-0 gap-3">
      <div className="flex w-[320px] flex-none flex-col gap-2 min-h-0">
        <div className="flex items-center gap-2">
          <Input
            className="h-10 flex-1 text-sm"
            placeholder="Search Agentverse agents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void discover();
            }}
          />
          <Button size="sm" className="h-10 px-4 text-sm" disabled={busy === "discover"} onClick={() => void discover()}>
            {busy === "discover" ? "…" : "Find"}
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1 rounded-xl border border-border/60 bg-card/40">
          <div className="flex flex-col gap-2 p-2">
            {friends.map((f) => (
              <button
                key={f.id}
                onClick={() => void open(f)}
                className={
                  "flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors " +
                  (selected?.id === f.id ? "bg-neutral-800/90 ring-1 ring-border/60" : "hover:bg-neutral-800/40")
                }
              >
                <span className={"status-dot " + (agentStatusClass[f.agentStatus] ?? "unknown")} title={f.agentStatus} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-100">
                    <span className="truncate">{f.name}</span>
                    {unread[f.id] ? (
                      <Badge className="px-1.5 py-0 text-[9px]">{unread[f.id]}</Badge>
                    ) : null}
                  </div>
                  <div className="truncate text-[10px] text-neutral-500">{f.lastMessage ? f.lastMessage.slice(0, 40) : `@ ${f.agentStatus}`}</div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 flex-none text-neutral-500 hover:text-neutral-200"
                  disabled={busy === `del:${f.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(f);
                  }}
                >
                  ✕
                </Button>
              </button>
            ))}
            {hits ? (
              <div className="mt-1 flex flex-col gap-1.5">
                <div className="px-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                  {hits.length === 0 ? "No agents matched" : "Discovered"}
                </div>
                {hits.map((h) => (
                  <div key={h.address} className="rounded-lg border border-border/40 bg-neutral-900/60 p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-neutral-100">{h.name}</div>
                        <div className="text-[10px] text-neutral-500">{h.interactions} convos · {h.status || "agent"}</div>
                      </div>
                      <Button size="sm" className="h-7 flex-none px-2.5 text-[11px]" disabled={!!busy} onClick={() => void connect(h)}>
                        Connect
                      </Button>
                    </div>
                    <p className="mt-1 line-clamp-3 text-[10px] leading-relaxed text-neutral-400">
                      {cleanReadme(h.readme).slice(0, 160) || h.address}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
            {friends.length === 0 && !hits ? (
              <div className="px-2 py-6 text-center text-[11px] text-neutral-500">
                No friends yet — search for an agent (example: "scheduling", "search") and connect.
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {selected ? (
          <>
            <div className="flex items-baseline justify-between px-1">
              <div className="text-xs font-semibold text-neutral-100">{selected.name}</div>
              <div className="text-[10px] text-neutral-500">reported by the agent · not a verified calendar</div>
            </div>
            <ScrollArea className="min-h-0 flex-1 rounded-xl border border-border/60 bg-card/40">
              <div className="flex flex-col gap-2 p-3">
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={
                      "max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-relaxed " +
                      (m.role === "user"
                        ? "self-end bg-neutral-100 text-neutral-900"
                        : "self-start bg-neutral-900 text-neutral-100 border border-border/60")
                    }
                  >
                    {m.content}
                    {m.role === "user" && m.state !== "replied" ? (
                      <span className={"msg-state " + m.state}>
                        {m.state === "sent" ? " · sending" : m.state === "delivered" ? " · delivered" : " · failed"}
                      </span>
                    ) : null}
                  </div>
                ))}
                {busy === `open:${selected.id}` ? <div className="self-start text-[10px] text-neutral-500">Loading…</div> : null}
              </div>
            </ScrollArea>
            {error ? <div className="px-1 text-[10px] text-rose-400">{error}</div> : null}
            <div className="flex items-center gap-2">
              <Input
                className="h-9 flex-1 text-xs"
                placeholder={`Message ${selected.name} — e.g. "When are you free this week?"`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void send();
                }}
              />
              <Button size="sm" className="h-9 px-3 text-xs" onClick={() => void send()}>
                Send
              </Button>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border/40">
            <div className="max-w-[280px] text-center text-xs text-neutral-500">
              Pick a friend on the left, or search Agentverse to discover one. Messages travel the official uAgents network.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
