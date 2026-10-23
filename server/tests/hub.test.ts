import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";

// The hub module tree reads JWT_SECRET at import time, so it is imported below.
let hub: (typeof import("../src/ws/hub.js"))["hub"];
let signAccessToken: (typeof import("../src/auth/tokens.js"))["signAccessToken"];
let server: http.Server | null = null;
let port = 0;

interface Conn {
  ws: WebSocket;
  frames: unknown[];
  closed: Promise<void>;
}

function connect(url: string): Promise<Conn> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${url}`);
  const frames: unknown[] = [];
  const closed = new Promise<void>((resolve) => {
    ws.on("close", resolve);
  });
  ws.on("message", (data) => {
    try {
      frames.push(JSON.parse(String(data)));
    } catch {
      // ignore non-JSON
    }
  });
  return new Promise((resolve) => {
    ws.on("open", () => resolve({ ws, frames, closed }));
  });
}

async function hangUp(...conns: Conn[]): Promise<void> {
  for (const c of conns) c.ws.close();
  await Promise.all(conns.map((c) => c.closed));
}

function waitFor(
  frames: unknown[],
  predicate: (f: Record<string, unknown>) => boolean,
  what: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      const found = frames.find((f) => predicate(f as Record<string, unknown>));
      if (found) return resolve(found as Record<string, unknown>);
      if (Date.now() - start > 3000) return reject(new Error(`no frame: ${what}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

const snapshot = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "coding.snapshot",
  sessions: [
    {
      id: "claude",
      agent: null,
      sessionId: "s1",
      projectName: "demo",
      cwd: "E:\\Projects\\demo",
      status: "working",
      steps: [{ label: "Runs · npm install", ts: new Date().toISOString() }],
      finalLine: null,
      updatedAt: new Date().toISOString(),
    },
  ],
  pending: {
    requestId: "r1",
    sessionId: "s1",
    pillId: "claude",
    tool: "Bash",
    command: "Bash · npm install",
    questions: null,
    createdAt: new Date().toISOString(),
  },
  ...over,
});

function sessionWithStatus(status: string): Record<string, unknown> {
  return {
    id: "claude",
    agent: null,
    sessionId: "s1",
    projectName: "demo",
    cwd: "E:\\Projects\\demo",
    status,
    steps: [{ label: "Runs · npm install", ts: new Date().toISOString() }],
    finalLine: null,
    updatedAt: new Date().toISOString(),
  };
}

const eventOf = (f: Record<string, unknown>): Record<string, unknown> =>
  (f["event"] as Record<string, unknown>) ?? {};

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-suite-for-hub";
  process.env.AGENT_TOKEN = "agent-test-suite-token";
  ({ hub } = await import("../src/ws/hub.js"));
  ({ signAccessToken } = await import("../src/auth/tokens.js"));
  server = http.createServer();
  hub.attach(server, async () => {});
  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
});

describe("hub — the desktop wire", () => {
  it("device.hello signs in a desktop; the phone sees its coding world", async () => {
    const user = crypto.randomUUID();
    const token = await signAccessToken({ sub: user, role: "user" });
    const desktop = await connect("/ws");
    desktop.ws.send(JSON.stringify({ type: "device.hello", token, device: { kind: "desktop", name: "DESK", platform: "win32" } }));
    const hello = await waitFor(desktop.frames, (f) => f["type"] === "hello", "desktop hello");
    expect(hello["hello"]).toMatchObject({ userId: user });

    // Let the frame land before the phone joins.
    desktop.ws.send(JSON.stringify(snapshot()));

    const phone = await connect(`/ws?token=${token}&since=0`);
    const session = await waitFor(phone.frames, (f) => f["type"] === "coding.session" || eventOf(f)["type"] === "coding.session", "initial coding.session");
    const sessionBody = (session["session"] ?? (eventOf(session)["session"])) as { id: string };
    expect(sessionBody.id).toBe("claude");
    const approval = await waitFor(phone.frames, (f) => f["type"] === "coding.approval" || eventOf(f)["type"] === "coding.approval", "initial approval");
    const approvalBody = (approval["approval"] ?? (eventOf(approval)["approval"])) as { requestId: string };
    expect(approvalBody.requestId).toBe("r1");

    await hangUp(desktop, phone);
  });

  it("a snapshot's deltas become events; repeated snapshots are silent", async () => {
    const user = crypto.randomUUID();
    const token = await signAccessToken({ sub: user, role: "user" });
    const desktop = await connect("/ws");
    desktop.ws.send(JSON.stringify({ type: "device.hello", token, device: { kind: "desktop", name: "DESK2", platform: "win32" } }));
    await waitFor(desktop.frames, (f) => f["type"] === "hello", "hello");

    const phone = await connect(`/ws?token=${token}&since=0`);

    desktop.ws.send(JSON.stringify(snapshot({ sessions: [sessionWithStatus("thinking")] })));
    await waitFor(phone.frames, (f) => eventOf(f)["type"] === "coding.session", "coding.session delta");
    const approval = await waitFor(phone.frames, (f) => eventOf(f)["type"] === "coding.approval", "coding.approval");
    expect((approval["event"] as { approval: { requestId: string } }).approval.requestId).toBe("r1");

    const before = phone.frames.length;
    await new Promise((r) => setTimeout(r, 300));
    desktop.ws.send(JSON.stringify(snapshot({ sessions: [sessionWithStatus("thinking")] })));
    await new Promise((r) => setTimeout(r, 300));
    expect(phone.frames.length).toBe(before);

    desktop.ws.send(JSON.stringify(snapshot({ pending: null, sessions: [sessionWithStatus("idle")] })));
    const dropped = await waitFor(phone.frames, (f) => eventOf(f)["type"] === "coding.approval.dropped", "approval dropped");
    expect((dropped["event"] as { requestId: string }).requestId).toBe("r1");

    await hangUp(desktop, phone);
  });

  it("the phone's coding.decision reaches the live island", async () => {
    const user = crypto.randomUUID();
    const token = await signAccessToken({ sub: user, role: "user" });
    const desktop = await connect("/ws");
    desktop.ws.send(JSON.stringify({ type: "device.hello", token, device: { kind: "desktop", name: "DESK3", platform: "win32" } }));
    await waitFor(desktop.frames, (f) => f["type"] === "hello", "hello");
    const phone = await connect(`/ws?token=${token}&since=0`);

    phone.ws.send(JSON.stringify({ type: "coding.decision", requestId: "r7", decision: "allow" }));

    const decision = await waitFor(desktop.frames, (f) => f["type"] === "coding.decision", "coding.decision on island");
    expect(decision).toMatchObject({ requestId: "r7", decision: "allow" });

    await hangUp(desktop, phone);
  });

  it("an unknown token on device.hello is refused", async () => {
    const desktop = await connect("/ws");
    desktop.ws.send(JSON.stringify({ type: "device.hello", token: "nope", device: { kind: "desktop", name: "X", platform: "win32" } }));
    await desktop.closed;
    expect(true).toBe(true);
  });

  it("a client token in the URL is still the documented path", async () => {
    const token = await signAccessToken({ sub: crypto.randomUUID(), role: "user" });
    const phone = await connect(`/ws?token=${token}&since=0`);
    const hello = await waitFor(phone.frames, (f) => f["type"] === "hello", "hello");
    expect(typeof (hello["hello"] as { userId: string }).userId).toBe("string");
    phone.ws.close();
    await phone.closed;
  });
});
