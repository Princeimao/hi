// Port of mu/windows/src-tauri/src/pipe.rs — the server side of hi-hook.
//
// Windows: the named pipe `\\.\pipe\hi-<key>`, one hi-hook process per event.
// Every hook event is forwarded to the island. `PermissionRequest` is the only
// one that keeps its connection open: it waits for the island's decision and
// writes it back on the same connection, which is how approving works.
//
// Claude Code is never blocked by Hi. Three things guarantee it:
//   * hi-hook gives the connection 300 ms and exits cleanly if Hi is closed;
//   * we only wait for a human once the island confirmed the card is really on
//     screen, so an island that is not listening costs a few hundred
//     milliseconds, not two minutes;
//   * whatever happens, we drop the pipe after the decision timeout, and the
//     terminal takes over.
//
// What is written back is the bare word `allow` / `deny`, or `{"answers":…}`
// for Claude Code's AskUserQuestion. Turning either into the documented
// hookSpecificOutput JSON is hi-hook's job (reply.ts), so the wire format
// Claude Code expects lives in exactly one place.

import net from "node:net";
import { execSync } from "node:child_process";
import { normalizeEvent, normalizeFields, refineEvent } from "./adapters";

const MAX_PAYLOAD = 1 << 20;
/// Slightly under hi-hook's own 110 s wait, so we always answer first.
export const DECISION_TIMEOUT_MS = 108_000;
/// How long the island gets to say "the card is up". Without it, an island
/// that is paused or not listening would leave Claude Code staring at a prompt
/// nobody can see for nearly two minutes.
export const ACK_TIMEOUT_MS = 800;

export type Decision = { word: string } | { answers: Record<string, string | string[]> };

type DecisionSink = (decision: Decision | null) => void;

export class PermissionBroker {
  private waiting = new Map<string, { sink: DecisionSink; acked: boolean }>();
  private timers = new Set<NodeJS.Timeout>();

  /// A pipe connection hands over its sink and waits. Returns a release fn the
  /// connection itself may call when the socket goes away.
  wait(requestId: string, sink: DecisionSink): () => void {
    const entry = { sink, acked: false };
    this.waiting.set(requestId, entry);
    const ackTimer = setTimeout(() => {
      if (this.waiting.get(requestId) === entry && !entry.acked) {
        this.release(requestId, null);
      }
    }, ACK_TIMEOUT_MS);
    const decisionTimer = setTimeout(() => {
      if (this.waiting.get(requestId) === entry) {
        this.release(requestId, null);
      }
    }, DECISION_TIMEOUT_MS);
    const release = () => this.release(requestId, null);
    return () => {
      clearTimeout(ackTimer);
      clearTimeout(decisionTimer);
      release();
    };
  }

  /// The island confirmed the card is on screen: the long wait may begin.
  ack(requestId: string): boolean {
    const entry = this.waiting.get(requestId);
    if (!entry || entry.acked) return false;
    entry.acked = true;
    return true;
  }

  /// A human clicked — desktop or phone. Nothing is written unless this was
  /// called with a decision that came from a click.
  decide(requestId: string, decision: Decision): void {
    this.release(requestId, decision);
  }

  /// Nobody can act on this one — paused, another card holds the view. The
  /// terminal takes over right away.
  decline(requestId: string): void {
    this.release(requestId, null);
  }

  private release(requestId: string, decision: Decision | null): void {
    const entry = this.waiting.get(requestId);
    if (!entry) return;
    this.waiting.delete(requestId);
    entry.sink(decision);
  }

  clear(): void {
    for (const id of [...this.waiting.keys()]) this.release(id, null);
  }
}

let counter = 0;
function nextId(): number {
  counter += 1;
  return counter;
}

export function pipeKey(): string {
  return currentSid() || process.env["USERNAME"] || process.env["USER"] || "user";
}

