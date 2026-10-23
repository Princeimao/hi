// The desktop's connection to the Hi backend — how coding sessions and
// approvals reach the phone, and a phone's answer reaches the approval card.
//
// A tiny wire, pinned by the desktop tests:
//   device → hub:  {type:"device.hello", token, device}
//   device → hub:  {type:"coding.snapshot", sessions, pending}
//   device → hub:  {type:"coding.resolved", requestId, decision, answers?}
//   hub → device:  {type:"coding.decision", requestId, decision, answers?}
//
// Whole-state snapshots keep the phone honest (it renders the same truth the
// island does) and cost a few hundred bytes; a distant user's payloads never
// touch the server's users table.

import os from "node:os";

export function defaultBackendUrl(): string {
  return process.env["HI_BACKEND_URL"] ?? "ws://localhost:8787/ws";
}

export const RECONNECT_MS = 4_000;

export interface CodingSessionWire {
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

export interface CodingApprovalWire {
  requestId: string;
  sessionId: string;
  pillId: string;
  agent: string | null;
  tool: string;
  command: string;
  questions: unknown;
  createdAt: string;
}

export type DesktopOutgoing =
  | {
      type: "device.hello";
      token: string;
      device: { kind: "desktop"; name: string; platform: string };
    }
  | { type: "coding.snapshot"; sessions: CodingSessionWire[]; pending: CodingApprovalWire | null }
  | {
      type: "coding.resolved";
      requestId: string;
      decision: "allow" | "deny";
      answers?: Record<string, string | string[]>;
    }
  | { type: "coding.task.step"; taskId: string; label: string }
  | { type: "coding.task.output"; taskId: string; text: string }
  | { type: "coding.task.heartbeat"; taskId: string; progress?: number }
  | {
      type: "coding.task.result";
      taskId: string;
      result: Record<string, unknown>;
      summary: string;
    }
  | { type: "coding.task.error"; taskId: string; error: string }
  | { type: "chat.send"; conversationId: string | null; text: string; clientMessageId?: string }
  | { type: "chat.stop"; conversationId: string; messageId: string }
  | { type: "local.result"; replyId: string; ok: boolean; output?: string; error?: string };

export type DesktopIncoming =
  | {
      type: "coding.decision";
      requestId: string;
      decision: string;
      answers?: Record<string, string | string[]>;
    }
  | {
      type: "coding.task.assign";
      taskId: string;
      title?: string;
      prompt: string;
      agent: "claude" | "opencode" | "antigravity";
      cwd?: string | null;
      timeoutMs?: number;
    }
  | { type: "coding.task.cancel"; taskId: string }
  | { type: string; [extra: string]: unknown };

interface WsLayer {
  send(data: string): void;
  close(): void;
  on(event: string, cb: (...args: any[]) => void): void;
  removeAllListeners?(event?: string): void;
}

export class BackendRelay {
  private ws: WsLayer | null = null;
  private url: string | null = null;
  private token: string | null = null;

  /** Current access token (or null before login is wired through). */
  currentToken(): string | null {
    return this.token;
  }

  /** The REST base derived from the WS URL: ws://host:port/ws → http://host:port */
  restBase(): string {
    return (process.env["HI_BACKEND_URL"] ?? "ws://localhost:8787/ws").replace(/^ws(s?)/, "http$1").replace(/\/ws\/?$/, "");
  }
  private timer: NodeJS.Timeout | null = null;
  private onDecision: ((d: DesktopIncoming) => void) | null = null;
  private onEvent: ((e: Record<string, unknown>) => void) | null = null;
  private onCoding: ((d: DesktopIncoming) => void) | null = null;
  private lastSnapshot: string | null = null;
  /** Frames produced while the socket is down; flushed after the hello. */
  private outbox: string[] = [];
  private stopped = false;
  private dialing = false;

  configure(
    url: string,
    accessToken: string | null,
    onDecision: (d: DesktopIncoming) => void,
    onEvent: (e: Record<string, unknown>) => void,
    onCoding?: (d: DesktopIncoming) => void,
  ): void {
    this.url = url;
    this.token = accessToken;
    this.onDecision = onDecision;
    this.onEvent = onEvent;
    this.onCoding = onCoding ?? null;
    this.dial();
  }

