import http from "node:http";
import cors from "cors";
import express from "express";
import { config, loadConfig } from "./config.js";
import { migrate, pool } from "./db/pool.js";
import { api } from "./routes/api.js";
import { hub } from "./ws/hub.js";
import { handleClientFrame } from "./chat/pipeline.js";
import { delegation } from "./agents/delegation.js";
import { finalizeChatTask } from "./agents/chat-finalize.js";
import { logger } from "./lib/logger.js";

loadConfig();

const app = express();
app.disable("x-powered-by");
if (config.allowedOrigins.length) {
  app.use(cors({ origin: config.allowedOrigins, credentials: false }));
} else {
  app.use(cors());
}
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, agents: hub.onlineAgentNames(), clients: hub.clientCount() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.use("/api", (req, res, next) => {
  // Express app path: the api router handles auth itself (public /auth prefix).
  next();
}, api);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(`[http] ${err.message}`);
  if (res.headersSent) return;
  res.status(500).json({ error: "internal", message: err.message });
});

// Chat-task finalization for AGENT-RUN tasks: agents stream text over the
// socket (text.delta) and return the complete content inside task.result.
// The local runner finishes its own tasks sooner, so skip messages already
// persisted (meta.streaming cleared by finalizeChatTask).
delegation.onTaskFinalized(async (task) => {
  if (task.kind === "memory" && task.userId && task.result) {
    // Memory tasks produce candidate items from agents (gateway or hosted).
    const result = task.result as { memories?: { kind?: string; content?: string; confidence?: number; importance?: number }[] };
    const { memoryService } = await import("./memory/memory-service.js");
    const { bus } = await import("./ws/bus.js");
    const conversationId = (task.result as { conversationId?: string }).conversationId ?? task.conversationId;
    const kinds = new Set<string>(["fact", "preference", "goal", "person", "routine", "project"]);
    for (const item of result.memories ?? []) {
      if (!item?.content || String(item.content).trim().length < 4) continue;
      const stored = await memoryService.insertFromExtraction(task.userId, conversationId, {
        kind: kinds.has(item.kind ?? "") ? (item.kind as "fact" | "preference" | "goal" | "person" | "routine" | "project") : "fact",
        content: String(item.content).slice(0, 400),
        confidence: Number(item.confidence ?? 60),
        importance: Number(item.importance ?? 3),
      });
      if (stored) await bus.emit(task.userId, { type: "memory.extracted", memories: [stored] });
    }
    return;
  }
  if (task.kind !== "chat" || !task.userId || !task.conversationId) return;
  const payload = task.payload as { messageId?: string };
  const messageId = payload.messageId;
  if (!messageId) return;
  const { getMessage } = await import("./chat/messages.js");
  const message = await getMessage(task.userId, task.conversationId, messageId);
  if (!message) return;
  if (!message.meta?.streaming) return; // already finalized (hub-local path)
  const result = (task.result ?? {}) as { content?: string; summary?: string };
  const content = result.content ?? result.summary ?? "(the agents finished without a text summary)";
  const source = `agent:${task.agent ?? "unknown"}`;
  await finalizeChatTask(task.id, task.userId, task.conversationId, messageId, content, source);
});

const server = http.createServer(app);
hub.attach(server, handleClientFrame);

await migrate().catch((err) => {
  logger.error(`[hi] migration failed: ${(err as Error).message}`);
  process.exit(1);
});

await delegation.startSweeper();

server.listen(config.port, config.host, () => {
  logger.info(`[hi] backend listening on http://${config.host}:${config.port}`);
  logger.info(`[hi] websocket at ws://localhost:${config.port}/ws`);
  logger.info(`[hi] ASI:ONE ${config.asi.apiKey ? "configured ✅" : "NOT configured (set ASI_ONE_API_KEY; hub-local research/chat will fail until it is)"}`);
  if (hub.onlineAgentNames().length === 0) {
    logger.info("[hi] no agents yet — starting the gateway");
    void startGateway();
  }
});

/**
 * Starts the Python uAgents gateway if nothing listens on its port yet. The
 * gateway is what makes Agentverse friends (and the coordinator's mailbox)
 * actually work, so the island auto-boots it instead of asking the user.
 */
async function startGateway(): Promise<void> {
  // Give a manually-started gateway a moment to connect first.
  await new Promise((r) => setTimeout(r, 4000));
  if (hub.onlineAgentNames().length > 0) return;
  const { spawn } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const path = await import("node:path");
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const agentsDir = path.resolve(here, "..", "..", "agents");
  if (!existsSync(path.join(agentsDir, "hi_agents"))) return;
  const candidates = [
    process.env.HI_PYTHON,
    "C:\\Python314\\python.exe",
    "python",
  ].filter(Boolean) as string[];
  const py = candidates.find((c) => {
    try {
      return existsSync(c) || c === "python";
    } catch {
      return c === "python";
    }
  });
  if (!py) return;
  try {
    const child = spawn(py, ["-m", "hi_agents.gateway"], {
      cwd: agentsDir,
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", (err) => logger.info(`[hi] gateway spawn failed: ${err.message}`));
    logger.info(`[hi] gateway launched (${py})`);
  } catch (err) {
    logger.info(`[hi] gateway launch failed: ${(err as Error).message}`);
  }
}
