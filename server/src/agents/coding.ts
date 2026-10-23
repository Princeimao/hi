import type { AgentTask, CodingAgentId } from "@hi/shared";
import { CODING_AGENTS } from "@hi/shared";
import { one, query } from "../db/pool.js";
import { bus } from "../ws/bus.js";
import { hub } from "../ws/hub.js";
import { delegation } from "./delegation.js";

/**
 * Remote coding tasks.
 *
 * An agent (usually hosted on Agentverse) cannot reach the user's machine, so
 * it creates a `coding` task. The broker forwards it to the authenticated
 * desktop island, which runs a real local coding CLI and streams progress back
 * over the same device socket. Results land in the normal task stream, so the
 * agent can read them through GET /api/agent/tasks/:id and the user sees them
 * on every device.
 */

export const DEFAULT_CODING_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_CODING_AGENT: CodingAgentId = "claude";

export interface CodingContext {
  kind: "coding";
  prompt: string;
  agent: CodingAgentId;
  cwd: string | null;
  timeoutMs: number;
}

export function isCodingAgent(value: unknown): value is CodingAgentId {
  return typeof value === "string" && (CODING_AGENTS as readonly string[]).includes(value);
}

export function codingAgentName(agent: string): string {
  switch (agent) {
    case "claude":
      return "Claude Code";
    case "opencode":
      return "OpenCode";
    case "antigravity":
      return "Antigravity";
    default:
      return agent;
  }
}

/** Build the assignment context from a task payload (REST or chat). */
export function codingContextFrom(
  payload: Record<string, unknown>,
  fallbackPrompt = "",
): CodingContext {
  const prompt = String(payload["prompt"] ?? payload["text"] ?? fallbackPrompt).trim();
  const agent = isCodingAgent(payload["agent"]) ? payload["agent"] : DEFAULT_CODING_AGENT;
  const cwd = typeof payload["cwd"] === "string" && payload["cwd"].trim() ? payload["cwd"].trim() : null;
  const rawTimeout = Number(payload["timeoutMs"] ?? DEFAULT_CODING_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout)
    ? Math.max(10_000, Math.min(60 * 60_000, Math.round(rawTimeout)))
    : DEFAULT_CODING_TIMEOUT_MS;
  return { kind: "coding", prompt, agent, cwd, timeoutMs };
}

interface ActiveCodingTask {
  userId: string;
  agent: CodingAgentId;
  startedAt: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

class CodingBroker {
  private active = new Map<string, ActiveCodingTask>();

  /** Push an assigned coding task to the user's desktop. */
  async dispatch(task: AgentTask, context: CodingContext): Promise<void> {
    const userId = task.userId;
    if (!userId) {
      await delegation.applyError(task.id, "coding", "coding task has no user");
      return;
    }
    if (!context.prompt) {
      await delegation.applyError(task.id, "coding", "coding task has no prompt");
      return;
    }
    if (!hub.hasDesktop(userId)) {
      await delegation.applyError(
        task.id,
        "coding",
        "No desktop island is connected. Open Hi on the PC with the coding agent installed.",
      );
      return;
    }

    this.active.set(task.id, { userId, agent: context.agent, startedAt: Date.now() });
    await delegation.applyUpdate(task.id, {
      status: "running",
      progress: 2,
      agent: `coding:${context.agent}`,
    });
    await delegation.applyStep(
      task.id,
      "coding",
      `Launching ${codingAgentName(context.agent)}${context.cwd ? ` in ${context.cwd}` : ""}`,
    );

    const sent = hub.sendToDesktop(userId, {
      type: "coding.task.assign",
      taskId: task.id,
      title: task.title,
      prompt: context.prompt,
      agent: context.agent,
      cwd: context.cwd,
      timeoutMs: context.timeoutMs,
    });
    if (!sent) {
      this.active.delete(task.id);
      await delegation.applyError(
        task.id,
        "coding",
        "The desktop island disconnected before the task could start.",
      );
    }
  }

  /** Apply a frame from the authenticated desktop that owns the task. */
  async handleFrame(userId: string, frame: Record<string, unknown>): Promise<void> {
    const taskId = String(frame["taskId"] ?? "");
    if (!taskId) return;
    const owner = await one<{ user_id: string; status: string }>(
      `SELECT user_id, status FROM agent_tasks WHERE id = $1`,
      [taskId],
    );
    if (!owner || owner.user_id !== userId) return;

    switch (String(frame["type"] ?? "")) {
      case "coding.task.step": {
        const label = String(frame["label"] ?? "").trim();
        if (label) await delegation.applyStep(taskId, "desktop", label.slice(0, 160));
        break;
      }
      case "coding.task.output": {
        const text = String(frame["text"] ?? "");
        if (text) bus.live(userId, { type: "coding.task.output", taskId, text: text.slice(0, 8000) });
        break;
      }
      case "coding.task.heartbeat": {
        // Keep the sweeper away from a healthy long run, and mirror progress.
        await query(`UPDATE agent_tasks SET updated_at = now() WHERE id = $1`, [taskId]);
        const progress = Number(frame["progress"]);
        if (Number.isFinite(progress)) {
          await delegation.applyUpdate(taskId, {
            progress: Math.max(0, Math.min(99, Math.round(progress))),
          });
        }
        break;
      }
      case "coding.task.result": {
        const result = asRecord(frame["result"]) ?? {};
        const summary = String(
          frame["summary"] ?? result["output"] ?? result["summary"] ?? "Coding task completed",
        )
          .replace(/\s+/g, " ")
          .slice(0, 180);
        this.active.delete(taskId);
        await delegation.applyResult(taskId, "desktop", result, summary);
        break;
      }
      case "coding.task.error": {
        const error = String(frame["error"] ?? "coding agent failed").slice(0, 500);
        this.active.delete(taskId);
        await delegation.applyError(taskId, "desktop", error);
        break;
      }
      default:
        break;
    }
  }

  /** Cancel a running coding task: tell the desktop to stop the process tree. */
  async cancel(userId: string, taskId: string): Promise<boolean> {
    const task = await one<{ user_id: string; status: string }>(
      `SELECT user_id, status FROM agent_tasks WHERE id = $1`,
      [taskId],
    );
    if (!task || task.user_id !== userId) return false;
    if (!["queued", "running", "waiting_input"].includes(task.status)) return false;
    this.active.delete(taskId);
    hub.sendToDesktop(userId, { type: "coding.task.cancel", taskId });
    await delegation.applyUpdate(taskId, { status: "cancelled" });
    return true;
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }
}

export const codingBroker = new CodingBroker();
