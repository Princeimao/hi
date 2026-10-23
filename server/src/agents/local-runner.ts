import type { TaskAssignment } from "@hi/shared";
import { asiChat, asiChatStream, asiJson, NotConfiguredError } from "../asi/asi-one.js";
import { config } from "../config.js";
import { bus } from "../ws/bus.js";
import { memoryService } from "../memory/memory-service.js";
import { delegation } from "./delegation.js";
import { logActivity } from "./activity.js";
import { finalizeChatTask } from "./chat-finalize.js";

/**
 * Hub-local execution used when no uAgent with the needed capability is
 * online. It is the same execution the agents perform when connected — calling
 * the real ASI:ONE API — so turning the agent gateway on or off only changes
 * *where* the work runs, not what the user sees.
 */

export type LocalContext = TaskAssignment["context"];

async function userIdOf(taskId: string): Promise<string | null> {
  const { one } = await import("../db/pool.js");
  const row = await one<{ user_id: string }>(`SELECT user_id FROM agent_tasks WHERE id = $1`, [
    taskId,
  ]);
  return row?.user_id ?? null;
}

function asyncStepText(kind: string): string[] {
  switch (kind) {
    case "chat":
      return ["Composing a reply with ASI:ONE"];
    case "research":
      return ["Searching the live web with ASI:ONE", "Synthesizing findings"];
    case "plan":
      return ["Analyzing the request", "Drafting a plan"];
    case "memory":
      return ["Reading recent conversation", "Extracting durable memories"];
    default:
      return ["Working"];
  }
}

export async function runLocally(task: { id: string; userId?: string; kind: string; payload: Record<string, unknown> }, context: LocalContext): Promise<void> {
  const userId = task.userId ?? (await userIdOf(task.id));
  if (!userId) throw new Error("task user not found");
  try {
    switch (task.kind) {
      case "chat":
        return await runChatLocal(task.id, userId, context);
      case "research":
        return await runResearch(task.id, userId, context);
      case "plan":
        return await runPlan(task.id, userId, context);
      case "memory":
        return await runMemory(task.id, userId, context);
      default:
        return await fallbackComplete(task.id, userId, context);
    }
  } catch (err) {
    await delegation.applyError(task.id, "hub-local", (err as Error).message);
  }
}

// ── chat ─────────────────────────────────────────────────────────────────────

async function runChatLocal(taskId: string, userId: string, context: LocalContext): Promise<void> {
  if (context.kind !== "chat") throw new Error("chat task without chat context");
  const { text, memories, history, conversationId, messageId } = context;
  await delegation.applyStep(taskId, "hub-local", asyncStepText("chat")[0]);
  await delegation.applyUpdate(taskId, { status: "running", progress: 20 });

  const system = [
    "You are Hi, a warm, quick, slightly playful personal AI companion living in a little floating purple character on the user's desktop.",
    "Keep answers tight and useful; use light markdown. Use what you remember about the person but never enumerate memories unless asked.",
    'When the user asks you to add/todo/remember something actionable (e.g. "add a todo to call mom"), append a marker line like [todo: call mom] to your reply exactly once per item; never mention the marker itself.',
    'When the user asks for a timer or countdown ("set a 10 minute timer"), append [timer: 10m] to your reply; never mention the marker.',
    "If the request clearly needed a connected agent (flight, map, search) and you also have Cal.com or Notion connected, end with a short follow-up offer like: 'Want me to put this trip on your Cal.com calendar or save it to Notion?' — only when it genuinely fits, never as a generic closer.",
    "When a tool result is provided below, that is real output from the user's machine — present it clearly, credit the source, never invent tool data, and NEVER claim you ran a command yourself.",
    "NEVER fabricate tool calls or say a command failed unless the tool result below says so. If no tool result is provided, you have no local access — answer from conversation only.",
  ].join(" ");
  const memoryLines = memories?.length
    ? `Things you remember about the person:\n${memories.map((m) => `- (${m.kind}) ${m.content}`).join("\n")}`
    : "";
  const toolLines = context.tools
    ? `\n\nA tool was run for this request — its result is below. Use it, credit the source, never invent tool data:\n${context.tools}`
    : "";

  const messages: import("../asi/asi-one.js").AsiMessage[] = [
    { role: "system", content: system + memoryLines + toolLines },
    ...(history ?? []),
    { role: "user", content: text },
  ];

  let full = "";
  let flushAt = Date.now();
  try {
    for await (const ev of asiChatStream(messages)) {
      if (ev.type === "delta") {
        full += ev.delta;
        const now = Date.now();
        if (now - flushAt > 55) {
          flushAt = now;
          bus.live(userId, { type: "chat.delta", messageId, conversationId, text: full });
        }
      }
    }
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      await delegation.applyError(taskId, "hub-local", (err as Error).message);
      return;
    }
    throw err;
  }
  bus.live(userId, { type: "chat.delta", messageId, conversationId, text: full });
  await finalizeChatTask(taskId, userId, conversationId, messageId, full, `hub-local via ${config.asi.model}`);
}

