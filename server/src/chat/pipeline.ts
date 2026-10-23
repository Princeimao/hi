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

/** Last Pi cwd per conversation, so follow-ups ("name all of them") reuse it. */
const lastLocalCwd = new Map<string, { cwd?: string; at: number }>();
const LOCAL_FOLLOWUP_MS = 5 * 60_000;

/**
 * A short referential follow-up right after a local run: "name all of them",
 * "what about the others", "open the first one", "how big is it".
 */
export function isLocalFollowup(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (t.length > 160) return false;
  return /\b(them|those|these|it|its|the first|the second|the last|the others|all of|list (em|them)|name (em|them)|show (em|them)|what about|how (big|many|much|long)|open (it|the first|the last)|read (it|the first|the last)|the rest|same (one|folder|directory|drive))\b/i.test(t);
}

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

  // 4. Split local vs cloud. Local file / code / search work runs the Pi agent
  //    directly on this machine (child_process, no island round-trip). Cloud
  //    work (chat, Agentverse friends, GitHub/Vercel/Notion) goes to the
  //    cloud agent. The agent never hallucinates a tool call that didn't run.
  const history = await recentHistory(userId, conversation.id, 14);
  let localTask = detectLocalTask(effective);

  // Follow-up: a short referential message right after a local run reuses the
  // last cwd, so "name all of them" after "files in E:\" still hits Pi.
  if (!localTask) {
    const prev = lastLocalCwd.get(conversation.id);
    if (prev && Date.now() - prev.at < LOCAL_FOLLOWUP_MS && isLocalFollowup(effective)) {
      localTask = { prompt: effective, cwd: prev.cwd };
    }
  }

  if (localTask) {
    lastLocalCwd.set(conversation.id, { cwd: localTask.cwd, at: Date.now() });
    // Local: run Pi now, then have the cloud agent write the final reply using
    // Pi's output as context. Pi is the hands; the cloud agent is the voice.
    let piOutput = "";
    try {
      const { runPiTask } = await import("../agents/pi-runner.js");
      piOutput = await runPiTask(localTask.prompt, localTask.cwd);
    } catch (err) {
      piOutput = `(Pi failed to run: ${err instanceof Error ? err.message : String(err)})`;
    }
    await delegation.createTask({
      userId,
      conversationId: conversation.id,
      kind: "chat",
      title: `Reply: ${effective.slice(0, 44)}`,
      payload: { messageId: assistantMessage.id, text: effective, tools: piOutput },
      context: {
        kind: "chat",
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        text: effective,
        history,
        memories: memoryContext,
        tools: piOutput,
        local: true,
      },
    });
    return;
  }

  // Cloud: normal chat, friends, integrations.
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

/**
 * Detect a local file / code / search task and describe it for Pi.
 * Returns null when the message is cloud work (chat, friends, integrations).
 */
export function detectLocalTask(text: string): { prompt: string; cwd?: string } | null {
  const t = text.toLowerCase().trim();

  // "list files in X" / "what's in X" / "dir X" / "ls X"
  const dirMatch =
    t.match(/(?:list|show|see|what(?:'s| is) in|open|browse)\s+(?:the\s+)?(?:files?|folder|directory|contents?)\s+(?:in|of|at|under)\s+['"]?([^\s'"]+)/i) ??
    t.match(/(?:dir|ls)\s+['"]?([^\s'"]+)/i);
  if (dirMatch) {
    const p = dirMatch[1].replace(/[.,;:!?]+$/, "");
    return { prompt: `List the files and folders in ${p}. Show names, sizes and dates.`, cwd: p };
  }

  const bare = t.match(/^(?:dir|ls)\s+['"]?([^\s'"]+)['"]?\s*$/i);
  if (bare) return { prompt: `List the files and folders in ${bare[1]}. Show names, sizes and dates.`, cwd: bare[1] };

  // "search/find/look for X in Y"
  const searchMatch = t.match(/(?:search|find|look\s+for|grep|locate)\s+(?:['"]?([^'"]+?)['"]?)\s+(?:in|inside|within)\s+['"]?([^\s'"]+)/i);
  if (searchMatch) {
    return {
      prompt: `Search for files matching "${searchMatch[1].trim()}" inside ${searchMatch[2]}. List the matching paths.`,
      cwd: searchMatch[2],
    };
  }

  // "read/open file X"
  const readMatch = t.match(/(?:read|open|show|cat|type)\s+(?:the\s+)?(?:file\s+)?['"]?([^\s'"]+\.[a-z0-9]+)['"]?/i);
  if (readMatch) return { prompt: `Read the file ${readMatch[1]} and show its contents.` };

  // "write/create/build/code X" — coding tasks, let Pi pick the folder via clarify
  if (/\b(write|create|build|code|implement|make|generate|add|fix|refactor|debug)\b/i.test(t) && /\b(function|component|file|script|feature|module|class|test|page|button|api|endpoint|util)\b/i.test(t)) {
    return { prompt: text };
  }

  return null;
}
