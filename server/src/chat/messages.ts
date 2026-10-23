import type { ChatMessage, ChatMessageMeta, Conversation, MessageRole } from "@hi/shared";
import { one, query } from "../db/pool.js";

interface ConvRow {
  id: string;
  title: string;
  created_at: string;
  last_message_at: string;
  archived: boolean;
  user_id: string;
}

interface MsgRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  meta: ChatMessageMeta;
  created_at: string;
  seq: string | number;
}

function msg(r: MsgRow): ChatMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role as MessageRole,
    content: r.content,
    meta: r.meta ?? {},
    createdAt: r.created_at,
    seq: Number(r.seq),
  };
}

function conv(r: ConvRow, messageCount?: number, lastPreview?: string): Conversation {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    lastMessageAt: r.last_message_at,
    messageCount,
    lastPreview,
  };
}

export async function getConversation(userId: string, id: string): Promise<Conversation | null> {
  const row = await one<ConvRow>(`SELECT * FROM conversations WHERE id = $1 AND user_id = $2`, [
    id,
    userId,
  ]);
  return row ? conv(row) : null;
}

export async function createConversation(
  userId: string,
  title = "New conversation",
): Promise<Conversation> {
  const row = await one<ConvRow>(
    `INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING *`,
    [userId, title.slice(0, 80) || "New conversation"],
  );
  return conv(row!);
}

export async function renameConversation(
  userId: string,
  id: string,
  title: string,
): Promise<Conversation | null> {
  const row = await one<ConvRow>(
    `UPDATE conversations SET title = $3 WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, title.slice(0, 80)],
  );
  return row ? conv(row) : null;
}

export async function deleteConversation(userId: string, id: string): Promise<boolean> {
  const res = await one<{ id: string }>(
    `DELETE FROM conversations WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId],
  );
  return Boolean(res);
}

export async function listConversations(userId: string, limit = 60): Promise<Conversation[]> {
  const rows = await query<ConvRow & { message_count: string; last_preview: string }>(
    `SELECT c.id, c.title, c.created_at, c.last_message_at, c.archived, c.user_id,
            (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT LEFT(m.content, 90) FROM messages m
              WHERE m.conversation_id = c.id ORDER BY m.seq DESC LIMIT 1) AS last_preview
     FROM conversations c WHERE c.user_id = $1
     ORDER BY c.last_message_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) =>
    conv(r, Number(r.message_count) || 0, r.last_preview ?? ""),
  );
}

export async function getMessage(
  userId: string,
  conversationId: string,
  id: string,
): Promise<ChatMessage | null> {
  const row = await one<MsgRow>(
    `SELECT * FROM messages WHERE id = $1 AND conversation_id = $2 AND user_id = $3`,
    [id, conversationId, userId],
  );
  return row ? msg(row) : null;
}

export async function insertMessage(opts: {
  conversationId: string;
  userId: string;
  role: MessageRole;
  content: string;
  meta?: ChatMessageMeta;
  clientMessageId?: string;
}): Promise<ChatMessage> {
  const row = await one<MsgRow>(
    `INSERT INTO messages (conversation_id, user_id, role, content, meta, client_message_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING *`,
    [
      opts.conversationId,
      opts.userId,
      opts.role,
      opts.content,
      JSON.stringify(opts.meta ?? {}),
      opts.clientMessageId ?? null,
    ],
  );
  await one(
    `UPDATE conversations SET last_message_at = now() WHERE id = $1 AND user_id = $2`,
    [opts.conversationId, opts.userId],
  );
  return msg(row!);
}

/** Streaming: update the assistant message content in place (live persistence). */
export async function updateMessageContent(
  conversationId: string,
  messageId: string,
  content: string,
): Promise<void> {
  await one(`UPDATE messages SET content = $3 WHERE id = $2 AND conversation_id = $1`, [
    conversationId,
    messageId,
    content,
  ]);
}

export async function setMessageMeta(
  conversationId: string,
  messageId: string,
  meta: ChatMessageMeta,
): Promise<void> {
  await one(`UPDATE messages SET meta = $3::jsonb WHERE id = $2 AND conversation_id = $1`, [
    conversationId,
    messageId,
    JSON.stringify(meta),
  ]);
}

export async function listMessages(
  userId: string,
  conversationId: string,
  opts: { limit?: number } = {},
): Promise<ChatMessage[]> {
  const limit = opts.limit ?? 200;
  const rows = await query<MsgRow>(
    `SELECT * FROM messages WHERE conversation_id = $1 AND user_id = $2 ORDER BY seq ASC LIMIT $3`,
    [conversationId, userId, limit],
  );
  return rows.map(msg);
}

/** Recent turns across all conversations for cross-chat recall prompts. */
export async function recentHistory(
  userId: string,
  conversationId: string,
  limit = 12,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const rows = await query<{ role: string; content: string }>(
    `SELECT role, content FROM messages
     WHERE conversation_id = $1 AND user_id = $2 AND role IN ('user','assistant')
     ORDER BY seq DESC LIMIT $3`,
    [conversationId, userId, limit],
  );
  return rows.reverse().map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}