// ── research ────────────────────────────────────────────────────────────────

async function runResearch(taskId: string, userId: string, context: LocalContext): Promise<void> {
  const goal =
    context.kind === "chat"
      ? context.text
      : String((context as { kind: string }).kind);
  const promptText = extractPrompt(context) ?? goal ?? "Research the request.";
  await delegation.applyStep(taskId, "hub-local", "Searching the live web with ASI:ONE");
  const result = await asiChat(
    [
      {
        role: "system",
        content:
          "You are the Researcher agent in the Hi companion. Research the request with live web search and give: a short synthesis (3-6 sentences), then 3-8 bullet findings with facts, then a `Sources:` list of the URLs you relied on.",
      },
      { role: "user", content: promptText },
    ],
    { webSearch: true, temperature: 0.5 },
  );
  await delegation.applyStep(taskId, "hub-local", "Synthesizing findings");
  await delegation.applyResult(
    taskId,
    "hub-local",
    { report: result.content, citedUrls: extractUrls(result.content), query: promptText },
    result.content.split("\n")[0]?.slice(0, 120) ?? "Research done",
  );
}

// ── plan ────────────────────────────────────────────────────────────────────

interface PlanJson {
  title?: string;
  steps?: { label: string; detail?: string }[];
}

async function runPlan(taskId: string, userId: string, context: LocalContext): Promise<void> {
  const promptText = extractPrompt(context) ?? "Plan this.";
  await delegation.applyStep(taskId, "hub-local", "Drafting a plan");
  const plan = await asiJson<PlanJson>(
    [
      {
        role: "system",
        content:
          'You are the Planner agent of the Hi companion. Return pure JSON: {"title": string, "steps": [{"label": string, "detail"?: string}]} with 3-9 concise, concrete steps.',
      },
      { role: "user", content: promptText },
    ],
    { temperature: 0.3 },
  );
  const steps = (plan.steps ?? []).map((s) => s.label).filter(Boolean).slice(0, 9);
  await delegation.applyResult(
    taskId,
    "hub-local",
    { plan: plan, steps },
    `Plan: ${plan.title?.slice(0, 80) ?? steps.length + " steps"}`,
  );
}

// ── memory ──────────────────────────────────────────────────────────────────

async function runMemory(taskId: string, userId: string, context: LocalContext): Promise<void> {
  await delegation.applyStep(taskId, "hub-local", "Extracting durable memories");
  const conversationId =
    context.kind === "chat" ? context.conversationId : ((context as { conversationId?: string }).conversationId ?? null);
  const { text, reply } = await extractTurn(userId, conversationId);
  const memories = await memoryService.extractFromTurn(userId, conversationId, text, reply ?? "");
  for (const memory of memories) {
    await bus.emit(userId, { type: "memory.extracted", memories: [memory] });
  }
  await logActivity(
    userId,
    "hub-local",
    memories.length ? `Saved ${memories.length} new memor${memories.length === 1 ? "y" : "ies"}` : "Nothing durable to remember",
    "info",
    taskId,
  );
  await delegation.applyResult(
    taskId,
    "hub-local",
    { memories: memories.map((m) => m.content), count: memories.length },
    memories.length ? `Remembered ${memories.length} new items` : "Nothing new to remember",
  );
}

async function extractTurn(
  userId: string,
  conversationId: string | null,
): Promise<{ text: string; reply: string }> {
  if (!conversationId) return { text: "", reply: "" };
  const { recentHistory } = await import("../chat/messages.js");
  const history = await recentHistory(userId, conversationId, 4);
  const lastUser = [...history].reverse().find((h) => h.role === "user");
  const lastReply = [...history].reverse().find((h) => h.role === "assistant");
  return { text: lastUser?.content ?? "", reply: lastReply?.content ?? "" };
}

// ── custom ──────────────────────────────────────────────────────────────────

async function fallbackComplete(
  taskId: string,
  userId: string,
  context: LocalContext,
): Promise<void> {
  const promptText = extractPrompt(context) ?? "Complete the task.";
  const result = await asiChat(
    [
      { role: "system", content: "You are a specialist agent in the Hi companion. Complete the task crisply." },
      { role: "user", content: promptText },
    ],
    { temperature: 0.5 },
  );
  await delegation.applyResult(
    taskId,
    "hub-local",
    { output: result.content },
    result.content.slice(0, 100),
  );
}

function extractPrompt(context: LocalContext): string | null {
  if (context.kind === "chat") return context.text;
  const ctx = context as { kind: string; task?: { payload?: { prompt?: string; text?: string } } };
  return ctx.task?.payload?.prompt ?? ctx.task?.payload?.text ?? null;
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)\]]+/g) ?? [];
  return [...new Set(matches)].slice(0, 12);
}
