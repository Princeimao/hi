// Token-at-rest: AES-256-GCM with a scrypt key derived from the server secret.
// The plaintext token never hits the log or the DB in the clear.

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { config } from "../config.js";

function key(): Buffer {
  return scryptSync(config.jwtSecret, "hi:tokens:v1", 32);
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${enc.toString("base64")}`;
}

export function decryptToken(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new UnreadableTokenError();
  const [, ivB64, tagB64, encB64] = parts;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new UnreadableTokenError();
  }
}

export class UnreadableTokenError extends Error {
  constructor() {
    super("stored token is unreadable — disconnect and reconnect the service");
  }
}
