import type { NotificationKind, UserNotification } from "@hi/shared";
import { config } from "../config.js";
import { one, query } from "../db/pool.js";
import { bus } from "../ws/bus.js";
import { logger } from "../lib/logger.js";

interface NotificationRow {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  task_id: string | null;
  read_at: string | null;
  created_at: string;
}

function rowNotif(r: NotificationRow): UserNotification {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    taskId: r.task_id,
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

/**
 * Notifications: persisted (replayed cross-device), pushed to the bus for all
 * live sessions, and delivered as OTAs to Android via the Expo push service
 * when the device registered an Expo push token and EXPO_ACCESS_TOKEN is set.
 */
class NotificationService {
  async create(opts: {
    userId: string;
    kind: NotificationKind;
    title: string;
    body: string;
    taskId?: string | null;
  }): Promise<UserNotification> {
    const row = await one<NotificationRow>(
      `INSERT INTO notifications (user_id, kind, title, body, task_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [opts.userId, opts.kind, opts.title, opts.body, opts.taskId ?? null],
    );
    const notification = rowNotif(row!);
    await bus.emit(opts.userId, { type: "notification", notification });
    await this.push(opts.userId, notification);
    return notification;
  }

  async list(userId: string, limit = 50, unreadOnly = false): Promise<UserNotification[]> {
    const rows = await query<NotificationRow>(
      `SELECT * FROM notifications
       WHERE user_id = $1 ${unreadOnly ? "AND read_at IS NULL" : ""}
       ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map(rowNotif);
  }

  async markRead(userId: string, ids: string[]): Promise<number> {
    const rows = await query<{ id: string }>(
      `UPDATE notifications SET read_at = now()
       WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL RETURNING id`,
      [userId, ids],
    );
    return rows.length;
  }

  private async push(userId: string, notification: UserNotification): Promise<void> {
    if (!config.expoAccessToken) return;
    try {
      const rows = await query<{ expo_push_token: string }>(
        `SELECT expo_push_token FROM devices
         WHERE user_id = $1 AND kind = 'mobile' AND expo_push_token IS NOT NULL`,
        [userId],
      );
      const messages = rows
        .map((r) => r.expo_push_token)
        .filter((t) => ExpoTokenValid(t))
        .map((to) => ({
          to,
          sound: "default",
          title: notification.title,
          body: notification.body,
          data: { kind: notification.kind, taskId: notification.taskId, notificationId: notification.id },
        }));
      if (!messages.length) return;
      const res = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.expoAccessToken}`,
        },
        body: JSON.stringify(messages.slice(0, 10)),
      });
      if (!res.ok) {
        logger.warn(`[push] expo push failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
    } catch (err) {
      logger.warn(`[push] expo push error: ${(err as Error).message}`);
    }
  }
}

function ExpoTokenValid(token: string): boolean {
  return token.startsWith("ExpoPushToken[");
}

export const notificationService = new NotificationService();
