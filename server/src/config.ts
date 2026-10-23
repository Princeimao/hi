import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";

function required(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy server/.env.example to server/.env.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string | undefined): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : fallback;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL ?? "",
  /** Signing secret for access tokens. Set a long random value in production. */
  jwtSecret: process.env.JWT_SECRET ?? "",
  /** Bearer token the Python/Agentverse agents must present for the HTTP + WS agent API. */
  agentToken: process.env.AGENT_TOKEN ?? "",
  /**
   * Target user for agent-initiated desktop work (coding tasks). Agents do not
   * carry a user identity, so a single-user deployment pins it here. When unset
   * the server uses the only user with a live desktop island.
   */
  agentUserId: optional("HI_AGENT_USER_ID", undefined),
  /** Where the Expo push notifications service is called from. */
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN ?? "",
  /** ASI:ONE API access (https://asi1.ai). OpenAI-compatible endpoint. */
  asi: {
    apiKey: process.env.ASI_ONE_API_KEY ?? "",
    baseUrl: process.env.ASI_ONE_BASE_URL ?? "https://api.asi1.ai/v1",
    /**
     * Verified models (docs.asi1.ai): asi1 | asi1-ultra | asi1-mini.
     * asi1-mini is the cheap/fast model used for routing + memory extraction.
     */
    model: process.env.ASI_ONE_MODEL ?? "asi1",
    miniModel: process.env.ASI_ONE_MINI_MODEL ?? "asi1-mini",
  },
  /** CORS origins allowed for the REST API (the desktop app uses Electron IPC, not CORS). */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  logLevel: optional("LOG_LEVEL", "info")!,
};

export function loadConfig(): typeof config {
  if (!config.databaseUrl) {
    config.databaseUrl = required("DATABASE_URL");
  }
  if (!config.jwtSecret) {
    config.jwtSecret = process.env.HI_DEV_SECRET ?? "";
    if (!config.jwtSecret) {
      // Never persist this; a fresh dev restart invalidates all sessions.
      config.jwtSecret = randomBytes(64).toString("hex");
      const fingerprint = createHash("sha256").update(config.jwtSecret).digest("hex").slice(0, 12);
      console.warn(
        `[hi] JWT_SECRET not set — generated a development secret (fingerprint ${fingerprint}). ` +
          "All tokens are invalidated on each restart.",
      );
    }
  }
  if (!config.agentToken) {
    config.agentToken = `agent-dev-${randomBytes(12).toString("hex")}`;
    console.warn(
      `[hi] AGENT_TOKEN not set — generated a development agent token. Agents must use: ` +
        `${config.agentToken}`,
    );
  }
  return config;
}

export const isDevSecret = (): boolean => !process.env.JWT_SECRET;
