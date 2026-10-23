// Remote coding tasks — the desktop island actually runs the local coding CLI
// when an Agentverse/uAgents agent asks for code work.
//
// Every run is bounded by an allow-list of workspace roots (HI_CODING_ROOTS,
// defaulting to the user's home), a hard timeout, and a killable process tree.
// The CLIs are driven in their non-interactive/streaming modes:
//
//   claude       claude -p --output-format stream-json --verbose
//   opencode     opencode run <prompt> --format json
//   antigravity  agy -p <prompt> --output-format stream-json
//
// stdout is NDJSON; parsers are deliberately tolerant because each CLI's event
// vocabulary changes between releases. Unknown lines still become live output.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodingAgentId = "claude" | "opencode" | "antigravity";

export const CODING_AGENT_IDS: readonly CodingAgentId[] = ["claude", "opencode", "antigravity"];

export const CODING_AGENT_LABELS: Record<CodingAgentId, string> = {
  claude: "Claude Code",
  opencode: "OpenCode",
  antigravity: "Antigravity",
};

export interface CodingTaskAssign {
  taskId: string;
  title?: string;
  prompt: string;
  agent: CodingAgentId;
  cwd?: string | null;
  timeoutMs?: number;
}

export interface CodingRunResult {
  agent: CodingAgentId;
  output: string;
  sessionId: string | null;
  exitCode: number;
  durationMs: number;
  cwd: string;
  steps: string[];
}

export interface CodingRunnerHooks {
  onStep(taskId: string, label: string): void;
  onOutput(taskId: string, text: string): void;
  onHeartbeat(taskId: string, progress: number): void;
  onResult(taskId: string, result: CodingRunResult, summary: string): void;
  onError(taskId: string, error: string): void;
}

export interface StartOutcome {
  ok: boolean;
  error?: string;
  cwd?: string;
}

export interface AgentProbe {
  id: CodingAgentId;
  label: string;
  command: string;
  available: boolean;
  path: string | null;
}

interface ParsedLine {
  text?: string;
  steps?: string[];
  sessionId?: string;
  finalText?: string;
  error?: string;
  done?: boolean;
}

interface Run {
  taskId: string;
  agent: CodingAgentId;
  cwd: string;
  child: ChildProcess;
  startedAt: number;
  output: string;
  finalText: string;
  stderr: string;
  steps: string[];
  sessionId: string | null;
  failure: string | null;
  cancelled: boolean;
  timedOut: boolean;
  heartbeat: NodeJS.Timeout | null;
  timeout: NodeJS.Timeout | null;
  stdoutBuffer: string;
}

const MAX_PROMPT = 12_000;
const MAX_OUTPUT = 200_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const HEARTBEAT_MS = 30_000;

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function toolStep(name: string, input?: Record<string, unknown> | null): string {
  const target = input
    ? firstString(input["command"], input["file_path"], input["path"], input["query"], input["pattern"])
    : undefined;
  return target ? `Uses ${name} · ${target.slice(0, 60)}` : `Uses ${name}`;
}

// ── Per-agent NDJSON parsers ─────────────────────────────────────────────────

/** Claude Code stream-json (`system`, `assistant`, `user`, `result`). */
export function parseClaudeEvent(event: unknown): ParsedLine {
  const map = obj(event);
  if (!map) return {};
  const type = str(map["type"]) ?? "";
  const sessionId = firstString(map["session_id"], map["sessionId"]);
  if (type === "system") return { sessionId };

  if (type === "assistant" || type === "user") {
    const message = obj(map["message"]);
    const content = message?.["content"] ?? map["content"];
    const parts = Array.isArray(content) ? content.map(obj).filter((p): p is Record<string, unknown> => p !== null) : [];
    let text = "";
    const steps: string[] = [];
    for (const part of parts) {
      const partType = str(part["type"]) ?? "";
      if (partType === "text") text += str(part["text"]) ?? "";
      if (partType === "tool_use") {
        steps.push(toolStep(str(part["name"]) ?? "Tool", obj(part["input"])));
      }
    }
    return { text: text || undefined, steps: steps.length ? steps : undefined, sessionId };
  }

  if (type === "result") {
    const isError = map["is_error"] === true;
    const resultText = firstString(map["result"], map["error"]);
    return {
      finalText: resultText,
      sessionId,
      error: isError ? resultText ?? "Claude Code reported an error" : undefined,
      done: true,
    };
  }
  return { sessionId };
}

