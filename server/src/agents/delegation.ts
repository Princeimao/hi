import type { AgentTask, TaskKind, TaskStatus } from "@hi/shared";
import { one, query } from "../db/pool.js";
import { bus } from "../ws/bus.js";
import { hub } from "../ws/hub.js";
import { agentRegistry } from "./registry.js";
import { logActivity } from "./activity.js";
import { runLocally } from "./local-runner.js";

export { type AgentHandle } from "./registry-types.js";

interface TaskRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  agent: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  progress: number;
  created_at: string;
  updated_at: string;
}

function rowToTask(r: TaskRow): AgentTask {
  return {
    id: r.id,
    userId: r.user_id,
    conversationId: r.conversation_id,
    kind: r.kind,
    title: r.title,
    status: r.status,
    agent: r.agent,
    payload: r.payload ?? {},
    result: r.result,
    error: r.error,
    progress: r.progress,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function getTask(id: string): Promise<TaskRow | null> {
  return one<TaskRow>(`SELECT * FROM agent_tasks WHERE id = $1`, [id]);
}

/**
 * The delegation engine: owns agent tasks from `queued` to terminal state.
 *
 * Two real execution paths, both shipping in this repo:
 *  1. uAgents gateway — the coordinator/specialist agents (Python uAgents)
 *     connect to the hub WebSocket with AGENT_TOKEN, receive `task.assign`
 *     frames, stream progress/steps/deltas and post results through the same
 *     socket (or through the HTTP api when hosted on Agentverse).
 *  2. Hub-local runner — when no agent with the right capability is online,
 *     the backend executes the same task itself by calling ASI:ONE directly
 *     so the companion keeps working with agents offline.
 */
class Delegation {
  private finalizers = new Set<(task: AgentTask) => Promise<void>>();

  onTaskFinalized(fn: (task: AgentTask) => Promise<void>): () => void {
    this.finalizers.add(fn);
    return () => this.finalizers.delete(fn);
  }

  /**
   * Create a task, broadcast it, and assign it to the best online agent.
   * `context` is passed through to chat tasks (history + memories included).
   */
  async createTask(opts: {
    userId: string;
    conversationId: string | null;
    kind: TaskKind;
    title: string;
    payload: Record<string, unknown>;
    context?: Record<string, unknown>;
  }): Promise<AgentTask> {
    const storedPayload = opts.context
      ? { ...opts.payload, context: opts.context }
      : opts.payload;
    const row = await one<TaskRow>(
      `INSERT INTO agent_tasks (user_id, conversation_id, kind, title, payload, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'queued')
       RETURNING *`,
      [opts.userId, opts.conversationId, opts.kind, opts.title, JSON.stringify(storedPayload)],
    );
    const task = rowToTask(row!);
    await bus.emit(task.userId!, { type: "task.created", task });
    await logActivity(task.userId!, "system", `Task created: ${task.title}`, "info", task.id);
    await this.assign(
      task,
      (storedPayload.context ?? { kind: "generic" }) as Record<string, unknown>,
    );
    return task;
  }

  /** Push the task to an online agent, or run it locally on the hub. */
  private async assign(task: AgentTask, context: Record<string, unknown>): Promise<void> {
    // Coding tasks never touch the agent registry: the user's authenticated
    // desktop island runs the real CLI and streams progress back.
    if (task.kind === "coding") {
      const { codingBroker, codingContextFrom } = await import("./coding.js");
      await codingBroker.dispatch(task, codingContextFrom(context, task.title));
      return;
    }
    const candidates = agentRegistry.byCapability(task.kind);
    const agent = candidates[0];
    if (agent && hub.hasDirectConnection(agent.agent)) {
      await query(`UPDATE agent_tasks SET agent = $2, status = 'queued', updated_at = now() WHERE id = $1`, [
        task.id,
        agent.agent,
      ]);
      hub.sendToAgent(agent.agent, {
        type: "task.assign",
        task: { ...task, agent: agent.agent },
        context: context as never,
      });
      await logActivity(task.userId!, "system", `Queued for ${agent.agent}`, "info", task.id);
      return;
    }
    if (agent) {
      // Registry has the agent but the socket dropped — mark the registry stale.
      agentRegistry.remove(agent.agent);
    }
    // No agent available: the hub runs the task itself (real ASI:ONE calls).
    await query(`UPDATE agent_tasks SET agent = 'hub-local', status = 'running', updated_at = now() WHERE id = $1`, [
      task.id,
    ]);
    const local = { ...task, agent: "hub-local", status: "running" as TaskStatus };
    await bus.emit(task.userId!, { type: "task.updated", task: local });
    runLocally(local, context as never).catch((err) =>
      this.applyError(task.id, "hub-local", (err as Error).message).catch(() => undefined),
    );
  }

  /** agent flow: an agent came (back) online and asks for queued work. */
  async tryClaim(agent: string, kinds: string[]): Promise<unknown[]> {
    if (!kinds.length) return [];
    const rows = await query<TaskRow>(
      `SELECT * FROM agent_tasks
       WHERE status = 'queued'
         AND kind = ANY($1::text[])
         AND kind <> 'coding'
         AND (agent IS NULL OR agent = $2)
       ORDER BY created_at ASC
       LIMIT 5`,
      [kinds, agent],
    );
    const frames: unknown[] = [];
    for (const row of rows) {
      const task = rowToTask(row);
      await query(`UPDATE agent_tasks SET agent = $2, updated_at = now() WHERE id = $1`, [
        task.id,
        agent,
      ]);
      frames.push({ type: "task.assign", task, context: task.payload.context ?? { kind: "generic" } });
    }
    return frames;
  }

  async applyUpdate(
    taskId: string,
    patch: { status?: TaskStatus; progress?: number; agent?: string },
  ): Promise<void> {
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [taskId];
    if (patch.status) {
      params.push(patch.status);
      sets.push(`status = $${params.length}`);
    }
    if (patch.progress !== undefined) {
      params.push(Math.max(0, Math.min(100, Math.round(patch.progress))));
      sets.push(`progress = $${params.length}`);
    }
    if (patch.agent) {
      params.push(patch.agent);
      sets.push(`agent = $${params.length}`);
    }
    const row = await one<TaskRow>(
      `UPDATE agent_tasks SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );
    if (!row) return;
    const task = rowToTask(row);
    await bus.emit(task.userId!, { type: "task.updated", task });
    if (task.status === "running") {
      await bus.emit(task.userId!, { type: "avatar.state", state: "working", reason: task.title });
    }
  }

  async applyStep(taskId: string, agent: string, label: string): Promise<void> {
    const task = await getTask(taskId);
    if (!task) return;
    await query(`UPDATE agent_tasks SET updated_at = now() WHERE id = $1`, [taskId]);
    await logActivity(task.user_id, agent, label, "info", taskId);
    await bus.emit(task.user_id, {
      type: "task.step",
      taskId,
      step: { label, ts: new Date().toISOString() },
    });
  }

  async applyAwaitingInput(
    taskId: string,
    agent: string,
    question: string,
    options?: string[],
  ): Promise<void> {
    const task = await getTask(taskId);
    if (!task) return;
    await one(
      `UPDATE agent_tasks SET status = 'waiting_input', agent = $2, updated_at = now() WHERE id = $1`,
      [taskId, agent],
    );
    const updated = rowToTask((await getTask(taskId))!);
    await bus.emit(task.user_id, { type: "task.awaiting_input", task: updated, question, options });
    await logActivity(task.user_id, agent, `Waiting for your input: ${question}`, "warn", taskId);
    await (await import("../services/notifications.js")).notificationService.create({
      userId: task.user_id,
      kind: "awaiting_input",
      title: "Your input is needed",
      body: question,
      taskId,
    });
    await bus.emit(task.user_id, { type: "avatar.state", state: "waiting", reason: question });
  }

  async applyError(taskId: string, agent: string, error: string): Promise<void> {
    const task = await getTask(taskId);
    if (!task) return;
    const row = await one<TaskRow>(
      `UPDATE agent_tasks SET status = 'failed', error = $2, agent = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [taskId, error.slice(0, 500), agent],
    );
    const failed = rowToTask(row!);
    await bus.emit(task.user_id, { type: "task.failed", task: failed });
    await bus.emit(task.user_id, { type: "avatar.state", state: "error", reason: error });
    await logActivity(task.user_id, agent, `Task failed: ${error}`, "error", taskId);
    await (await import("../services/notifications.js")).notificationService.create({
      userId: task.user_id,
      kind: "agent_failed",
      title: "Agent task failed",
      body: error.slice(0, 160),
      taskId,
    });
    await this.finalize(failed);
  }

  async applyResult(
    taskId: string,
    agent: string,
    result: Record<string, unknown>,
    summary?: string,
    silent = false,
  ): Promise<void> {
    const task = await getTask(taskId);
    if (!task) return;
    const row = await one<TaskRow>(
      `UPDATE agent_tasks SET status = 'completed', progress = 100, agent = $3,
              result = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
      [taskId, JSON.stringify(result), agent],
    );
    const done = rowToTask(row!);
    await bus.emit(task.user_id, { type: "task.completed", task: done });
    await logActivity(
      task.user_id,
      agent,
      `Task completed: ${summary?.slice(0, 140) ?? done.title}`,
      "info",
      taskId,
    );
    if (!silent) {
      await (await import("../services/notifications.js")).notificationService.create({
        userId: task.user_id,
        kind: "agent_completed",
        title: "Task completed",
        body: summary?.slice(0, 180) ?? done.title,
        taskId,
      });
    }
    if (done.kind !== "chat") {
      await bus.emit(task.user_id, { type: "avatar.state", state: "happy", reason: "task completed" });
    }
    await this.finalize(done);
  }

  /** Streaming text from agents while running chat tasks. */
  async applyTextDelta(taskId: string, _agent: string, text: string): Promise<void> {
    const task = await getTask(taskId);
    if (!task) return;
    const messageId = (task.payload as { messageId?: string }).messageId;
    const conversationId = task.conversation_id;
    if (!messageId || !conversationId) return;
    bus.live(task.user_id, {
      type: "chat.delta",
      messageId,
      conversationId,
      text,
    });
  }

  /** agent.log frame — persist to the trail when the task is known. */
  async applyLog(
    level: "info" | "warn" | "error",
    agent: string,
    message: string,
    taskId?: string,
  ): Promise<void> {
    if (!taskId) return;
    const task = await getTask(taskId);
    if (!task) return;
    await logActivity(task.user_id, agent, message, level, taskId);
  }

  async resolveInput(userId: string, taskId: string, answer: string): Promise<boolean> {
    const task = await getTask(taskId);
    if (!task || task.user_id !== userId || task.status !== "waiting_input") return false;
    await one(`UPDATE agent_tasks SET status = 'running', updated_at = now() WHERE id = $1`, [taskId]);
    const updated = rowToTask((await getTask(taskId))!);
    await bus.emit(userId, { type: "task.updated", task: updated });
    hub.sendToAgent(updated.agent ?? "", { type: "task.input", taskId, answer });
    await logActivity(userId, "user", `You answered: ${answer.slice(0, 120)}`, "info", taskId);
    await bus.emit(userId, { type: "avatar.state", state: "working", reason: "resumed" });
    return true;
  }

  private async finalize(task: AgentTask): Promise<void> {
    for (const fn of this.finalizers) {
      await fn(task).catch((err) =>
        console.error(`[delegation] finalizer failed: ${(err as Error).message}`),
      );
    }
  }

  /** User-initiated cancel; coding tasks also stop the local process tree. */
  async cancelTask(userId: string, taskId: string): Promise<boolean> {
    const task = await getTask(taskId);
    if (!task || task.user_id !== userId) return false;
    if (!["queued", "running", "waiting_input"].includes(task.status)) return false;
    if (task.kind === "coding") {
      const { codingBroker } = await import("./coding.js");
      return codingBroker.cancel(userId, taskId);
    }
    await this.applyUpdate(taskId, { status: "cancelled" });
    await logActivity(userId, "user", `Task cancelled: ${task.title}`, "info", taskId);
    return true;
  }

  async onAgentOffline(agent: string): Promise<void> {
    const rows = await query<TaskRow>(
      `UPDATE agent_tasks SET status = 'failed', error = 'agent went offline mid-task',
              updated_at = now()
       WHERE status IN ('queued','running','waiting_input') AND agent = $1
       RETURNING *`,
      [agent],
    );
    for (const row of rows) {
      await bus.emit(row.user_id, { type: "task.failed", task: rowToTask(row) });
    }
  }

  async startSweeper(): Promise<void> {
    setInterval(
      () =>
        void query<TaskRow>(
          `UPDATE agent_tasks SET status = 'failed', error = 'timed out', updated_at = now()
           WHERE status IN ('running','queued')
             AND updated_at < now() - interval '5 minutes'
           RETURNING *`,
        ).then((rows) => {
          for (const row of rows) {
            void bus
              .emit(row.user_id, { type: "task.failed", task: rowToTask(row) })
              .catch(() => undefined);
          }
          if (rows.length) console.warn(`[delegation] timed out ${rows.length} stale tasks`);
        }),
      60_000,
    ).unref();
  }
}

export const delegation = new Delegation();
