import { Router } from "express";
import { z } from "zod";
import { requireUser, requireAgent, type AuthedRequest } from "../auth/middleware.js";
import { query, one, pool } from "../db/pool.js";
import { parseIntParam } from "../lib/validate.js";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  renameConversation,
} from "../chat/messages.js";
import { memoryService } from "../memory/memory-service.js";
import { notificationService } from "../services/notifications.js";
import { recentActivity } from "../agents/activity.js";
import { delegation } from "../agents/delegation.js";
import { agentRegistry } from "../agents/registry.js";
import { rowToMemory } from "../memory/memory-service.js";
import * as integrations from "../integrations/service.js";
import * as friends from "../integrations/friends.js";
import * as todos from "../agents/todos.js";

export const api = Router();
api.use("/auth", (await import("./auth.js")).authRouter);

// Everything below requires a user token and silently scopes by user id.
api.use((req, res, next) => (req.path === "/auth" ? next() : requireUser(req, res, next)));

// â”€â”€ Me / devices / preferences â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Todo list, shared by the island and the agents.
api.get("/todos", async (req, res) => {
  const includeDone = String(req.query.done ?? "1") !== "0";
  const rows = await todos.listTodos((req as unknown as AuthedRequest).auth.userId, includeDone);
  res.json(rows);
});

