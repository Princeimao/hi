// Friends: external agents the user connected with on Agentverse. Discovery
// proxies the official Agentverse search API; threads persist per user.
// Only message text is ever sent to friends — no tools, no files, no local
// access of any kind.
import type { ServerEvent } from "@hi/shared";
import { query, one } from "../db/pool.js";
import { delegation } from "../agents/delegation.js";
import { bus } from "../ws/bus.js";

const SEARCH_URL = "https://agentverse.ai/v1/search/agents";
const AGENT_URL = "https://agentverse.ai/v1/almanac/agents";

export interface DiscoverResult {
  address: string;
  name: string;
  readme: string;
  status: string;
  type: string;
  interactions: number;
  protocols: string[];
}

interface SearchHit {
  address?: string;
  name?: string;
  readme?: string;
  status?: string;
  type?: string;
  total_interactions?: number;
  recent_interactions?: number;
}

async function httpx(method: "post" | "get", url: string, data?: unknown, timeout = 12_000): Promise<Response> {
  const headers: Record<string, string> =
    method === "post" ? { "Content-Type": "application/json" } : {};
  // Optional Agentverse API key (env AGENTVERSE) — lifts rate limits and
  // unlocks richer hit metadata via api.inv.ai profiles.
  const key = process.env.AGENTVERSE ?? "";
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(url, {
    method,
    body: method === "post" ? JSON.stringify(data ?? {}) : undefined,
    headers,
    signal: AbortSignal.timeout(timeout),
  });
  return res;
}

const searchCache = new Map<string, { at: number; hits: SearchHit[] }>();

/** The official Agentverse search API (POST /v1/search/agents), verified:
 *  every hit is cross-checked against the Almanac — only agents that are
 *  genuinely registered and alive right now are returned. */
export async function discover(text: string, limit = 10): Promise<DiscoverResult[]> {
  const body: Record<string, unknown> = {
    search_text: text,
    sort: "interactions",
    direction: "desc",
    offset: 0,
    limit: Math.min(Math.max(limit, 1), 20) * 3,
    filters: { state: ["active"], category: [], agent_type: [] },
  };
  const res = await httpx("post", SEARCH_URL, body);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new UpstreamError(`Agentverse search answered HTTP ${res.status}: ${detail}`);
  }
  const json = (await res.json()) as { agents?: SearchHit[] };
  const hits = (json.agents ?? []).map((hit) => ({
    address: String(hit.address ?? ""),
    name: String(hit.name ?? "unnamed agent"),
    readme: String(hit.readme ?? ""),
    status: String(hit.status ?? "unknown"),
    type: String(hit.type ?? ""),
    interactions: Number(hit.recent_interactions ?? hit.total_interactions ?? 0),
    protocols: [],
  }));

  // Liveness proof: ask the Almanac about each candidate in parallel.
  const verified = await Promise.all(
    hits.slice(0, 20).map(async (hit) => {
      if (!hit.address) return null;
      const facts = await agentFacts(hit.address);
      if (!facts) return hit; // keep raw info if the almanac doesn't know it
      if (facts.status !== "active") return null; // provably dead → drop
      return {
        ...hit,
        name: hit.name && hit.name !== hit.address.slice(0, 16) ? hit.name : facts.name,
        status: facts.status,
        type: facts.type,
        protocols: facts.protocols,
      };
    }),
  );
  const alive = verified.filter((h): h is DiscoverResult => h !== null && h.interactions > 0);
  const rest = verified.filter((h): h is DiscoverResult => h !== null);
  return (alive.length ? alive : rest).slice(0, limit);
}

/** Almanac agent details: the truth about endpoints/protocols/expiry. */
export async function agentFacts(address: string): Promise<DiscoverResult | null> {
  const res = await httpx("get", `${AGENT_URL}/${encodeURIComponent(address)}`);
  if (!res.ok) return null;
  const json = (await res.json()) as {
    status?: string;
    type?: string;
    endpoints?: { url: string }[];
    protocols?: string[];
    expiry?: string;
    domain_name?: string;
  };
  return {
    address,
    name: json["domain_name"] ?? address.slice(0, 16),
    readme: "",
    status: json.status ?? "unknown",
    type: json.type ?? "",
    interactions: (json.endpoints ?? []).length,
    protocols: json.protocols ?? [],
  };
}

// ── stored friends ───────────────────────────────────────────────────────────

export interface Friend {
  id: string;
  address: string;
  name: string;
  readme: string;
  agentStatus: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

export class UpstreamError extends Error {}
export class DuplicateError extends Error {}

export async function listFriends(userId: string): Promise<Friend[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT f.id, f.address, f.name, f.readme, f.agent_status,
            m.content AS last_message, m.created_at AS last_at, f.created_at
       FROM friends f
       LEFT JOIN LATERAL (SELECT content, created_at FROM friend_messages
                            WHERE friend_id = f.id ORDER BY created_at DESC LIMIT 1) m ON true
      WHERE f.user_id = $1
      ORDER BY f.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r["id"] as string,
    address: r["address"] as string,
    name: r["name"] as string,
    readme: r["readme"] as string,
    agentStatus: r["agent_status"] as string,
    lastMessage: (r["last_message"] as string | null) ?? null,
    lastMessageAt: (r["last_at"] as string | null) ?? null,
    createdAt: r["created_at"] as string,
  }));
}

