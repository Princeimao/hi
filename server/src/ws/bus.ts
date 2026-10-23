import type { ServerEvent } from "@hi/shared";
import { one, query } from "../db/pool.js";

export interface EventRecord {
  id: number;
  ts: string;
  event: ServerEvent;
  /** Routed per user; present once the record has been created/received. */
  userId?: string;
}

type Listener = (rec: EventRecord) => void;

/**
 * The event bus persists every durable event in `user_events` (a per-user
 * stream) and fans it out to every live socket of that user.
 */
class EventBus {
  private listeners = new Set<Listener>();

  onLive(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  on(listener: Listener): () => void {
    return this.onLive(listener);
  }

  /** Persist + broadcast. Returns the assigned event id. */
  async emit(userId: string, event: ServerEvent): Promise<number> {
    const row = await one<{ id: string | number; created_at: string }>(
      `INSERT INTO user_events (user_id, type, payload) VALUES ($1, $2, $3::jsonb) RETURNING id, created_at`,
      [userId, event.type, JSON.stringify(event)],
    );
    if (!row) return 0;
    const rec: EventRecord = { id: Number(row.id), ts: row.created_at, event, userId };
    for (const fn of this.listeners) fn(rec);
    return rec.id;
  }

  /** Broadcast without persisting (e.g. chat streaming deltas; the final message is persisted). */
  live(userId: string, event: ServerEvent): void {
    const rec: EventRecord = { id: 0, ts: new Date().toISOString(), event, userId };
    for (const fn of this.listeners) fn(rec);
  }

  /** Replay durable events newer than `since` for one user, oldest first. */
  async replay(userId: string, since: number, limit = 800): Promise<EventRecord[]> {
    const rows = await query<{ id: string | number; created_at: string; payload: ServerEvent }>(
      `SELECT id, created_at, payload FROM user_events
       WHERE user_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3`,
      [userId, since, limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      ts: r.created_at,
      event: r.payload as ServerEvent,
      userId,
    }));
  }
}

export const bus = new EventBus();
