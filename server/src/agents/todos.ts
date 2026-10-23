// Todos: the shared checklist. The island writes through /api/todos; the chat
// reply path extracts agent markers ([todo: …]) and creates the same rows, so
// user and agents see one list.
import { query, one } from "../db/pool.js";
import { bus } from "../ws/bus.js";

export interface TodoRow {
  id: string;
  text: string;
  done: boolean;
  source: string;
  created_at: string;
}

export function extractTodoMarkers(content: string): { clean: string; items: string[] } {
  const items: string[] = [];
  const clean = content
    .replace(/\[\s*todo\s*:\s*([^\n\]]{1,120})\]/gi, (_m, text: string) => {
      const t = text.replace(/[*_'`]/g, "").trim();
      if (t) items.push(t);
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return { clean, items: [...new Set(items)].slice(0, 5) };
}

export async function createTodo(
  userId: string,
  text: string,
  source: "user" | "agent",
): Promise<TodoRow> {
  const row = await one<TodoRow>(
    `INSERT INTO todos (user_id, text, source) VALUES ($1, $2, $3)
     RETURNING id, text, done, source, created_at::text`,
    [userId, text.trim().slice(0, 160), source],
  );
  const todo = { ...row!, id: row!.id, text: row!.text };
  await bus.emit(userId, { type: "todo.created", todo });
  return todo;
}

export async function listTodos(userId: string, includeDone = true): Promise<TodoRow[]> {
  const sql = includeDone
    ? `SELECT id, text, done, source, created_at::text FROM todos WHERE user_id = $1 ORDER BY done, created_at DESC LIMIT 60`
    : `SELECT id, text, done, source, created_at::text FROM todos WHERE user_id = $1 AND done = false ORDER BY created_at DESC LIMIT 60`;
  try {
    return await query<TodoRow>(sql, [userId]);
  } catch {
    return [];
  }
}

export async function setTodoDone(userId: string, id: string, done: boolean): Promise<TodoRow | null> {
  const row = await one<TodoRow>(
    `UPDATE todos SET done = $3, done_at = CASE WHEN $3 THEN now() ELSE NULL END
     WHERE id = $1 AND user_id = $2
     RETURNING id, text, done, source, created_at::text`,
    [id, userId, done],
  );
  if (row) await bus.emit(userId, { type: "todo.updated", todo: row });
  return row;
}

export async function deleteTodo(userId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM todos WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId],
  );
  const deleted = rows.length > 0;
  if (deleted) await bus.emit(userId, { type: "todo.deleted", id });
  return deleted;
}