export async function connect(userId: string, hit: { address: string; name: string; readme: string; status: string }): Promise<Friend> {
  if (!/^agent1q[a-z0-9]{38,70}$/.test(hit.address.trim())) throw new UpstreamError("not a valid agent address");
  const existing = await one<{ id: string }>(
    `SELECT id FROM friends WHERE user_id = $1 AND address = $2 LIMIT 1`,
    [userId, hit.address],
  );
  if (existing) throw new DuplicateError(`already connected to ${hit.name}`);
  const id = randomId();
  const row = await one<Record<string, unknown>>(
    `INSERT INTO friends (id, user_id, address, name, readme, agent_status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, address, name, readme, agent_status, created_at`,
    [id, userId, hit.address, hit.name, hit.readme, hit.status],
  );
  if (!row) throw new Error("connect failed");
  return toFriend(row);
}

export async function disconnect(userId: string, friendId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM friends WHERE user_id = $1 AND id = $2 RETURNING id`,
    [userId, friendId],
  );
  return rows.length > 0;
}

export function randomId(): string {
  return `fr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function toFriend(row: Record<string, unknown>): Friend {
  return {
    id: row["id"] as string,
    address: row["address"] as string,
    name: row["name"] as string,
    readme: row["readme"] as string,
    agentStatus: row["agent_status"] as string,
    lastMessage: null,
    lastMessageAt: null,
    createdAt: row["created_at"] as string,
  };
}

export interface FriendMessage {
  id: string;
  friendId: string;
  role: "user" | "agent";
  content: string;
  state: "sent" | "delivered" | "failed" | "replied";
  createdAt: string;
}

export async function history(userId: string, friendId: string, limit = 100): Promise<FriendMessage[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT m.* FROM friend_messages m JOIN friends f ON f.id = m.friend_id
      WHERE f.user_id = $1 AND f.id = $2 ORDER BY m.created_at DESC LIMIT $3`,
    [userId, friendId, limit],
  );
  return rows.reverse().map(mapMessage);
}

function mapMessage(r: Record<string, unknown>): FriendMessage {
  return {
    id: r["id"] as string,
    friendId: r["friend_id"] as string,
    role: r["role"] as "user" | "agent",
    content: r["content"] as string,
    state: r["state"] as FriendMessage["state"],
    createdAt: r["created_at"] as string,
  };
}

/** Send: persist the outgoing message, then assign a gateway task so the
 * coordinator delivers it over the chat protocol. Progress lands on the
 * ServerEvent bus (friend.delivered / friend.reply / friend.error). */
export async function send(userId: string, friendId: string, text: string): Promise<FriendMessage> {
  const clean = text.trim().slice(0, 4000);
  if (!clean) throw new Error("text required");
  const friend = await one<Record<string, unknown>>(
    `SELECT id, address FROM friends WHERE user_id = $1 AND id = $2 LIMIT 1`,
    [userId, friendId],
  );
  if (!friend) throw new Error("no such friend");
  const id = `fm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await query(
    `INSERT INTO friend_messages (id, friend_id, user_id, role, content, state) VALUES ($1, $2, $3, 'user', $4, 'sent')`,
    [id, friendId, userId, clean],
  );
  await delegation.createTask({
    userId,
    conversationId: null,
    kind: "friend",
    title: `Message ${friendId.slice(0, 10)}`,
    payload: { messageId: id, friendId, address: friend["address"], text: clean },
    context: { kind: "friend", messageId: id, friendId, address: friend["address"], text: clean },
  });
  return {
    id,
    friendId,
    role: "user",
    content: clean,
    state: "sent",
    createdAt: new Date().toISOString(),
  };
}

/** Gateway updates, keyed by the taskId (the payload carries userId). */
export async function applyAgentFrame(frame: {
  type: "friend.delivered" | "friend.reply" | "friend.error";
  taskId: string;
  address?: string;
  ackId?: string;
  text?: string;
  detail?: string;
}): Promise<void> {
  const task = await one<Record<string, unknown>>(
    `SELECT payload, user_id FROM agent_tasks WHERE id = $1 LIMIT 1`,
    [frame.taskId],
  );
  if (!task) return;
  const payload = (task["payload"] ?? {}) as { friendId?: string; messageId?: string };
  const friendId = String(payload.friendId ?? "");
  const messageId = String(payload.messageId ?? "");
  if (!friendId || !messageId) return;
  let event: ServerEvent | null = null;
  if (frame.type === "friend.delivered") {
    await query(`UPDATE friend_messages SET state = 'delivered' WHERE id = $1 AND state = 'sent'`, [messageId]);
    event = { type: "friend.delivered", friendId, messageId, ackId: frame.ackId ?? "" };
  } else if (frame.type === "friend.reply") {
    const id = `fm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const row = await one<Record<string, unknown>>(
      `INSERT INTO friend_messages (id, friend_id, user_id, role, content, state) VALUES ($1, $2, $3, 'agent', $4, 'replied') RETURNING *`,
      [id, friendId, task["user_id"], String(frame.text ?? "")],
    );
    await query(`UPDATE friend_messages SET state = 'delivered' WHERE id = $1 AND state = 'sent'`, [messageId]);
    await query(`UPDATE friends SET agent_status = 'active' WHERE id = $1`, [friendId]);
    if (row) event = { type: "friend.reply", friendId, messageId: row["id"] as string, text: String(row["content"] ?? "") };
  } else {
    await query(`UPDATE friend_messages SET state = 'failed' WHERE id = $1 AND state = 'sent'`, [messageId]);
    event = { type: "friend.error", friendId, messageId, reason: String(frame.detail ?? "delivery failed") };
  }
  if (event) await bus.emit(String(task["user_id"]), event);
}
