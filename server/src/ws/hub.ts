import type { Server } from "node:http";
import type { WebSocket as WsSocket } from "ws";
import { WebSocketServer } from "ws";
import type {
  AgentFrame,
  AgentFrameFromHub,
  ClientFrame,
  EventEnvelope,
  HelloFrame,
} from "@hi/shared";
import { config } from "../config.js";
import { verifyAccessToken } from "../auth/tokens.js";
import { query } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { bus, type EventRecord } from "./bus.js";
import { agentRegistry } from "../agents/registry.js";
import { delegation } from "../agents/delegation.js";
import * as friends from "../integrations/friends.js";

/** Friend gateway updates apply straight to the friend threads; the frame is
 *  keyed by taskId and the service looks the user up from the task. */
async function applyFriendFrame(frame: Parameters<typeof friends.applyAgentFrame>[0]): Promise<void> {
  try {
    await friends.applyAgentFrame(frame);
  } catch (err) {
    logger.error(`[ws] friend frame error: ${(err as Error).message}`);
  }
}

const HEARTBEAT_MS = 30_000;
/// A desktop device must say device.hello (with a valid token) this soon after
/// connecting, or the socket goes.
const HANDSHAKE_MS = 5_000;

interface ClientConn {
  kind: "client";
  id: string;
  userId: string;
  deviceId: string | null;
  socket: WsSocket;
  alive: boolean;
  /** While replaying, live events buffer instead of streaming out. */
  replaying: boolean;
  cursor: number;
  buffer: EventRecord[];
}

interface AgentConn {
  kind: "agent";
  id: string;
  agent: string;
  socket: WsSocket;
  alive: boolean;
  modes: string[];
  capabilities: string[];
}

interface DesktopConn {
  kind: "desktop";
  id: string;
  userId: string;
  name: string;
  socket: WsSocket;
  alive: boolean;
}

/** A socket that connected without a token: waiting for device.hello. */
interface PendingConn {
  kind: "pending";
  id: string;
  socket: WsSocket;
  alive: boolean;
  helloTimer: NodeJS.Timeout | null;
}

interface SessionWire {
  id: string;
  agent: string | null;
  sessionId: string;
  projectName: string;
  cwd: string;
  status: string;
  steps: { label: string; ts: string }[];
  finalLine: string | null;
  updatedAt: string;
}

interface ApprovalWire {
  requestId: string;
  pillId: string;
  tool: string;
  command: string;
  questions: unknown;
  [key: string]: unknown;
}

type AnyConn = ClientConn | AgentConn | DesktopConn | PendingConn;

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36).slice(-4);
}

function wireDeviceSocket(conn: { socket: WsSocket; alive: boolean }, onClose: () => void): void {
  conn.socket.on("pong", () => {
    conn.alive = true;
  });
  conn.socket.on("close", onClose);
  conn.socket.on("error", onClose);
}

/** Comparison ignores wall-clock fields: steps and updatedAt are restamped
 *  on every wire build, so the meaningful state is what decides "changed". */
function stableKey(s: SessionWire): string {
  return JSON.stringify({
    id: s.id,
    agent: s.agent,
    sessionId: s.sessionId,
    projectName: s.projectName,
    cwd: s.cwd,
    status: s.status,
    labels: (Array.isArray(s.steps) ? s.steps : []).map((st) => st?.label ?? ""),
    finalLine: s.finalLine,
  });
}

function sessionsEqualish(a: Record<string, SessionWire>, b: Record<string, SessionWire>): boolean {
  if (Object.keys(a).length !== Object.keys(b).length) return false;
  for (const id of Object.keys(b)) {
    if (!(id in a)) return false;
    if (stableKey(a[id]) !== stableKey(b[id])) return false;
  }
  return true;
}

function approvalEqualish(a: ApprovalWire | null, b: ApprovalWire | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  // createdAt is restamped on every wire build; identity is what matters.
  const stable = (p: ApprovalWire) =>
    JSON.stringify({ ...p, createdAt: 0, agent: p.agent ?? null });
  return stable(a) === stable(b);
}

