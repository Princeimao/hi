import type { ClientFrame, Conversation } from "@hi/shared";
import { query } from "../db/pool.js";
import { bus } from "../ws/bus.js";
import { recallMemories, touchMemories } from "../memory/memory-service.js";
import { delegation } from "../agents/delegation.js";
import {
  createConversation,
  recentHistory,
  getConversation,
  getMessage,
  updateMessageContent,
  setMessageMeta,
  insertMessage,
} from "./messages.js";

/**
 * The chat pipeline — the entry point for everything a user sends.
 * A user message becomes: persisted message → memory recall → a `chat` task
 * pushed to the coordinator agent (or the hub-local ASI:ONE runner), streamed
 * back as chat.delta frames, then finalized as chat.message + memory task.
 */
export async function handleClientFrame(userId: string, frame: ClientFrame): Promise<void> {
  switch (frame.type) {
    case "chat.send":
      return handleSend(
        userId,
        frame.text,
        frame.conversationId ?? null,
        frame.clientMessageId ?? null,
      );
    case "chat.stop":
      return handleStop(userId, frame.conversationId, frame.messageId);
    case "task.resolve_input":
      return void (await delegation.resolveInput(userId, frame.taskId, frame.answer));
    default:
      return;
  }
}

async function handleSend(
  userId: string,
  text: string,
  conversationId: string | null,
  clientMessageId: string | null,
): Promise<void> {
  const clean = text.trim();
  if (!clean || clean.length > 8000) {
    bus.live(userId, { type: "avatar.state", state: "error", reason: "empty or too long message" });
  }
  const effective = text.trim().slice(0, 8000);
  if (!effective) return;

  let conversation: Conversation | null = null;
  if (conversationId) {
    conversation = await getConversation(userId, conversationId);
  }
  if (!conversation) {
    conversation = await createConversation(userId, effective.slice(0, 40) || "New conversation");
    await bus.emit(userId, { type: "conversation.created", conversation });
  }

  // Idempotency: the same client msg id on the same conversation is delivered once.
  if (clientMessageId) {
    const existing = await query<{ id: string }>(
      `SELECT id FROM messages WHERE conversation_id = $1 AND client_message_id = $2 LIMIT 1`,
      [conversation.id, clientMessageId],
    );
    if (existing.length) {
      bus.live(userId, { type: "chat.delivered", messageId: existing[0].id });
      return;
    }
  }

  // 1. Persist + broadcast the user's message.
  const userMessage = await insertMessage({
    conversationId: conversation.id,
    userId,
    role: "user",
    content: effective,
    clientMessageId: clientMessageId ?? undefined,
  });
  await bus.emit(userId, { type: "chat.message", message: userMessage });

  // 2. Cloud memory recall for the agent context.
  const recalled = await recallMemories(userId, effective, 8);
  await touchMemories(recalled.filter((m) => m.score > 0.15).map((m) => m.id));
  const memoryContext = recalled
    .slice(0, 8)
    .map((m) => ({ kind: m.kind, content: m.content }));

  // 3. Assistant placeholder — created before the reply so all devices render
  //    a streaming bubble as soon as tokens start arriving.
  const assistantMessage = await insertMessage({
    conversationId: conversation.id,
    userId,
    role: "assistant",
    content: "",
    meta: { streaming: true },
  });
  await bus.emit(userId, { type: "chat.message", message: assistantMessage });
  bus.live(userId, { type: "avatar.state", state: "thinking", reason: "replying" });

  // 4. Cloud work (chat, Agentverse friends, GitHub/Vercel/Notion) goes to the
  //    cloud agent through the toolkit. The agent never hallucinates a tool
  //    call that didn't run.
  const history = await recentHistory(userId, conversation.id, 14);
  let toolContext: string | undefined;
  try {
    const toolkit = await import("../agents/toolkit.js");
    toolContext = (await toolkit.runOrchestration(userId, effective)) ?? undefined;
  } catch {
    toolContext = undefined;
  }

  // Delegate (coordinator → specialist path) or run hub-local.
  await delegation.createTask({
    userId,
    conversationId: conversation.id,
    kind: "chat",
    title: `Reply: ${effective.slice(0, 44)}`,
    payload: { messageId: assistantMessage.id, text: effective, ...(toolContext ? { tools: toolContext } : {}) },
    context: {
      kind: "chat",
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      text: effective,
      history,
      memories: memoryContext,
      ...(toolContext ? { tools: toolContext } : {}),
    },
  });
}

/** Streaming stop: freeze the placeholder and cancel the pending task. */
async function handleStop(userId: string, conversationId: string, messageId: string): Promise<void> {
  const message = await getMessage(userId, conversationId, messageId);
  if (!message) return;
  await setMessageMeta(conversationId, messageId, { ...(message.meta ?? {}), streaming: false });
  const content = stripToolDumps(message.content || "— stopped —");
  await updateMessageContent(conversationId, messageId, content);
  await bus.emit(userId, {
    type: "chat.message",
    message: { ...message, content, meta: { ...message.meta, streaming: false } },
  });
  await query(
    `UPDATE agent_tasks SET status = 'cancelled', updated_at = now()
     WHERE status IN ('queued','running') AND payload->>'messageId' = $2`,
    [userId, messageId],
  );
}

/** Strip raw tool dumps (`<local.exec>…</local.exec>`, code fences) from a reply. */
export function stripToolDumps(text: string): string {
  let out = text;
  out = out.replace(/<local\.exec>[\s\S]*?<\/local\.exec>/gi, "");
  out = out.replace(/```[\s\S]*?```/g, (block) => {
    const lines = block.split("\n");
    const body = lines.slice(1, -1).join("\n");
    if (/Volume in drive|Directory of|File\(s\)|bytes free|^\s*<DIR>/i.test(body)) return "";
    return block;
  });
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