api.post("/todos", async (req, res) => {
  const parsed = z.object({ text: z.string().min(1).max(160) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
    return;
  }
  const todo = await todos.createTodo((req as unknown as AuthedRequest).auth.userId, parsed.data.text, "user");
  res.status(201).json(todo);
});

api.patch("/todos/:id", async (req, res) => {
  const parsed = z.object({ done: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
    return;
  }
  const row = await todos.setTodoDone((req as unknown as AuthedRequest).auth.userId, req.params.id, parsed.data.done);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(row);
});

api.delete("/todos/:id", async (req, res) => {
  const ok = await todos.deleteTodo((req as unknown as AuthedRequest).auth.userId, req.params.id);
  if (!ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

// Me / devices / preferences
api.get("/me", async (req, res) => {
  const userId = (req as unknown as AuthedRequest).auth.userId;
  const user = await one<{ id: string; email: string; display_name: string; asi_model: string; preferences: unknown }>(
    `SELECT id, email, display_name, asi_model, preferences FROM users WHERE id = $1`,
    [userId],
  );
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const devices = await query<{ id: string; kind: string; name: string; last_seen_at: string; cursor: string }>(
    `SELECT id, kind, name, last_seen_at, cursor FROM devices WHERE user_id = $1 ORDER BY last_seen_at DESC`,
    [userId],
  );
  res.json({
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    asiModel: user.asi_model,
    preferences: user.preferences ?? {},
    devices: devices.map((d) => ({
      id: d.id,
      kind: d.kind,
      name: d.name,
      lastSeenAt: d.last_seen_at,
      cursor: Number(d.cursor),
    })),
    agentsOnline: agentRegistry.allNames(),
  });
});

const prefsSchema = z.object({
  displayName: z.string().max(60).optional(),
  asiModel: z.enum(["asi1", "asi1-ultra", "asi1-mini"]).optional(),
  preferences: z.record(z.unknown()).optional(),
});

api.patch("/me", async (req, res) => {
  const userId = (req as unknown as AuthedRequest).auth.userId;
  const parsed = prefsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
    return;
  }
  const row = await one<{ id: string; display_name: string; asi_model: string; preferences: unknown }>(
    `UPDATE users SET
       display_name = COALESCE($2, display_name),
       asi_model = COALESCE($3, asi_model),
       preferences = COALESCE($4::jsonb, preferences),
       updated_at = now()
     WHERE id = $1 RETURNING id, display_name, asi_model, preferences`,
    [userId, parsed.data.displayName ?? null, parsed.data.asiModel ?? null, parsed.data.preferences ? JSON.stringify(parsed.data.preferences) : null],
  );
  res.json({ id: row!.id, displayName: row!.display_name, asiModel: row!.asi_model, preferences: row!.preferences });
});

api.delete("/me", async (req, res) => {
  const userId = (req as unknown as AuthedRequest).auth.userId;
  await query(`DELETE FROM users WHERE id = $1`, [userId]);
  res.status(204).end();
});

// â”€â”€ Conversations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

api.get("/conversations", async (req, res) => {
  res.json(await listConversations((req as unknown as AuthedRequest).auth.userId));
});

api.post("/conversations", async (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title : "New conversation";
  res.status(201).json(await createConversation((req as unknown as AuthedRequest).auth.userId, title));
});

api.get("/conversations/:id", async (req, res) => {
  const conversation = await getConversation((req as unknown as AuthedRequest).auth.userId, req.params.id);
  if (!conversation) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const messages = await listMessages((req as unknown as AuthedRequest).auth.userId, req.params.id, {
    limit: parseIntParam(req.query.limit as string | undefined, 300),
  });
  res.json({ conversation, messages });
});

api.patch("/conversations/:id", async (req, res) => {
  const title = String(req.body?.title ?? "").trim();
  if (!title) {
    res.status(400).json({ error: "title required" });
    return;
  }
  const updated = await renameConversation((req as unknown as AuthedRequest).auth.userId, req.params.id, title);
  if (!updated) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(updated);
});

api.delete("/conversations/:id", async (req, res) => {
  res.json({ deleted: await deleteConversation((req as unknown as AuthedRequest).auth.userId, req.params.id) });
});

// â”€â”€ Memories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

api.get("/memories", async (req, res) => {
  const kind = typeof req.query.kind === "string" ? (req.query.kind as never) : undefined;
  res.json(
    await memoryService.list((req as unknown as AuthedRequest).auth.userId, {
      kind: kind ?? "all",
      limit: parseIntParam(req.query.limit as string | undefined, 200),
    }),
  );
});

api.get("/memories/search", async (req, res) => {
  const term = String(req.query.q ?? "");
  res.json(await memoryService.search((req as unknown as AuthedRequest).auth.userId, term));
});

api.delete("/memories/:id", async (req, res) => {
  const deleted = await memoryService.delete((req as unknown as AuthedRequest).auth.userId, req.params.id);
  if (deleted) {
    await (await import("../ws/bus.js")).bus.emit((req as unknown as AuthedRequest).auth.userId, {
      type: "memory.deleted",
      memoryId: req.params.id,
    });
  }
  res.json({ deleted });
});

api.delete("/memories", async (req, res) => {
  const count = await memoryService.clear((req as unknown as AuthedRequest).auth.userId);
  res.json({ deleted: count });
});

const importanceSchema = z.object({ importance: z.number().int().min(1).max(5) });

api.patch("/memories/:id", async (req, res) => {
  const parsed = importanceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const updated = await memoryService.setImportance(
    (req as unknown as AuthedRequest).auth.userId,
    req.params.id,
    parsed.data.importance,
  );
  if (!updated) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(updated);
});

// â”€â”€ Tasks & agent activity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

api.get("/tasks", async (req, res) => {
  const userId = (req as unknown as AuthedRequest).auth.userId;
  const status = req.query.status ? String(req.query.status) : null;
  const limit = parseIntParam(req.query.limit as string | undefined, 50);
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM agent_tasks WHERE user_id = $1 ${status ? "AND status = $2" : ""}
     ORDER BY created_at DESC LIMIT ${status ? "$3" : "$2"}`,
    status ? [userId, status, limit] : [userId, limit],
  );
  res.json(rows);
});

api.get("/tasks/:id", async (req, res) => {
  const row = await one(`SELECT * FROM agent_tasks WHERE id = $1 AND user_id = $2`, [
    req.params.id,
    (req as unknown as AuthedRequest).auth.userId,
  ]);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const steps = await query(`SELECT id, level, message, agent, created_at FROM agent_activity
     WHERE task_id = $1 ORDER BY id ASC LIMIT 200`, [req.params.id]);
  res.json({ task: row, steps });
});

api.post("/tasks", async (req, res) => {
  const schema = z.object({
    kind: z.enum(["research", "plan", "custom"]).default("custom"),
    title: z.string().min(1).max(120),
    payload: z.record(z.unknown()).default({}),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
    return;
  }
  const task = await delegation.createTask({
    userId: (req as unknown as AuthedRequest).auth.userId,
    conversationId: null,
    kind: parsed.data.kind,
    title: parsed.data.title,
    payload: { ...parsed.data.payload, prompt: parsed.data.payload.prompt ?? parsed.data.title },
    context: { kind: "generic" },
  });
  res.status(201).json(task);
});

api.delete("/tasks/:id", async (req, res) => {
  const userId = (req as unknown as AuthedRequest).auth.userId;
  await one(
    `UPDATE agent_tasks SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status IN ('queued','running') RETURNING id`,
    [req.params.id, userId],
  );
  res.status(204).end();
});

api.get("/agents/activity", async (req, res) => {
  res.json(await recentActivity((req as unknown as AuthedRequest).auth.userId, parseIntParam(req.query.limit as string | undefined, 60)));
});

// â”€â”€ Notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

api.get("/notifications", async (req, res) => {
  res.json(
    await notificationService.list(
      (req as unknown as AuthedRequest).auth.userId,
      parseIntParam(req.query.limit as string | undefined, 50),
      req.query.unread === "true",
    ),
  );
});

api.post("/notifications/read", async (req, res) => {
  const ids = z.array(z.string().uuid()).parse(req.body?.ids ?? []);
  res.json({ marked: await notificationService.markRead((req as unknown as AuthedRequest).auth.userId, ids) });
});

// â”€â”€ Sync bootstrap (cold clients) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

api.get("/sync/bootstrap", async (req, res) => {
  const userId = (req as unknown as AuthedRequest).auth.userId;
  const conversations = await listConversations(userId, 80);
  const messagesByConversation: Record<string, unknown[]> = {};
  for (const conversation of conversations.slice(0, 20)) {
    messagesByConversation[conversation.id] = await listMessages(userId, conversation.id, { limit: 120 });
  }
  const memories = await memoryService.list(userId, { limit: 100 });
  const tasks = await query<Record<string, unknown>>(
    `SELECT * FROM agent_tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`,
    [userId],
  );
  const activity = await recentActivity(userId, 40);
  const notifications = await notificationService.list(userId, 30);
  res.json({ conversations, messagesByConversation, memories, tasks, activity, notifications });
});

// â”€â”€ Agent HTTP API (for Agentverse-hosted agents using pull mode) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// ── Service integrations — token setup flow + real data reads ─────────────────

api.get("/integrations", async (req, res) => {
  res.json(await integrations.listIntegrations((req as unknown as AuthedRequest).auth.userId));
});

api.put("/integrations/:service", async (req, res) => {
  const service = String(req.params.service ?? "");
  const token = String(req.body?.token ?? "").trim();
  if (!integrations.isService(service)) {
    res.status(404).json({ error: "unknown_service" });
    return;
  }
  if (!token) {
    res.status(400).json({ error: "invalid_request", detail: "token required" });
    return;
  }
  try {
    res.json(await integrations.connect((req as unknown as AuthedRequest).auth.userId, service, token));
  } catch (err) {
    if (err instanceof integrations.UpstreamError) {
      res.status(400).json({ error: "upstream", message: err.message });
    } else {
      res.status(500).json({ error: "internal", message: (err as Error).message });
    }
  }
});

api.delete("/integrations/:service", async (req, res) => {
  res.json({
    disconnected: await integrations.disconnect(
      (req as unknown as AuthedRequest).auth.userId,
      String(req.params.service ?? ""),
    ),
  });
});

// One read path per service: repos / pulls / deployments / search / bookings.
api.get("/integrations/:service/items", async (req, res) => {
  const service = String(req.params.service ?? "");
  const userId = (req as unknown as AuthedRequest).auth.userId;
  const limit = parseIntParam(req.query.limit as string | undefined, 20);
  try {
    if (service === "github") {
      const repo = String(req.query.repo ?? "");
      res.json(
        repo ? await integrations.githubPulls(userId, repo, limit) : await integrations.githubRepos(userId, limit),
      );
    } else if (service === "vercel") {
      res.json(await integrations.vercelDeployments(userId, limit));
    } else if (service === "notion") {
      res.json(await integrations.notionSearch(userId, String(req.query.q ?? ""), limit));
    } else if (service === "calcom") {
      res.json(await integrations.calBookings(userId, limit));
    } else {
      res.status(404).json({ error: "unknown_service" });
    }
  } catch (err) {
    if (err instanceof integrations.NotConfiguredError) {
      res.status(409).json({ error: "not_configured", service: err.service, message: err.message });
    } else if (err instanceof integrations.UpstreamError) {
      res.status(502).json({ error: "upstream", message: err.message });
    } else {
      res.status(500).json({ error: "internal", message: (err as Error).message });
    }
  }
});

// Read path uses /items; ElevenLabs voices ride the same convention.
api.get("/integrations/elevenlabs/voices", async (req, res) => {
  try {
    res.json(await integrations.elevenVoiceList((req as unknown as AuthedRequest).auth.userId));
  } catch (err) {
    if (err instanceof integrations.NotConfiguredError) {
      res.status(409).json({ error: "not_configured", message: err.message });
    } else {
      res.status(502).json({ error: "upstream", message: (err as Error).message });
    }
  }
});

// Text-to-speech: spoken replies for phone/desktop. MP3 passthrough.
api.post("/voice/stt", async (req, res) => {
  const userId = (req as unknown as AuthedRequest).auth.userId;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  const audio = Buffer.concat(chunks);
  const mime = String(req.headers["content-type"] ?? "audio/webm").split(";")[0].trim();
  const { transcribeSpeech } = await import("../integrations/service.js");
  type STTDetail = Awaited<ReturnType<typeof transcribeSpeech>>;
  const out = (await transcribeSpeech(userId, audio, mime)) as Exclude<STTDetail, { text: string }> | { text: string };
  if ("text" in out && typeof out.text === "string") {
    res.json({ text: out.text });
    return;
  }
  const detail = out as Exclude<STTDetail, { text: string }>;
  res.status(detail.status).json({ error: detail.error, message: detail.reason });
});

api.post("/voice/tts", async (req, res) => {
  const text = String(req.body?.text ?? "");
  const voiceId = typeof req.body?.voiceId === "string" ? req.body.voiceId : undefined;
  const userId = (req as unknown as AuthedRequest).auth.userId;
  const stream = await integrations.streamTextToSpeech(userId, text, voiceId);
  if (!("body" in stream)) {
    res.status(stream.status).json({ error: stream.error, message: stream.reason });
    return;
  }
  res.setHeader("Content-Type", stream.headers.get("content-type") ?? "audio/mpeg");
  res.status(200);
  const reader = stream.body?.getReader();
  if (!reader) {
    res.status(502).json({ error: "upstream", message: "empty audio stream" });
    return;
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch {
    res.end();
  }
});

// ── Friends: external agents discovered on Agentverse ────────────────────────

api.get("/friends/discover", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (!q) {
      res.status(400).json({ error: "invalid_request", message: "q required" });
      return;
    }
    res.json(await friends.discover(q, Math.min(Number(req.query.limit ?? 10), 20)));
  } catch (err) {
    res.status(502).json({ error: "upstream", message: (err as Error).message });
  }
});

api.get("/friends/facts", async (req, res) => {
  const address = String(req.query.address ?? "");
  res.json(await friends.agentFacts(address));
});

api.get("/friends", async (req, res) => {
  res.json(await friends.listFriends((req as unknown as AuthedRequest).auth.userId));
});

api.post("/friends", async (req, res) => {
  try {
    res.status(201).json(
      await friends.connect((req as unknown as AuthedRequest).auth.userId, {
        address: String(req.body?.address ?? ""),
        name: String(req.body?.name ?? "").slice(0, 120),
        readme: String(req.body?.readme ?? "").slice(0, 4000),
        status: String(req.body?.status ?? "unknown"),
      }),
    );
  } catch (err) {
    if (err instanceof friends.DuplicateError) res.status(409).json({ error: "already_connected", message: err.message });
    else res.status(400).json({ error: "invalid_request", message: (err as Error).message });
  }
});

api.delete("/friends/:id", async (req, res) => {
  res.json({ removed: await friends.disconnect((req as unknown as AuthedRequest).auth.userId, String(req.params.id)) });
});

api.get("/friends/:id/messages", async (req, res) => {
  res.json(await friends.history((req as unknown as AuthedRequest).auth.userId, String(req.params.id)));
});

api.post("/friends/:id/message", async (req, res) => {
  try {
    res.status(201).json(await friends.send((req as unknown as AuthedRequest).auth.userId, String(req.params.id), String(req.body?.text ?? "")));
  } catch (err) {
    res.status(400).json({ error: "invalid_request", message: (err as Error).message });
  }
});

const agentApi = Router();
agentApi.use(requireAgent);

// Fetch queued tasks the hosted agent can claim (kinds: research, plan, chat, memory, custom).
agentApi.get("/tasks", async (req, res) => {
  const kinds = String(req.query.kinds ?? "")
    .split(",")
    .filter(Boolean);
  const frames = await delegation.tryClaim(String(req.query.agent ?? "hosted-agent"), kinds);
  res.json(frames);
});

// Push task updates/results from hosted agents over plain HTTPS.
agentApi.post("/events", async (req, res) => {
  const schema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("task.update"), taskId: z.string().uuid(), status: z.string().optional(), progress: z.number().optional() }),
    z.object({ type: z.literal("task.step"), taskId: z.string().uuid(), label: z.string() }),
    z.object({ type: z.literal("task.result"), taskId: z.string().uuid(), result: z.record(z.unknown()), summary: z.string().optional() }),
    z.object({ type: z.literal("task.error"), taskId: z.string().uuid(), error: z.string() }),
    z.object({ type: z.literal("task.await"), taskId: z.string().uuid(), question: z.string(), options: z.array(z.string()).optional() }),
    z.object({ type: z.literal("text.delta"), taskId: z.string().uuid(), text: z.string() }),
    z.object({ type: z.literal("agent.log"), level: z.enum(["info", "warn", "error"]).default("info"), message: z.string(), taskId: z.string().uuid().optional() }),
  ]);
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_frame", detail: parsed.error.issues });
    return;
  }
  const f = parsed.data;
  try {
    switch (f.type) {
      case "task.update":
        await delegation.applyUpdate(f.taskId, { status: f.status as never, progress: f.progress });
        break;
      case "task.step":
        await delegation.applyStep(f.taskId, "agentverse", f.label);
        break;
      case "task.result":
        await delegation.applyResult(f.taskId, "agentverse", f.result, f.summary);
        break;
      case "task.error":
        await delegation.applyError(f.taskId, "agentverse", f.error);
        break;
      case "task.await":
        await delegation.applyAwaitingInput(f.taskId, "agentverse", f.question, f.options);
        break;
      case "text.delta":
        await delegation.applyTextDelta(f.taskId, "agentverse", f.text);
        break;
      case "agent.log":
        await (await import("../agents/activity.js")).logActivity("", "agentverse", f.message, f.level, f.taskId ?? null);
        break;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

api.use("/agent", agentApi);

// Convenience: run pool ping under /healthz in index.ts.
void pool;
void rowToMemory;