/** The snapshot shape into the shared CodingApproval event payload. */
function normalizeStoredApproval(raw: ApprovalWire): import("@hi/shared").CodingApproval {
  return {
    requestId: String(raw.requestId ?? ""),
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
    pillId: String(raw.pillId ?? "claude"),
    agent: String(raw.pillId ?? "").startsWith("agent_") ? String(raw.pillId).slice(6) : null,
    tool: typeof raw.tool === "string" ? raw.tool : "Tool",
    command: typeof raw.command === "string" ? raw.command : "",
    questions: Array.isArray(raw.questions) ? (raw.questions as import("@hi/shared").CodingQuestion[]) : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
  };
}

function sessionDeltas(
  before: Record<string, SessionWire>,
  after: Record<string, SessionWire>,
): { changed: string[]; removed: string[] } {
  const changed: string[] = [];
  const removed: string[] = [];
  for (const id of Object.keys(after)) {
    if (!(id in before)) {
      changed.push(id);
      continue;
    }
    if (JSON.stringify(before[id]) !== JSON.stringify(after[id])) changed.push(id);
  }
  for (const id of Object.keys(before)) if (!(id in after)) removed.push(id);
  return { changed, removed };
}

function envelope(rec: EventRecord): EventEnvelope {
  return { type: "event", id: rec.id, ts: rec.ts, event: rec.event };
}

/** Live-only frames carry no id; durable frames advance the cursor. */
function deliverable(rec: EventRecord): EventEnvelope {
  return { type: "event", id: rec.id, ts: rec.ts, event: rec.event };
}

/**
 * The hub holds every live WebSocket (user clients + agents), performs the
 * authentication handshake, replays missed durable events after a reconnect,
 * and fans out events produced by the bus or by agent frames.
 */
class WsHubImpl {
  private clients = new Map<string, ClientConn>();
  private agents = new Map<string, AgentConn>();
  private desktops = new Map<string, DesktopConn>();
  private pending = new Map<string, PendingConn>();
  /** Latest coding snapshot per user, so a reconnecting device is not blind. */
  private codingStates = new Map<string, { sessions: Record<string, SessionWire>; pending: ApprovalWire | null }>();
  private wss: WebSocketServer | null = null;
  private onChatSend: ((userId: string, frame: ClientFrame) => Promise<void>) | null = null;

