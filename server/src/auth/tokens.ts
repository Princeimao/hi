import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { config } from "../config.js";

// ── Password hashing (scrypt, no native modules) ─────────────────────────────

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password.normalize("NFKC"), Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ── Tokens ───────────────────────────────────────────────────────────────────

export const ACCESS_TOKEN_TTL_SEC = 15 * 60;
export const REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 30;

export interface AccessClaims extends JWTPayload {
  sub: string;
  role: "user" | "agent";
  deviceId?: string | null;
  agentName?: string;
}

const secretKey = () => {
  return new TextEncoder().encode(config.jwtSecret);
};

export async function signAccessToken(
  claims: Pick<AccessClaims, "sub" | "role" | "deviceId" | "agentName"> & { deviceId?: string | null },
): Promise<string> {
  return new SignJWT({ role: claims.role, deviceId: claims.deviceId, agentName: claims.agentName })
    .setSubject(claims.sub)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SEC}s`)
    .sign(secretKey());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return payload as AccessClaims;
  } catch {
    return null;
  }
}

/** Refresh tokens are stored hashed (sha256) so a DB leak cannot mint sessions. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
