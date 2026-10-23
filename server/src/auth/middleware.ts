import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken, type AccessClaims } from "./tokens.js";
import { config } from "../config.js";

export interface AuthedRequest extends Request {
  auth: {
    userId: string;
    deviceId: string | null;
    claims: AccessClaims;
  };
}

/** Requires a user access token (Authorization: Bearer …). */
export function requireUser(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  void verifyAccessToken(token)
    .then((claims) => {
      if (!claims || claims.role !== "user") {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      (req as AuthedRequest).auth = {
        userId: claims.sub,
        deviceId: typeof claims.deviceId === "string" ? claims.deviceId : null,
        claims,
      };
      next();
    })
    .catch(() => res.status(401).json({ error: "unauthorized" }));
}

/** Bearer AGENT_TOKEN — used by hosted agents polling the task API. */
export function requireAgent(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!config.agentToken || token !== config.agentToken) {
    res.status(401).json({ error: "bad agent token" });
    return;
  }
  next();
}