/** OpenCode JSON events: text/tool parts under `part` (or `data`). */
export function parseOpencodeEvent(event: unknown): ParsedLine {
  const root = obj(event);
  if (!root) return {};
  const sessionId = firstString(root["sessionID"], root["sessionId"], root["session_id"]);
  const part = obj(root["part"]) ?? obj(root["data"]) ?? root;
  const type = firstString(part["type"], root["type"]) ?? "";

  const text = firstString(part["text"], part["delta"], root["text"], root["delta"]);
  const tool = obj(part["tool"]) ?? obj(root["tool"]);
  const toolName = firstString(tool?.["name"], part["tool"], part["name"], root["tool_name"]);
  const state = obj(tool?.["state"]) ?? obj(part["state"]);
  const input = obj(tool?.["input"]) ?? obj(state?.["input"]);

  if (type === "error" || root["error"] || part["error"]) {
    const error = obj(root["error"]) ?? obj(part["error"]);
    return {
      error: firstString(error?.["message"], error?.["data"], root["error"], part["error"]) ?? "OpenCode reported an error",
      sessionId,
    };
  }
  if (type === "tool" || type === "tool_use" || toolName) {
    return { steps: toolName ? [toolStep(toolName, input)] : undefined, sessionId };
  }
  if (type === "step_start" || type === "step-start" || type === "reasoning") {
    return { steps: text ? [text.slice(0, 80)] : undefined, sessionId };
  }
  if (text) return { text, sessionId };
  if (type === "step_finish" || type === "done" || type === "complete" || type === "completed") {
    return { done: true, sessionId };
  }
  return { sessionId };
}

/**
 * Antigravity (`agy --output-format stream-json`) and Gemini-style streams:
 * init / message / tool_use / result, with `content` or `delta` text.
 */
export function parseAntigravityEvent(event: unknown): ParsedLine {
  const root = obj(event);
  if (!root) return {};
  const data = obj(root["data"]) ?? root;
  const type = firstString(data["type"], root["type"], data["event"], root["event"]) ?? "";
  const sessionId = firstString(
    data["session_id"],
    data["sessionId"],
    root["session_id"],
    root["sessionId"],
    data["conversationId"],
  );

  const text = firstString(data["delta"], data["text"], data["content"], root["delta"], root["text"]);
  const toolName = firstString(
    data["tool_name"],
    data["toolName"],
    data["name"],
    obj(data["toolCall"])?.["name"] as string | undefined,
  );
  const toolInput =
    obj(data["tool_input"]) ??
    obj(data["toolInput"]) ??
    obj(obj(data["toolCall"])?.["args"]) ??
    obj(data["args"]);

  if (type.includes("error") || data["error"] || root["error"]) {
    return {
      error: firstString(data["error"], root["error"], data["message"]) ?? "Antigravity reported an error",
      sessionId,
    };
  }
  if (type.includes("tool") || toolName) {
    return { steps: toolName ? [toolStep(toolName, toolInput)] : undefined, sessionId };
  }
  if (text) return { text, sessionId };
  if (type === "result" || type === "done" || type === "complete" || type === "completed" || type === "finish") {
    return { done: true, sessionId };
  }
  return { sessionId };
}

export function parseAgentLine(agent: CodingAgentId, line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not NDJSON (the CLI printed a human line): keep it as live output.
    return { text: line.length > 4000 ? line.slice(0, 4000) : line };
  }
  switch (agent) {
    case "claude":
      return parseClaudeEvent(parsed);
    case "opencode":
      return parseOpencodeEvent(parsed);
    case "antigravity":
      return parseAntigravityEvent(parsed);
  }
}

// ── Workspace policy ────────────────────────────────────────────────────────

/** Roots a remote task may touch. Split on `;`, `,` or the platform path list. */
export function allowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env["HI_CODING_ROOTS"] ?? "";
  const parts = raw
    .split(path.delimiter)
    .flatMap((chunk) => chunk.split(","))
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const roots = parts.length ? parts : [os.homedir()];
  const real: string[] = [];
  for (const root of roots) {
    try {
      if (statSync(root).isDirectory()) real.push(realpathSync(root));
    } catch {
      // A configured root that does not exist is simply not usable.
    }
  }
  return real;
}

function inside(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const norm = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const r = norm(root).replace(/[\\/]+$/, "");
  const c = norm(candidate);
  return c === r || c.startsWith(r + path.sep);
}

