import { query, one } from "../db/pool.js";
import { bus } from "../ws/bus.js";
import type { AgentActivity } from "@hi/shared";

/** Append a line to the persisted agent activity trail and broadcast it. */
export async function logActivity(
  userId: string,
  agent: string,
  message: string,
  level: AgentActivity["level"] = "info",
  taskId: string | null = null,
): Promise<AgentActivity | null> {
  const row = await one<{ id: string; created_at: string }>(
    `INSERT INTO agent_activity (user_id, task_id, agent, level, message)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [userId, taskId, agent, level, message],
  );
  if (!row?.id) return null;
  const activity: AgentActivity = {
    id: String(row.id),
    taskId,
    agent,
    level,
    message,
    createdAt: row.created_at,
  };
  if (userId) await bus.emit(userId, { type: "agent.event", event: activity });
  return activity;
}

/** Count recent activity lines for a user (used by the agents panel). */
export async function recentActivity(userId: string, limit = 50): Promise<AgentActivity[]> {
  const rows = await query<{
    id: string;
    task_id: string | null;
    agent: string;
    level: string;
    message: string;
    created_at: string;
  }>(
    `SELECT id, task_id, agent, level, message, created_at
     FROM agent_activity WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    agent: r.agent,
    level: r.level as AgentActivity["level"],
    message: r.message,
    createdAt: r.created_at,
  }));
}
