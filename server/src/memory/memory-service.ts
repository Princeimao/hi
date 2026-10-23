import type { Memory, MemoryKind } from "@hi/shared";
import { config } from "../config.js";
import { asiJson, NotConfiguredError } from "../asi/asi-one.js";
import { one, query } from "../db/pool.js";
import { createHash } from "node:crypto";

interface MemoryRow {
  id: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  importance: number;
  source_conversation_id: string | null;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToMemory(r: MemoryRow): Memory {
  return {
    id: r.id,
    kind: r.kind,
    content: r.content,
    confidence: r.confidence,
    importance: r.importance,
    sourceConversationId: r.source_conversation_id,
    useCount: r.use_count,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const hash = (content: string) => createHash("sha256").update(content.trim().toLowerCase()).digest("hex").slice(0, 32);

// ── Recall ───────────────────────────────────────────────────────────────────

export interface ScoredMemory extends Memory {
  score: number;
}

/**
 * Rank the user's memories for a new message, combining:
 *  - lexical relevance (Postgres full-text ts_rank)
 *  - importance, recency, and utility
 * The top `limit` are used as the conversation context.
 */
export async function recallMemories(
  userId: string,
  message: string,
  limit = 8,
): Promise<ScoredMemory[]> {
  const rows = await query<MemoryRow & { score: string | number }>(
    `
    WITH scored AS (
      SELECT m.*,
        COALESCE(ts_rank(to_tsvector('english', m.content), plainto_tsquery('english', $2)), 0.0) AS lexical,
        (m.importance / 5.0) * 0.30 +
        GREATEST(0, 1 - EXTRACT(EPOCH FROM (now() - m.updated_at)) / (86400 * 30)) * 0.25 +
        LEAST(1.0, m.use_count / 10.0) * 0.10
        AS static
      FROM memories m WHERE m.user_id = $1
    )
    SELECT id, kind, content, confidence, importance, source_conversation_id,
           use_count, last_used_at, created_at, updated_at,
           (lexical * 0.60 + static) AS score
    FROM scored
    ORDER BY score DESC, updated_at DESC
    LIMIT $3
  `,
    [userId, message || "", limit],
  ).catch(() => []);
  // Fallback when FTS behaves unexpectedly in this environment: simple order.
  if (!rows.length) {
    const fallback = await query<MemoryRow>(
      `SELECT id, kind, content, confidence, importance, source_conversation_id,
              use_count, last_used_at, created_at, updated_at
       FROM memories WHERE user_id = $1
       ORDER BY importance DESC, updated_at DESC LIMIT $2`,
      [userId, limit],
    );
    return fallback.map((r, i) => ({ ...rowToMemory(r), score: 1 - i * 0.05 }));
  }
  return rows.map((r) => ({ ...rowToMemory(r), score: Number(r.score) || 0 }));
}

export async function touchMemories(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await query(
    `UPDATE memories SET use_count = use_count + 1, last_used_at = now()
     WHERE id = ANY($1::uuid[])`,
    [ids],
  );
}

// ── Extraction (cloud memory, deterministic + LLM-assisted) ────────────────

interface ExtractedItem {
  kind: MemoryKind;
  content: string;
  confidence: number;
  importance: number;
}

const EXTRACT_SYSTEM = `You maintain the long-term memory of a personal AI companion called Hi.
From the conversation excerpt, extract durable facts about the user that should be
remembered across future conversations: preferences, goals, people they mention,
routines, projects they work on, and important facts.

Rules:
- Only truly durable, useful facts. Exclude one-off chat, questions to the assistant, or small talk.
- Write each memory as one concise self-contained third-person sentence about the user ("The user ...").
- kind is one of: fact, preference, goal, person, routine, project.
- importance is 1-5 (5 = would hurt to forget).
- confidence is 0-100.
- Return pure JSON: {"memories": [{"kind":..., "content":..., "confidence":..., "importance":...}]}
- Return {"memories": []} if nothing durable was said.`;

const heuristics: { re: RegExp; kind: MemoryKind; importance: number }[] = [
  { re: /\bmy name is\b|call me\b/i, kind: "person", importance: 5 },
  { re: /\bi prefer\b|\bi like\b|\bi love\b|\bi hate\b|\bi dislike\b/i, kind: "preference", importance: 3 },
  { re: /\bi'?m working on\b|\bmy project\b|\bi'?m building\b/i, kind: "project", importance: 4 },
  { re: /\bi want to\b|\bmy goal\b|\bi'?m planning to\b/i, kind: "goal", importance: 4 },
  { re: /\bevery (day|morning|evening|week)\b/i, kind: "routine", importance: 3 },
];

class MemoryService {
  /** Store one extracted item (used by agent-run memory tasks via the finalize hook). */
  async insertFromExtraction(
    userId: string,
    conversationId: string | null,
    item: { kind: MemoryKind; content: string; confidence: number; importance: number },
  ): Promise<Memory | null> {
    const contentHash = hash(item.content);
    const inserted = await one<MemoryRow>(
      `INSERT INTO memories (user_id, kind, content, confidence, importance, source_conversation_id, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, content_hash) DO NOTHING
       RETURNING id, kind, content, confidence, importance, source_conversation_id,
                 use_count, last_used_at, created_at, updated_at`,
      [userId, item.kind, item.content, item.confidence, item.importance, conversationId, contentHash],
    );
    return inserted ? rowToMemory(inserted) : null;
  }

  /**
   * Extract durable memories from the latest message pair using ASI:ONE
   * (structured JSON). Falls back to cheap deterministic heuristics when the
   * API key is not configured, and never throws — extraction is opportunistic.
   */
  async extractFromTurn(
    userId: string,
    conversationId: string | null,
    userText: string,
    assistantText: string,
  ): Promise<Memory[]> {
    const items: ExtractedItem[] = [];
    try {
      const json = await asiJson<{ memories: ExtractedItem[] }>(
        [
          { role: "system", content: EXTRACT_SYSTEM },
          {
            role: "user",
            content: `USER SAID:\n${userText}\n\nASSISTANT REPLIED:\n${assistantText.slice(0, 1200)}`,
          },
        ],
        { model: config.asi.miniModel, temperature: 0.2 },
      );
      for (const m of json.memories ?? []) {
        if (typeof m?.content === "string" && m.content.trim().length > 3) {
          items.push({
            kind: ["fact", "preference", "goal", "person", "routine", "project"].includes(m.kind)
              ? m.kind
              : "fact",
            content: m.content.trim().slice(0, 400),
            confidence: clamp(m.confidence ?? 60, 0, 100),
            importance: clamp(m.importance ?? 3, 1, 5),
          });
        }
      }
    } catch (err) {
      if (err instanceof NotConfiguredError) {
        for (const h of heuristics) {
          if (h.re.test(userText)) {
            items.push({
              kind: h.kind,
              content: `The user said: ${userText.trim().slice(0, 300)}`,
              confidence: 40,
              importance: h.importance,
            });
          }
        }
      } else {
        console.warn(
          `[memory] extraction failed: ${(err as Error).message}. Falling back to heuristics.`,
        );
        for (const h of heuristics) {
          if (h.re.test(userText)) {
            items.push({
              kind: h.kind,
              content: `The user said: ${userText.trim().slice(0, 300)}`,
              confidence: 40,
              importance: h.importance,
            });
          }
        }
      }
    }
    if (!items.length) return [];

    const stored: Memory[] = [];
    for (const item of items) {
      const contentHash = hash(item.content);
      const inserted = await one<MemoryRow>(
        `INSERT INTO memories (user_id, kind, content, confidence, importance, source_conversation_id, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (content_hash) DO NOTHING
         RETURNING id, kind, content, confidence, importance, source_conversation_id,
                   use_count, last_used_at, created_at, updated_at`,
        [userId, item.kind, item.content, item.confidence, item.importance, conversationId, contentHash],
      ).catch(async (err) => {
        // ON CONFLICT needs a matching unique index; create it lazily if missing.
        await query(
          `CREATE UNIQUE INDEX IF NOT EXISTS memories_content_unique ON memories(user_id, content_hash)`,
        ).catch(() => undefined);
        return one<MemoryRow>(
          `INSERT INTO memories (user_id, kind, content, confidence, importance, source_conversation_id, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, content_hash) DO NOTHING
           RETURNING id, kind, content, confidence, importance, source_conversation_id,
                     use_count, last_used_at, created_at, updated_at`,
          [userId, item.kind, item.content, item.confidence, item.importance, conversationId, contentHash],
        );
      });
      if (inserted) stored.push(rowToMemory(inserted));
    }
    if (stored.length) {
      await query(
        `UPDATE memories SET confidence = LEAST(100, confidence + 5)
         WHERE user_id = $1 AND content_hash = ANY($2::text[]) AND created_at < now() - interval '1 day'`,
        [userId, stored.map((s) => hash(s.content))],
      ).catch(() => undefined);
    }
    return stored;
  }

  async list(userId: string, opts: { limit?: number; kind?: MemoryKind | "all" } = {}): Promise<Memory[]> {
    const limit = opts.limit ?? 200;
    const kindFilter = opts.kind && opts.kind !== "all" ? `AND kind = $3` : "";
    const params: unknown[] = [userId, limit];
    if (kindFilter) params.push(opts.kind);
    const rows = await query<MemoryRow>(
      `SELECT id, kind, content, confidence, importance, source_conversation_id,
              use_count, last_used_at, created_at, updated_at
       FROM memories WHERE user_id = $1 ${kindFilter}
       ORDER BY importance DESC, updated_at DESC
       LIMIT $2`,
      params,
    );
    return rows.map(rowToMemory);
  }

  async search(userId: string, term: string, limit = 30): Promise<Memory[]> {
    const rows = await query<MemoryRow>(
      `SELECT id, kind, content, confidence, importance, source_conversation_id,
              use_count, last_used_at, created_at, updated_at
       FROM memories
       WHERE user_id = $1 AND content ILIKE $2
       ORDER BY
         (to_tsvector('english', content) @@ plainto_tsquery('english', $3)) DESC,
         updated_at DESC
       LIMIT $4`,
      [userId, `%${escapeLike(term)}%`, term || " ", limit],
    );
    return rows.map(rowToMemory);
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const res = await one<{ id: string }>(
      `DELETE FROM memories WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId],
    );
    return Boolean(res);
  }

  async clear(userId: string): Promise<number> {
    const res = await query<{ id: string }>(`DELETE FROM memories WHERE user_id = $1 RETURNING id`, [
      userId,
    ]);
    return res.length;
  }

  async setImportance(userId: string, id: string, importance: number): Promise<Memory | null> {
    const row = await one<MemoryRow>(
      `UPDATE memories SET importance = $3, updated_at = now()
       WHERE id = $2 AND user_id = $1
       RETURNING id, kind, content, confidence, importance, source_conversation_id,
                 use_count, last_used_at, created_at, updated_at`,
      [userId, id, clamp(importance, 1, 5)],
    );
    return row ? rowToMemory(row) : null;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  const safe = Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, safe));
}

function escapeLike(term: string): string {
  return term.replace(/[%_\\]/g, "\\$&");
}

export const memoryService = new MemoryService();