export function resolveWorkspace(
  requested: string | null | undefined,
  roots: string[],
  platform: NodeJS.Platform = process.platform,
  fallback: string = os.homedir(),
): { ok: true; cwd: string } | { ok: false; error: string } {
  const candidate = (requested ?? "").trim() || roots[0] || fallback;
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return { ok: false, error: `Workspace does not exist: ${candidate}` };
  }
  try {
    if (!statSync(real).isDirectory()) {
      return { ok: false, error: `Workspace is not a directory: ${real}` };
    }
  } catch {
    return { ok: false, error: `Workspace is not readable: ${real}` };
  }
  if (!roots.some((root) => inside(root, real, platform))) {
    return {
      ok: false,
      error:
        `Workspace ${real} is outside HI_CODING_ROOTS. ` +
        `Allowed: ${roots.length ? roots.join(", ") : "(none configured)"}`,
    };
  }
  return { ok: true, cwd: real };
}

// ── Command discovery + argv ────────────────────────────────────────────────

const WINDOWS_EXTS = [".cmd", ".exe", ".bat", ""];

export function resolveCommand(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const direct = path.isAbsolute(name) || name.includes("/") || name.includes("\\");
  const candidates = direct
    ? [name]
    : (env["PATH"] ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .flatMap((dir) =>
          (platform === "win32" ? WINDOWS_EXTS : [""]).map((ext) => path.join(dir, name + ext)),
        );
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export interface AgentCommand {
  file: string;
  args: string[];
  stdinPrompt: boolean;
}

/** The argv for one non-interactive run (exported so it is testable). */
export function commandFor(agent: CodingAgentId, prompt: string): AgentCommand {
  switch (agent) {
    case "claude":
      // Long prompts go through stdin; `-p` without an argument reads it.
      return {
        file: "claude",
        args: ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"],
        stdinPrompt: true,
      };
    case "opencode":
      return { file: "opencode", args: ["run", prompt, "--format", "json"], stdinPrompt: false };
    case "antigravity":
      return { file: "agy", args: ["-p", prompt, "--output-format", "stream-json"], stdinPrompt: false };
  }
}

function quoteCmdArg(arg: string): string {
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  // MSVCRT argv quoting; cmd.exe treats metacharacters inside quotes literally.
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

function spawnCommand(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ChildProcess {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    const line = [quoteCmdArg(file), ...args.map(quoteCmdArg)].join(" ");
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(file, args, { cwd, env, windowsHide: true });
}

// ── Runner ──────────────────────────────────────────────────────────────────

export class CodingRunner {
  private runs = new Map<string, Run>();

  constructor(
    private hooks: CodingRunnerHooks,
    private options: {
      env?: NodeJS.ProcessEnv;
      platform?: NodeJS.Platform;
      roots?: string[];
      fallbackCwd?: string;
    } = {},
  ) {}

  private env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  roots(): string[] {
    return this.options.roots ?? allowedRoots(this.env());
  }

  probe(): AgentProbe[] {
    return CODING_AGENT_IDS.map((id) => {
      const command = commandFor(id, "").file;
      const resolved = resolveCommand(command, this.env(), this.platform());
      return {
        id,
        label: CODING_AGENT_LABELS[id],
        command,
        available: resolved !== null,
        path: resolved,
      };
    });
  }

  isRunning(taskId: string): boolean {
    return this.runs.has(taskId);
  }

  start(request: CodingTaskAssign): StartOutcome {
    if (this.runs.has(request.taskId)) {
      return { ok: false, error: `task ${request.taskId} is already running` };
    }
    const prompt = String(request.prompt ?? "");
    if (!prompt.trim()) return { ok: false, error: "empty coding prompt" };
    if (prompt.length > MAX_PROMPT) {
      return { ok: false, error: `prompt is too long (${prompt.length} > ${MAX_PROMPT})` };
    }
    if (!CODING_AGENT_IDS.includes(request.agent)) {
      return { ok: false, error: `unsupported coding agent: ${String(request.agent)}` };
    }

    const workspace = resolveWorkspace(
      request.cwd,
      this.roots(),
      this.platform(),
      this.options.fallbackCwd ?? os.homedir(),
    );
    if (!workspace.ok) return { ok: false, error: workspace.error };

    const spec = commandFor(request.agent, prompt);
    const executable = resolveCommand(spec.file, this.env(), this.platform());
    if (!executable) {
      return {
        ok: false,
        error: `${CODING_AGENT_LABELS[request.agent]} is not installed or not on PATH (${spec.file})`,
      };
    }

    let child: ChildProcess;
    try {
      child = spawnCommand(executable, spec.args, workspace.cwd, this.env(), this.platform());
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    const timeoutMs = Math.max(
      10_000,
      Math.min(60 * 60_000, Number(request.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    );
    const run: Run = {
      taskId: request.taskId,
      agent: request.agent,
      cwd: workspace.cwd,
      child,
      startedAt: Date.now(),
      output: "",
      finalText: "",
      stderr: "",
      steps: [],
      sessionId: null,
      failure: null,
      cancelled: false,
      timedOut: false,
      heartbeat: null,
      timeout: null,
      stdoutBuffer: "",
    };
    this.runs.set(request.taskId, run);

    run.heartbeat = setInterval(() => {
      const progress = Math.min(90, 8 + run.steps.length * 4 + Math.floor((Date.now() - run.startedAt) / 15_000) * 3);
      this.hooks.onHeartbeat(run.taskId, progress);
    }, HEARTBEAT_MS);
    run.heartbeat.unref?.();

    run.timeout = setTimeout(() => {
      run.timedOut = true;
      this.kill(run);
    }, timeoutMs);
    run.timeout.unref?.();

    if (spec.stdinPrompt) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(prompt);
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(run, chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      run.stderr = (run.stderr + chunk).slice(-8000);
    });
    child.on("error", (err) => {
      run.failure = err.message;
    });
    child.on("close", (code) => this.finish(run, code ?? 1));

    this.hooks.onStep(request.taskId, `Started ${CODING_AGENT_LABELS[request.agent]} in ${workspace.cwd}`);
    return { ok: true, cwd: workspace.cwd };
  }

  cancel(taskId: string): boolean {
    const run = this.runs.get(taskId);
    if (!run) return false;
    run.cancelled = true;
    this.kill(run);
    return true;
  }

  stopAll(): void {
    for (const run of this.runs.values()) {
      run.cancelled = true;
      this.kill(run);
    }
    this.runs.clear();
  }

  private onStdout(run: Run, chunk: string): void {
    run.stdoutBuffer += chunk;
    let newline = run.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = run.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      run.stdoutBuffer = run.stdoutBuffer.slice(newline + 1);
      this.consumeLine(run, line);
      newline = run.stdoutBuffer.indexOf("\n");
    }
    if (run.stdoutBuffer.length > 64 * 1024) {
      this.consumeLine(run, run.stdoutBuffer);
      run.stdoutBuffer = "";
    }
  }

  private consumeLine(run: Run, line: string): void {
    if (!line.trim()) return;
    const parsed = parseAgentLine(run.agent, line);
    if (parsed.sessionId) run.sessionId = parsed.sessionId;
    if (parsed.error) run.failure = parsed.error;
    if (parsed.finalText) run.finalText = parsed.finalText;
    for (const step of parsed.steps ?? []) {
      if (!step || run.steps.includes(step)) continue;
      run.steps.push(step.slice(0, 160));
      this.hooks.onStep(run.taskId, step.slice(0, 160));
    }
    if (parsed.text) {
      const text = parsed.text;
      if (run.output.length < MAX_OUTPUT) {
        const room = MAX_OUTPUT - run.output.length;
        run.output += text.slice(0, room);
      }
      this.hooks.onOutput(run.taskId, text.slice(0, 8000));
    }
  }

  private kill(run: Run): void {
    const pid = run.child.pid;
    try {
      run.child.kill();
    } catch {
      // already gone
    }
    if (pid && this.platform() === "win32") {
      try {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        // best effort
      }
    }
  }

  private finish(run: Run, exitCode: number): void {
    if (run.heartbeat) clearInterval(run.heartbeat);
    if (run.timeout) clearTimeout(run.timeout);
    this.runs.delete(run.taskId);
    if (run.stdoutBuffer.trim()) {
      const trailing = run.stdoutBuffer;
      run.stdoutBuffer = "";
      this.consumeLine(run, trailing);
    }

    if (run.cancelled) return;
    const output = (run.finalText || run.output).trim();
    if (run.timedOut) {
      this.hooks.onError(run.taskId, `coding task timed out after ${Math.round((Date.now() - run.startedAt) / 1000)}s`);
      return;
    }
    if (run.failure || exitCode !== 0) {
      const detail = run.failure || run.stderr.trim() || output || `exited with code ${exitCode}`;
      this.hooks.onError(run.taskId, detail.slice(0, 2000));
      return;
    }
    const result: CodingRunResult = {
      agent: run.agent,
      output: output.slice(0, 100_000),
      sessionId: run.sessionId,
      exitCode,
      durationMs: Date.now() - run.startedAt,
      cwd: run.cwd,
      steps: run.steps,
    };
    const summary = output.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 180)
      ?? `${CODING_AGENT_LABELS[run.agent]} finished`;
    this.hooks.onResult(run.taskId, result, summary);
  }
}
