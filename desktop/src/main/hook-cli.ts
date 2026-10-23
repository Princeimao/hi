// Port of mu/windows/hook/src/main.rs — the relay that agents run: stdin JSON
// in, one connection to the island's pipe, then the agent's own stdout contract
// (reply.ts) for whatever comes back. `--agent <name>` says whose contract that
// is, `--statusline` relays Claude Code's plan limits and exits fast.
//
// The one rule: nothing that allows anything is printed without a decision a
// human clicked. With no decision, silence or "{}" — never an allow.

// This module runs inside the Electron app's main process before anything
// else: main.ts checks argv first and hands control here.

const CONNECT_TIMEOUT_MS = 300;
const REPLY_TIMEOUT_MS = 110_000;
const MAX_STDIN = 1 << 20;

import net from "node:net";
import { pipeName } from "./pipe-server";
import { normalizeEvent, normalizeFields, refineEvent } from "./adapters";
import { hookStdout } from "./reply";

export interface HookCliArgs {
  event: string;
  agent: string;
  statusline: boolean;
}

export function parseHookArgs(argv: string[]): HookCliArgs | null {
  const i = argv.indexOf("--hook");
  if (i === -1) return null;
  const event = argv[i + 1] ?? "";
  let agent = "";
  const a = argv.indexOf("--agent");
  if (a !== -1) agent = argv[a + 1] ?? "";
  const statusline = argv.includes("--statusline");
  return { event: event.replace(/^--/, ""), agent, statusline };
}

export async function runHookCli(args: HookCliArgs): Promise<number> {
  const payload = await readStdin(MAX_STDIN);
  if (payload === null) return 0;

  if (args.statusline) {
    // The plan numbers relay: hand the island the latest limits, print nothing,
    // never wait.
    await forward(args.agent, normalizeEvent("StatusLine"), payload);
    return 0;
  }

  normalizeFields(payload, (key) => process.env[key]);
  const event = refineEvent(normalizeEvent(args.event || ""), payload);
  if (!event) {
    // Without an event the payload is not actionable; silence.
    return 0;
  }
  const question =
    event === "PermissionRequest" && isQuestion(payload)
      ? ((payload["tool_input"] as Record<string, unknown>) ?? null)
      : null;

  // The island may not be running: it takes 300 ms to find out, and then the
  // agent still follows its own stdout contract for "no island".
  let decision: string | null = null;
  await forward(args.agent, event, payload, (d) => {
    decision = d;
  });

  if (event !== "PermissionRequest") {
    // Antigravity reads "{}" on PreToolUse as a denial. "ask" keeps its own
    // prompt; Hi never allows a tool by itself. Other JSON agents read "{}" as
    // "no opinion"; everyone else reads silence.
    const out = hookStdout(args.agent, event, null, null);
    if (out !== null) process.stdout.write(out + "\n");
    return 0;
  }
  if (decision === null) return 0;
  const out = decisionStdout(args.agent, decision, question);
  if (out !== null) process.stdout.write(out + "\n");
  return 0;
}

/// The reply from the pipe, printed in the shape that agent's stdout contract
/// documents (reply.ts). Anything unrecognised prints nothing at all.
function decisionStdout(agent: string, decision: string, question: Record<string, unknown> | null): string | null {
  return hookStdout(agent, "PermissionRequest", decision, question);
}

function isQuestion(payload: Record<string, unknown>): boolean {
  const input = payload["tool_input"];
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  return (input as Record<string, unknown>)["questions"] !== undefined;
}

export async function readStdin(max: number): Promise<Record<string, unknown> | null> {
  let buf = Buffer.alloc(0);
  // `complete` is only set when stdin delivered a whole line (newline) or the
  // stream ended cleanly. A timeout mid-payload leaves it false so we never
  // parse a truncated JSON body.
  let complete = false;
  await new Promise<void>((resolve) => {
    let closed = false;
    const done = () => {
      if (!closed) {
        closed = true;
        resolve();
      }
    };
    process.stdin.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.includes(10)) {
        complete = true;
        done();
      } else if (buf.length > max) {
        process.stdin.destroy();
        done();
      }
    });
    process.stdin.on("end", () => {
      complete = true;
      done();
    });
    process.stdin.on("error", () => {
      complete = true;
      done();
    });
    // Timeout: leave `complete` false — a partial body is not actionable.
    setTimeout(done, 1_000);
  });
  if (!complete || buf.length === 0) return null;
  const text = buf.toString("utf8");
  const line = text.split("\n")[0].trim();
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/// Sends the payload by connecting to the island's pipe. Every payload is one
/// newline-terminated line. `onDecision` receives the bare word or the answers
/// JSON the island writes back — or nothing, when nobody acted on the card.
async function forward(
  agent: string,
  event: string,
  payload: Record<string, unknown>,
  onDecision?: (d: string) => void,
): Promise<void> {
  void agent;
  const name = pipeName();
  const body = JSON.stringify({ ...payload, hook_event_name: event }) + "\n";
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const socket = net.createConnection(name);
    socket.setNoDelay(true);
    let reply = Buffer.alloc(0);
    let sent = false;
    const overall = setTimeout(() => {
      socket.destroy();
      done();
    }, onDecision ? REPLY_TIMEOUT_MS : CONNECT_TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write(body);
      sent = true;
      if (onDecision) {
        socket.setTimeout(REPLY_TIMEOUT_MS, () => {
          socket.destroy();
          done();
        });
      } else {
        // The island answers nothing on the one-way events; the connection
        // closes when it is through.
        socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
          socket.destroy();
          done();
        });
      }
    });
    socket.on("data", (chunk: Buffer) => {
      reply = Buffer.concat([reply, chunk]);
    });
    socket.on("close", () => {
      clearTimeout(overall);
      void sent;
      const text = reply.toString("utf8").split("\n")[0].trim();
      if (onDecision && text) onDecision(text);
      done();
    });
    socket.on("error", () => {
      clearTimeout(overall);
      done();
    });
  });
}