  /** Swap in a fresh access token (device bootstrap / refresh) and redial. */
  setAccessToken(accessToken: string): void {
    this.token = accessToken;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // dial() re-runs on close
      }
      this.ws = null;
    }
    this.dial();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // already closed
    }
  }

  private dial(): void {
    if (this.stopped || this.dialing || !this.url) return;
    this.dialing = true;
    void import("ws")
      .then(({ WebSocket }) => {
        if (this.stopped) {
          this.dialing = false;
          return;
        }
        const ws = new WebSocket(this.url as string, { handshakeTimeout: 8_000 });
        this.ws = ws as unknown as WsLayer;
        ws.on("open", () => {
          this.dialing = false;
          ws.send(
            JSON.stringify({
              type: "device.hello",
              token: this.token ?? "",
              device: { kind: "desktop", name: os.hostname(), platform: os.platform() },
            } satisfies DesktopOutgoing),
          );
          this.sendSnapshot();
          this.flushOutbox();
        });
        ws.on("message", (data: unknown) => void this.receive(data));
        ws.on("close", () => {
          if (this.ws === (ws as unknown as WsLayer)) this.ws = null;
          this.dialing = false;
          this.scheduleReconnect();
        });
        ws.on("error", () => {
          try {
            ws.close();
          } catch {
            // ignore
          }
        });
      })
      .catch(() => {
        this.dialing = false;
        this.scheduleReconnect();
      });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dial();
    }, RECONNECT_MS);
  }

  private async receive(data: unknown): Promise<void> {
    const text = typeof data === "string" ? data : (Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const frame = parsed as { type: string };
    if (frame.type === "local.exec") {
      void this.handleLocalExec(parsed as Record<string, unknown>);
      return;
    }
    if (frame.type === "coding.decision") this.onDecision?.(parsed as DesktopIncoming);
    else if (frame.type.startsWith("coding.task.")) this.onCoding?.(parsed as DesktopIncoming);
    // Everything else (chat deltas, avatar.state, conversations…) streams to
    // the renderer over one channel; hello stays behind, but marks auth-time.
    else if (frame.type === "hello") this.lastAuthOkAt = Date.now();
    else this.onEvent?.(parsed as Record<string, unknown>);
  }

  private async handleLocalExec(frame: Record<string, unknown>): Promise<void> {
    const replyId = String(frame.replyId ?? "");
    const command = String(frame.command ?? "");
    const cwd = frame.cwd ? String(frame.cwd) : undefined;
    if (!command || !replyId) return;
    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execP = promisify(exec);
      const result = await execP(command, { cwd, timeout: 110_000, windowsHide: true, maxBuffer: 256 * 1024 });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 4000);
      this.send({ type: "local.result", replyId, ok: true, output } as DesktopOutgoing);
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const output = [e.stdout, e.stderr].filter(Boolean).join("\n") || e.message || "unknown error";
      this.send({ type: "local.result", replyId, ok: false, error: output.slice(0, 2000) } as DesktopOutgoing);
    }
  }

  /** Timestamp of the last accepted device.hello (0 = never). */
  lastAuthOkAt = 0;

  /** The main process hands over the live snapshot after every action batch:
      pushActions was folded into setSnapshot, which is the one wire. */
  setSnapshot(
    sessions: CodingSessionWire[],
    pending: CodingApprovalWire | null,
  ): void {
    const wire = JSON.stringify({ sessions, pending });
    if (wire === this.lastSnapshot) return;
    this.lastSnapshot = wire;
    this.send({ type: "coding.snapshot", sessions, pending } satisfies DesktopOutgoing);
  }

  resolve(
    requestId: string,
    decision: "allow" | "deny",
    answers?: Record<string, string | string[]>,
  ): void {
    this.send({
      type: "coding.resolved",
      requestId,
      decision,
      ...(answers ? { answers } : {}),
    } satisfies DesktopOutgoing);
  }

  codingStep(taskId: string, label: string): void {
    this.send({ type: "coding.task.step", taskId, label: label.slice(0, 160) } satisfies DesktopOutgoing);
  }

  codingOutput(taskId: string, text: string): void {
    if (!text) return;
    this.send({ type: "coding.task.output", taskId, text: text.slice(0, 8000) } satisfies DesktopOutgoing);
  }

  codingHeartbeat(taskId: string, progress?: number): void {
    this.send({
      type: "coding.task.heartbeat",
      taskId,
      ...(progress !== undefined ? { progress } : {}),
    } satisfies DesktopOutgoing);
  }

  codingResult(taskId: string, result: Record<string, unknown>, summary: string): void {
    this.send({
      type: "coding.task.result",
      taskId,
      result,
      summary: summary.slice(0, 200),
    } satisfies DesktopOutgoing);
  }

  codingError(taskId: string, error: string): void {
    this.send({ type: "coding.task.error", taskId, error: error.slice(0, 2000) } satisfies DesktopOutgoing);
  }

  sendChat(text: string, conversationId: string | null, clientMessageId?: string): void {
    if (!text.trim()) return;
    this.send({
      type: "chat.send",
      conversationId,
      text: text.slice(0, 8000),
      ...(clientMessageId ? { clientMessageId } : {}),
    } satisfies DesktopOutgoing);
  }

  stopChat(conversationId: string, messageId: string): void {
    this.send({ type: "chat.stop", conversationId, messageId } satisfies DesktopOutgoing);
  }

  acknowledge(_requestId: string): void {
    // The ack is a local island affordance; the server still gets the
    // approval card itself through the snapshot.
  }

  /** Queue a frame while offline; the runner's results survive a short drop. */
  private send(frame: DesktopOutgoing): void {
    const wire = JSON.stringify(frame);
    const ws = this.ws;
    if (!ws) {
      this.enqueue(wire);
      this.dial();
      return;
    }
    try {
      ws.send(wire);
    } catch {
      this.ws = null;
      this.enqueue(wire);
      this.scheduleReconnect();
    }
  }

  private enqueue(wire: string): void {
    if (wire.includes('"type":"device.hello"')) return;
    if (this.outbox.length >= 300) this.outbox.shift();
    this.outbox.push(wire);
  }

  private flushOutbox(): void {
    const pending = this.outbox;
    this.outbox = [];
    for (let i = 0; i < pending.length; i += 1) {
      const ws = this.ws;
      if (!ws) {
        this.outbox.push(...pending.slice(i));
        return;
      }
      try {
        ws.send(pending[i]!);
      } catch {
        this.outbox.push(...pending.slice(i));
        return;
      }
    }
  }

  private sendSnapshot(): void {
    const wire = this.lastSnapshot;
    if (!wire) return;
    const { sessions, pending } = JSON.parse(wire) as {
      sessions: CodingSessionWire[];
      pending: CodingApprovalWire | null;
    };
    this.send({ type: "coding.snapshot", sessions, pending } satisfies DesktopOutgoing);
  }
}
