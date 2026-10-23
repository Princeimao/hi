import type { AgentTask } from "@hi/shared";
import { updateMessageContent, setMessageMeta } from "../chat/messages.js";
import { bus } from "../ws/bus.js";
import { delegation } from "./delegation.js";
import { stripToolDumps } from "../chat/pipeline.js";

let todos: typeof import("./todos.js") | null = null;
/** Creates todos/timers the assistant asked for and returns display text. */
async function applyTodos(userId: string, content: string): Promise<string> {
  try {
    todos = todos ?? (await import("./todos.js"));
    const { extractTodoMarkers, createTodo } = todos;
    const { clean, items } = extractTodoMarkers(content);
    for (const text of items) {
      await createTodo(userId, text, "agent").catch(() => undefined);
    }
    // Timer markers: the assistant emits [timer: 300] (or 10m) and the dock's
    // countdown starts on every device.
    let text = items.length ? clean.trim() || content : content;
    text = text.replace(/\[\s*timer\s*:\s*(\d{1,4})\s*(m|s)?\s*\]/gi, (_m, n: string, unit?: string) => {
      const seconds = Math.min(60 * 60, Number(n) * (unit?.toLowerCase() === "m" ? 60 : 1));
      if (seconds > 0) void bus.emit(userId, { type: "chat.timer", seconds });
      return "";
    }).replace(/\n{3,}/g, "\n\n").trimEnd();
    return text;
  } catch {
    return content;
  }
}

/**
 * Completes a chat-kind task: persists the fully streamed assistant message,
 * emits the final chat.message durable event, and schedules cloud-memory
 * extraction as its own task (runs through the agent gateway when one is
 * online that accepts `memory`, otherwise hub-local).
 */
export async function finalizeChatTask(
  taskId: string,
  userId: string,
  conversationId: string,
  messageId: string,
  content: string,
  source: string,
): Promise<void> {
  const display = stripToolDumps(await applyTodos(userId, content));
  await updateMessageContent(conversationId, messageId, display);
  const meta = { streaming: false, source };
  await setMessageMeta(conversationId, messageId, meta);

  const { getMessage } = await import("../chat/messages.js");
  const message = await getMessage(userId, conversationId, messageId);
  if (message) {
    await bus.emit(userId, { type: "chat.message", message });
  }
  await bus.emit(userId, { type: "avatar.state", state: "idle", reason: "reply ready" });

  await delegation.createTask({
    userId,
    conversationId,
    kind: "memory",
    title: "Remember what matters from this exchange",
    payload: { conversationId, fromTask: taskId },
    context: { kind: "generic", conversationId },
  });
}

/** Bumps use stats for memories that were passed to a completion (no-op helper). */
export async function touchMessages(_ids: string[]): Promise<void> {
  void _ids;
}