export function pipeName(): string {
  return `\\\\.\\pipe\\hi-${pipeKey()}`;
}

/// `whoami /user` once: the pipe carries only this user's hook traffic, so it
/// is namespaced by SID rather than shared across accounts.
export function currentSid(): string | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execSync("whoami /user", { timeout: 2_000, encoding: "utf8" });
    return out.match(/S-1-[\d-]+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

export interface PipeRelay {
  stop(): void;
}

/// Starts the relay. The registry's actions (decisions, declines) should be
/// forwarded to the broker by the caller via `applyActionsToBroker`, so one
/// code path serves renderer, phone and pipe alike.
export function startPipeRelay(
  registry: import("./registry").SessionRegistry,
  broker: PermissionBroker,
): PipeRelay {
  const server = net.createServer((socket) => handleConnection(socket));

  function handleConnection(socket: net.Socket): void {
    let buf: Buffer = Buffer.alloc(0);
    let done = false;
    let release = () => {};
    socket.on("error", () => {});
    socket.on("close", () => release());
    socket.on("data", (chunk: Buffer) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk] as Buffer[]);
      if (!buf.includes(10) && buf.length <= MAX_PAYLOAD) return;
      done = true;
      socket.pause();
      const line = buf.indexOf(10) === -1 ? buf : buf.subarray(0, buf.indexOf(10));
      try {
        processPayload(socket, line);
      } catch {
        socket.destroy();
      }
    });
  }

  function processPayload(socket: net.Socket, line: Buffer): void {
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line.toString("utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        socket.destroy();
        return;
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      socket.destroy();
      return;
    }
    // The relay already normalized; idempotent, and it also covers plugins
    // talking to us directly.
    normalizeFields(payload, (key) => process.env[key]);
    const rawEvent = typeof payload["hook_event_name"] === "string" ? payload["hook_event_name"] : "";
    const event = refineEvent(normalizeEvent(rawEvent), payload);

    if (event !== "PermissionRequest") {
      registry.ingest({ ...payload, hook_event_name: event });
      socket.end();
      return;
    }

    const id = `${process.pid}-${nextId()}`;
    payload["request_id"] = id;
    registry.ingest({ ...payload, hook_event_name: event });
    const release = broker.wait(id, (decision: Decision | null) => {
      // No decision: say nothing at all. hi-hook then writes nothing to stdout
      // and Claude Code asks in the terminal, exactly as if Hi were closed.
      if (decision !== null) {
        const text =
          "word" in decision ? decision.word : JSON.stringify({ answers: decision.answers });
        socket.write(text + "\n");
      }
      socket.end();
    });
    const onDisconnect = () => release();
    socket.on("close", onDisconnect);
  }

  const stop = (): void => {
    broker.clear();
    try {
      server.close();
    } catch {
      // already closed
    }
  };

  // Another Hi serves the pipe already: we refuse to fight over it.
  server.on("error", () => {});
  server.listen(pipeName());
  return { stop };
}

export function applyActionsToBroker(
  broker: PermissionBroker,
  actions: import("./registry").RegistryAction[],
): void {
  for (const action of actions) {
    if (action.type === "reply.decline") {
      broker.decline(action.requestId);
    } else if (action.type === "reply.answer") {
      // A question's answers are resolved by answerQuestion, not here.
      if (action.decision === "a question") continue;
      const d: Decision = action.decision.startsWith("{")
        ? { answers: (JSON.parse(action.decision) as { answers: Record<string, string | string[]> })["answers"] }
        : { word: action.decision };
      broker.decide(action.requestId, d);
    }
  }
}

/// A question's answers go back through the same broker, tagged as answers so
/// the CLI pairs them with the question text.
export function brokerAnswers(
  broker: PermissionBroker,
  requestId: string,
  answers: Record<string, string | string[]>,
): void {
  broker.decide(requestId, { answers });
}

export const noop = (): void => {};
export const __local = { execSync };