  attach(
    server: Server,
    onChatSend: (userId: string, frame: ClientFrame) => Promise<void>,
  ): void {
    this.onChatSend = onChatSend;
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      void this.upgrade(url, req, socket, head);
    });

    // Fan out every durable event to all live connections of the user.
    bus.onLive((rec) => this.deliver(rec));

    setInterval(() => this.heartbeat(), HEARTBEAT_MS).unref();
  }

  private async upgrade(
    url: URL,
    req: import("node:http").IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ): Promise<void> {
    const token = url.searchParams.get("token") ?? "";

    let ctx:
      | { role: "agent"; agent: string }
      | { role: "client"; userId: string; deviceId: string | null }
      | { role: "desktop" };
    let since = 0;

    if (token === config.agentToken) {
      // Agent sessions authenticate with the shared AGENT_TOKEN.
      ctx = { role: "agent", agent: url.searchParams.get("agent") ?? "unnamed-agent" };
    } else if (token) {
      const claims = await verifyAccessToken(token);
      if (!claims || claims.role !== "user") {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const claimsUserId = claims.sub;
      const claimsDeviceId = typeof claims.deviceId === "string" ? claims.deviceId : null;
      ctx = { role: "client", userId: claimsUserId, deviceId: claimsDeviceId };
      since = Math.max(0, Number(url.searchParams.get("since") ?? "0") || 0);
    } else {
      // Devices like the desktop companion authenticate with device.hello.
      ctx = { role: "desktop" };
    }

    this.wss!.handleUpgrade(req, socket, head, (ws) => {
      if (ctx.role === "agent") {
        this.registerAgent(ws, ctx.agent);
        return;
      }
      if (ctx.role === "desktop") this.registerPending(ws);
      else void this.registerClient(ws, ctx as { role: "client"; userId: string; deviceId: string | null }, since);
    });
  }

  /// Waits for the first frame: a desktop device introduces itself with its
  /// access token there.
  private registerPending(socket: WsSocket): void {
    const pendingId = randomId();
    const conn: PendingConn = { kind: "pending", id: pendingId, socket, alive: true, helloTimer: null };
    this.pending.set(pendingId, conn);
    conn.helloTimer = setTimeout(() => {
      const still = this.pending.get(pendingId);
      if (still && still.socket === socket) this.dropSocket(still.socket);
      this.pending.delete(pendingId);
    }, HANDSHAKE_MS);
    const onMessage = async (data: unknown): Promise<void> => {
      let frame: { type?: string };
      try {
        frame = JSON.parse(String(data)) as { type?: string };
      } catch {
        socket.off("message", onMessage);
        this.dropSocket(socket);
        return;
      }
      if (frame?.type !== "device.hello") {
        socket.off("message", onMessage);
        this.dropSocket(socket);
        this.pending.delete(pendingId);
        return;
      }
      const hello = frame as { token?: string; device?: { name?: string; platform?: string } };
      const claims = await verifyAccessToken(hello.token ?? "").catch(() => null);
      const helloUserId = (claims as { role?: string; sub?: string } | null) ?? null;
      socket.off("message", onMessage);
      if (!helloUserId || helloUserId.role !== "user") {
        this.pending.delete(pendingId);
        this.dropSocket(socket);
        return;
      }
      if (conn.helloTimer) clearTimeout(conn.helloTimer);
      this.pending.delete(pendingId);
      this.registerDesktop(socket, helloUserId.sub ?? "", hello.device?.name ?? "desktop");
    };
    socket.on("message", onMessage);
    socket.on("close", () => {
      if (conn.helloTimer) clearTimeout(conn.helloTimer);
      this.pending.delete(pendingId);
    });
    socket.on("error", () => {
      if (conn.helloTimer) clearTimeout(conn.helloTimer);
      this.pending.delete(pendingId);
    });
  }

  private dropSocket(socket: WsSocket): void {
    try {
      socket.close();
    } catch {
      // already gone
    }
  }

  private registerDesktop(socket: WsSocket, userId: string, name: string): void {
    const conn: DesktopConn = {
      kind: "desktop",
      id: randomId(),
      userId,
      name,
      socket,
      alive: true,
    };
    this.desktops.set(conn.id, conn);
    logger.info(`[ws] desktop connected user=${userId} name=${name} conn=${conn.id}`);
    this.send(conn, { type: "hello", hello: { userId, role: "client", reconnect: false, agentsOnline: this.onlineAgentNames() } });

    wireDeviceSocket(conn, () => {
      this.desktops.delete(conn.id);
      logger.info(`[ws] desktop disconnected user=${userId} conn=${conn.id}`);
    });
    socket.on("message", (data) => void this.handleDesktopFrame(conn, String(data)));
  }

  private async handleDesktopFrame(conn: DesktopConn, raw: string): Promise<void> {
    let frame: { type?: string };
    try {
      frame = JSON.parse(raw) as { type?: string };
    } catch {
      return;
    }
    logger.info(`[ws] desktop frame user=${conn.userId} type=${String(frame.type ?? "?")}`);
    if (frame.type === "ping") {
      this.send(conn, { type: "pong", ts: new Date().toISOString() });
      return;
    }

    if (frame.type === "coding.snapshot") {
      await this.applyCodingSnapshot(conn, frame as { sessions?: SessionWire[]; pending?: ApprovalWire | null });
      return;
    }
    if (frame.type === "coding.resolved") {
      const resolved = frame as { requestId?: string; decision?: string };
      logger.info(`[ws] coding resolved user=${conn.userId} request=${resolved.requestId} decision=${resolved.decision}`);
      return;
    }
    if (frame.type === "local.result") {
      const replyId = String((frame as { replyId?: string }).replyId ?? "");
      const cb = replyId ? this.pendingDesktopCalls.get(replyId) : undefined;
      if (cb) cb(frame as Record<string, unknown>);
      return;
    }

    // The island runs its own chat + task answers through the same pipeline.
    if (
      frame.type === "chat.send" ||
      frame.type === "chat.stop" ||
      frame.type === "task.resolve_input"
    ) {
      void this.onChatSend?.(conn.userId, frame as ClientFrame).catch((err) =>
        logger.error(`[ws] desktop frame error: ${(err as Error).message}`),
      );
    }
  }

  /** Diff the snapshot against the last one heard and event what changed. */
  private async applyCodingSnapshot(
    conn: DesktopConn,
    snap: { sessions?: SessionWire[]; pending?: ApprovalWire | null },
  ): Promise<void> {
    const prev = this.codingStates.get(conn.userId);
    const sessions: Record<string, SessionWire> = {};
    for (const s of snap.sessions ?? []) if (s && typeof s.id === "string") sessions[s.id] = s;
    const pending = snap.pending ?? null;
    if (prev) {
      if (sessionsEqualish(prev.sessions, sessions) && approvalEqualish(prev.pending, pending)) return;
    }
    const deltas = sessionDeltas(prev?.sessions ?? {}, sessions);
    for (const id of deltas.removed) {
      bus.live(conn.userId, { type: "coding.session.removed", pillId: id });
    }
    for (const id of deltas.changed) {
      const s = sessions[id];
      bus.live(conn.userId, {
        type: "coding.session",
        session: {
          id: s.id,
          pillId: s.id,
          agent: s.agent ?? null,
          sessionId: s.sessionId ?? "",
          projectName: s.projectName ?? "",
          cwd: s.cwd ?? "",
          status: (s.status ?? "idle") as import("@hi/shared").CodingSession["status"],
          steps: Array.isArray(s.steps) ? s.steps : [],
          finalLine: s.finalLine ?? null,
          updatedAt: s.updatedAt ?? new Date().toISOString(),
        },
      });
    }
    const changedPending = !approvalEqualish(prev?.pending ?? null, pending);
    if (changedPending) {
      if (prev?.pending && (!pending || prev.pending.requestId !== pending.requestId)) {
        bus.live(conn.userId, {
          type: "coding.approval.dropped",
          requestId: prev.pending.requestId,
          reason: "replaced or resolved",
        });
      }
      if (pending) {
        bus.live(conn.userId, { type: "coding.approval", approval: normalizeStoredApproval(pending) });
      }
    }
    this.codingStates.set(conn.userId, { sessions, pending });
    if (deltas.changed.length > 0 || deltas.removed.length > 0 || changedPending) {
      logger.info(`[ws] coding snapshot user=${conn.userId} sessions=${Object.keys(sessions).length} pending=${pending ? String(pending.requestId) : "none"}`);
    }
  }

  /** A device (or client) reconnecting learns the world at once. */
  private sendCodingStateTo(conn: ClientConn): void {
    const state = this.codingStates.get(conn.userId);
    if (!state) return;
    for (const s of Object.values(state.sessions)) {
      bus.live(conn.userId, {
        type: "coding.session",
        session: {
          ...s,
          pillId: s.id,
          status: (s.status ?? "idle") as import("@hi/shared").CodingSession["status"],
        },
      });
    }
    if (state.pending) {
      bus.live(conn.userId, { type: "coding.approval", approval: normalizeStoredApproval(state.pending) });
    }
  }

  private async registerClient(
    socket: WsSocket,
    ctx: { userId: string; deviceId: string | null },
    since: number,
  ): Promise<void> {
    const conn: ClientConn = {
      kind: "client",
      id: randomId(),
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      socket,
      alive: true,
      replaying: since > 0,
      cursor: since,
      buffer: [],
    };
    this.clients.set(conn.id, conn);

    if (conn.deviceId) {
      query(`UPDATE devices SET last_seen_at = now() WHERE id = $1 AND user_id = $2`, [
        conn.deviceId,
        conn.userId,
      ]).catch(() => undefined);
    }

    logger.info(`[ws] client connected user=${conn.userId} conn=${conn.id} replaying=${conn.replaying}`);

    this.wireSocket(conn);

    const hello: ServerFrameOk = {
      type: "hello",
      hello: {
        userId: conn.userId,
        role: "client",
        reconnect: conn.replaying,
        agentsOnline: this.onlineAgentNames(),
      },
    };
    this.send(conn, hello);
    // A reconnecting phone learns the desktop's current coding world at once.
    this.sendCodingStateTo(conn);

    if (conn.replaying) {
      let lastSent = conn.cursor;
      const missed = await bus.replay(conn.userId, conn.cursor).catch(() => []);
      for (const rec of missed) {
        if (rec.id <= conn.cursor) continue;
        this.send(conn, envelope(rec));
        lastSent = Math.max(lastSent, rec.id);
      }
      conn.cursor = lastSent;
      conn.replaying = false;
      // Flush anything that streamed live while the replay was running.
      const flushed = conn.buffer;
      conn.buffer = [];
      for (const rec of flushed) {
        if (rec.id <= conn.cursor) continue;
        this.send(conn, envelope(rec));
        conn.cursor = rec.id;
      }
      logger.info(`[ws] replay done user=${conn.userId} sent to id=${conn.cursor}`);
    }
  }

  private registerAgent(socket: WsSocket, name: string): void {
    const conn: AgentConn = {
      kind: "agent",
      id: `${name}-${randomId()}`,
      agent: name,
      socket,
      alive: true,
      modes: [],
      capabilities: [],
    };
    this.agents.set(conn.id, conn);
    logger.info(`[ws] agent socket connected name=${name}`);

    let helloSent = false;

    socket.on("message", (data) => {
      let frame: AgentFrame | { type: string } | undefined;
      try {
        frame = JSON.parse(String(data)) as AgentFrame;
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== "string") return;
      if (frame.type === "agent.hello") {
        const hello = frame as Extract<AgentFrame, { type: "agent.hello" }>;
        conn.agent = hello.agent ?? conn.agent;
        conn.modes = hello.modes ?? [];
        conn.capabilities = hello.capabilities ?? [];
        agentRegistry.register(conn);
        if (!helloSent) this.send(conn, { type: "hello", hello: this.clientHello() });
        helloSent = true;
        this.broadcastAgentsOnline();
        return;
      }
      if (!helloSent) {
        this.send(conn, { type: "hello", hello: this.clientHello() });
        helloSent = true;
      } // nudge the agent to introduce itself first
      void this.handleAgentFrame(conn, frame as AgentFrame).catch((err) =>
        logger.error(`[ws] agent frame error: ${(err as Error).message}`),
      );
    });
    socket.on("pong", () => {
      conn.alive = true;
    });
    socket.on("close", () => {
      this.agents.delete(conn.id);
      agentRegistry.remove(conn.agent);
      this.broadcastAgentsOnline();
      logger.info(`[ws] agent socket closed name=${name}`);
      delegation.onAgentOffline(conn.agent).catch(() => undefined);
    });
    socket.on("error", () => this.agents.delete(conn.id));
  }

  private wireSocket(conn: ClientConn): void {
    conn.socket.on("message", (data) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(data)) as ClientFrame;
      } catch {
        this.send(conn, { type: "error", code: "bad_frame", message: "Invalid JSON" } as never);
        return;
      }
      switch (frame.type) {
        case "ping":
          this.send(conn, { type: "pong", id: (frame as { type: string }).type } as never);
          break;
        case "coding.decision":
          // The phone answered: the live island decides whether it is actionable.
          this.deliverCodingDecision(conn.userId, frame);
          break;
        case "chat.send":
        case "chat.stop":
        case "task.resolve_input":
        case "presence.state":
          void this.onChatSend?.(conn.userId, frame).catch((err) =>
            logger.error(`[ws] client frame error: ${(err as Error).message}`),
          );
          break;
        default:
          break;
      }
    });
    conn.socket.on("pong", () => {
      conn.alive = true;
    });
    conn.socket.on("close", () => {
      this.clients.delete(conn.id);
      logger.info(`[ws] client disconnected user=${conn.userId}`);
    });
    conn.socket.on("error", () => this.clients.delete(conn.id));
  }

  private clientHello(): HelloFrame {
    return {
      userId: "",
      role: "client",
      reconnect: false,
      agentsOnline: this.onlineAgentNames(),
    };
  }

  send(conn: AnyConn, frame: unknown): void {
    if (conn.socket.readyState !== 1) return;
    try {
      conn.socket.send(JSON.stringify(frame));
    } catch (err) {
      logger.warn(`[ws] send failed: ${(err as Error).message}`);
    }
  }

  /** Send a frame to the user's live desktop island and await its reply. */
  async callDesktop(
    userId: string,
    frame: Record<string, unknown>,
    timeoutMs = 20_000,
  ): Promise<Record<string, unknown> | null> {
    const desktop = [...this.desktops.values()].find((d) => d.userId === userId);
    if (!desktop) return null;
    const replyId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingDesktopCalls.delete(replyId);
        resolve(null);
      }, timeoutMs);
      this.pendingDesktopCalls.set(replyId, (reply) => {
        clearTimeout(timer);
        this.pendingDesktopCalls.delete(replyId);
        resolve(reply);
      });
      this.send(desktop, { ...frame, replyId });
    });
  }

  private pendingDesktopCalls = new Map<string, (reply: Record<string, unknown>) => void>();

  /** Fan out one event record to every live client of its user. */
  private deliver(raw: EventRecord): void {
    const userId = raw.userId;
    if (!userId) return;
    for (const conn of this.clients.values()) {
      if (conn.userId !== userId) continue;
      if (conn.replaying) {
        if (raw.id > 0) conn.buffer.push(raw);
        continue;
      }
      if (raw.id === 0) {
        // Live-only event (e.g. chat.delta): deliver regardless of cursor.
        this.send(conn, deliverable(raw));
        continue;
      }
      if (raw.id > conn.cursor) {
        this.send(conn, envelope(raw));
        conn.cursor = raw.id;
      }
    }
    // The island rides the same user event stream as the phone, but its wire
    // is thin: raw events, no replay/cursor envelopes.
    for (const conn of this.desktops.values()) {
      if (conn.userId !== userId) continue;
      this.send(conn, raw.event);
    }
  }

  async handleAgentFrame(conn: AgentConn, frame: AgentFrame): Promise<void> {
    switch (frame.type) {
      case "task.claim": {
        const assigned = await delegation.tryClaim(conn.agent, frame.kinds);
        for (const task of assigned) this.send(conn, task);
        break;
      }
      case "task.update": {
        await delegation.applyUpdate(frame.taskId, {
          status: frame.status,
          progress: frame.progress,
          agent: frame.agent ?? conn.agent,
        });
        break;
      }
      case "task.step": {
        await delegation.applyStep(frame.taskId, conn.agent, frame.label);
        break;
      }
      case "task.result": {
        await delegation.applyResult(frame.taskId, conn.agent, frame.result, frame.summary);
        break;
      }
      case "task.error": {
        await delegation.applyError(frame.taskId, conn.agent, frame.error);
        break;
      }
      case "task.await": {
        await delegation.applyAwaitingInput(frame.taskId, conn.agent, frame.question, frame.options);
        break;
      }
      case "text.delta": {
        await delegation.applyTextDelta(frame.taskId, conn.agent, frame.text);
        break;
      }
      case "agent.log": {
        await delegation.applyLog(frame.level, conn.agent, frame.message, frame.taskId);
        break;
      }
      case "friend.delivered": {
        await applyFriendFrame(frame as unknown as Parameters<typeof friends.applyAgentFrame>[0]);
        break;
      }
      case "friend.reply": {
        await applyFriendFrame(frame as unknown as Parameters<typeof friends.applyAgentFrame>[0]);
        break;
      }
      case "friend.error": {
        await applyFriendFrame(frame as unknown as Parameters<typeof friends.applyAgentFrame>[0]);
        break;
      }
      default:
        break;
    }
  }

  sendToAgent(agent: string, frame: AgentFrame | AgentFrameFromHub): boolean {
    for (const conn of this.agents.values()) {
      if (conn.agent === agent && conn.socket.readyState === 1) {
        this.send(conn, frame);
        return true;
      }
    }
    return false;
  }

  hasDirectConnection(agent: string): boolean {
    for (const conn of this.agents.values()) {
      if (conn.agent === agent && conn.socket.readyState === 1) return true;
    }
    return false;
  }

  onlineAgentNames(): string[] {
    const names = new Set<string>();
    for (const conn of this.agents.values()) {
      if (conn.socket.readyState === 1) names.add(conn.agent);
    }
    return [...names];
  }

  broadcastAgentsOnline(): void {
    const agents = this.onlineAgentNames();
    const rec: EventEnvelope = {
      type: "event",
      id: 0,
      ts: new Date().toISOString(),
      event: { type: "agents.online", agents },
    };
    for (const conn of this.clients.values()) {
      this.send(conn, rec);
    }
  }

  /** The user answered an approval from another device: to the island only. */
  private deliverCodingDecision(userId: string, frame: ClientFrame): void {
    if (frame.type !== "coding.decision") return;
    let delivered = false;
    for (const conn of this.desktops.values()) {
      if (conn.userId !== userId || conn.socket.readyState !== 1) continue;
      this.send(conn, frame);
      delivered = true;
    }
    if (!delivered) {
      logger.info(`[ws] coding decision with no live island user=${userId} request=${frame.requestId}`);
    }
  }

  private heartbeat(): void {
    const all: AnyConn[] = [...this.clients.values(), ...this.agents.values(), ...this.desktops.values(), ...this.pending.values()];
    for (const conn of all) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      if (conn.socket.readyState === 1) conn.socket.ping();
    }
  }

  clientCount(): number {
    return this.clients.size;
  }
}

type ServerFrameOk = { type: "hello"; hello: HelloFrame };

export const hub = new WsHubImpl();
