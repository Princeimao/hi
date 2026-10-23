import { Router } from "express";
import { z } from "zod";
import { isEmail } from "../lib/validate.js";
import { query, withTx } from "../db/pool.js";
import {
  ACCESS_TOKEN_TTL_SEC,
  hashPassword,
  newRefreshToken,
  REFRESH_TOKEN_TTL_SEC,
  signAccessToken,
  verifyPassword,
  hashToken,
} from "../auth/tokens.js";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().refine(isEmail, "valid email required"),
  password: z.string().min(8, "at least 8 characters").max(200),
  displayName: z.string().max(60).optional().default(""),
  deviceId: z.string().uuid().optional(),
  deviceLabel: z.string().max(60).optional().default(""),
  deviceKind: z.enum(["desktop", "mobile"]).optional().default("desktop"),
});

async function issueSession(
  userId: string,
  deviceId: string | null,
  deviceLabel: string,
): Promise<{ accessToken: string; refreshToken: string; accessExpiresIn: number }> {
  const accessToken = await signAccessToken({ sub: userId, role: "user", deviceId });
  const { token: refreshToken, hash } = newRefreshToken();
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_id, device_label, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [userId, hash, deviceId, deviceLabel, REFRESH_TOKEN_TTL_SEC],
  );
  return { accessToken, refreshToken, accessExpiresIn: ACCESS_TOKEN_TTL_SEC };
}

async function ensureDevice(userId: string, deviceId: string | undefined, kind: string, label: string): Promise<string | null> {
  if (!deviceId) return null;
  await query(
    `INSERT INTO devices (id, user_id, kind, name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), user_id = $2, kind = $3, name = $4`,
    [deviceId, userId, kind, label],
  );
  return deviceId;
}

function pairBody(userId: string, email: string, displayName: string, tokens: { accessToken: string; refreshToken: string }) {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    userId,
    email,
    displayName,
  };
}

/** Desktop bootstraps its own local account — one user per machine hostname.
 *  Mobile does a real register/login; the desktop pairs by machine instead. */
authRouter.post("/device-bootstrap", async (req, res) => {
  const label = typeof req.body?.["label"] === "string" ? req.body["label"].slice(0, 60) : "";
  const machine = (label || "desktop").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
  const email = `${machine}@device.hi.local`;
  const existing = await oneOrNull<{ id: string; email: string; display_name: string }>(
    `SELECT id, email, display_name FROM users WHERE email = $1`,
    [email],
  );
  const user = existing ?? (await query<{ id: string; email: string; display_name: string }>(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, '!', $2) RETURNING id, email, display_name`,
    [email, machine],
  ))[0];
  const tokens = await issueSession(user.id, null, label.slice(0, 60));
  res.status(existing ? 200 : 201).json(pairBody(user.id, user.email, user.display_name, tokens));
});

async function oneOrNull<T extends object>(sql: string, params: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
    return;
  }
  const { email, password, displayName, deviceId, deviceLabel, deviceKind } = parsed.data;
  const exists = await query(`SELECT 1 FROM users WHERE email = $1`, [email.toLowerCase()]);
  if (exists.length) {
    res.status(409).json({ error: "email_taken" });
    return;
  }
  const inserted = await withTx(async (client) => {
    const result = await client.query<{ id: string; email: string; display_name: string }>(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name`,
      [email.toLowerCase(), hashPassword(password), displayName],
    );
    return result.rows[0];
  });
  const finalDeviceId = await ensureDevice(inserted.id, deviceId, deviceKind, deviceLabel);
  const tokens = await issueSession(inserted.id, finalDeviceId, deviceLabel);  res.status(201).json(pairBody(inserted.id, inserted.email, inserted.display_name, tokens));
});

authRouter.post("/login", async (req, res) => {
  const { email, password, deviceId, deviceLabel, deviceKind } = (req.body ?? {}) as {
    email?: string;
    password?: string;
    deviceId?: string;
    deviceLabel?: string;
    deviceKind?: string;
  };
  if (!isEmail(email ?? "") || typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const rows = await query<{ id: string; email: string; display_name: string; password_hash: string }>(
    `SELECT id, email, display_name, password_hash FROM users WHERE email = $1`,
    [email!.toLowerCase()],
  );
  const user = rows[0];
  const ok = user ? verifyPassword(password, user.password_hash) : false;
  if (!user || !ok) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }
  const finalDeviceId = await ensureDevice(user.id, deviceId, deviceKind ?? "desktop", deviceLabel ?? "");
  const tokens = await issueSession(user.id, finalDeviceId, deviceLabel ?? "");
  res.json(pairBody(user.id, user.email, user.display_name, tokens));
});

// Refresh token rotation
authRouter.post("/refresh", async (req, res) => {
  const token = String(req.body?.refreshToken ?? "");
  if (!token) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const rows = await query<{
    id: string;
    user_id: string;
    device_id: string | null;
    expires_at: string;
    revoked_at: string | null;
  }>(`SELECT * FROM refresh_tokens WHERE token_hash = $1`, [hashToken(token)]);
  const stored = rows[0];
  if (
    !stored ||
    stored.revoked_at ||
    new Date(stored.expires_at).getTime() < Date.now()
  ) {
    res.status(401).json({ error: "invalid_refresh_token" });
    return;
  }
  // Rotate: revoke the presented token, mint a fresh pair.
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [stored.id]);
  const tokens = await issueSession(stored.user_id, stored.device_id, "rotated");
  const user = await query<{ email: string; display_name: string }>(
    `SELECT email, display_name FROM users WHERE id = $1`,
    [stored.user_id],
  );
  res.json(pairBody(stored.user_id, user[0]?.email ?? "", user[0]?.display_name ?? "", tokens));
});

authRouter.post("/logout", async (req, res) => {
  const token = String(req.body?.refreshToken ?? "");
  if (token) {
    await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [
      hashToken(token),
    ]);
  }
  res.status(204).end();
});
