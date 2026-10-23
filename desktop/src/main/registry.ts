// Port of mu/windows/src/island/hooks.ts — hook events from Claude Code and
// every other agent → Hi's session state. The relay (hook CLI + pipe server)
// has already mapped every agent's events and fields onto Claude Code's
// (adapters.ts), so one handler serves them all.
//
// Runs in the Electron main process: no DOM, no per-view routing; the renderer
// only renders. Timers are injectable so the approval lifecycle is testable.

import { APPROVAL_AGENTS, validateAgent } from "./agents-meta";
import { editLabel, fileChange } from "./diff";
import { codeViewFrom } from "./codewatch";

export interface AskedQuestion {
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  prompt?: string;
  last_assistant_message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  hi_agent?: string;
  coucou_agent?: string;
  status?: unknown;
}

export type SessionStatus =
  | "idle"
  | "thinking"
  | "working"
  | "question"
  | "approval"
  | "finished"
  | "error"
  | "ratelimit";

export interface Session {
  id: string;
  /** Valid agent tag, or null for Claude Code's own pill. */
  agent: string | null;
  sessionId: string;
  projectName: string;
  cwd: string;
  status: SessionStatus;
  steps: string[];
  finalLine: string | null;
  /** What the agent is editing right now (grid + kind) for the code card. */
  code?: import("./codewatch").CodeView;
  updatedAt: number;
}

export interface Approval {
  requestId: string;
  sessionId: string;
  pillId: string;
  tool: string;
  command: string;
  questions: AskedQuestion[] | null;
}

export type RegistryAction =
  | { type: "session.started"; session: Session }
  | { type: "session.updated"; session: Session }
  | { type: "session.removed"; id: string }
  | { type: "approval.begin"; approval: Approval }
  | { type: "approval.drop"; requestId: string; reason: string }
  | { type: "reply.decline"; requestId: string }
  | { type: "reply.answer"; requestId: string; decision: string };

export const ACK_TIMEOUT_MS = 800;
export const CARD_TIMEOUT_MS = 110_000;
export const STOP_TIMER_MS = 5_200;

const TURN_OVER = new Set(["Stop", "StopFailure", "UserPromptSubmit", "SessionEnd", "Interrupt"]);

const TOOL_LABELS: Record<string, string> = {
  Bash: "Runs",
  Read: "Reads",
  Write: "Writes",
  Edit: "Edits",
  Glob: "Searches",
  Grep: "Searches",
  WebSearch: "Searches the web",
  WebFetch: "Fetches",
  TodoWrite: "Tasks",
  Task: "Agent",
  LS: "Lists",
  MultiEdit: "Edits",
  NotebookEdit: "Notebook",
  PowerShell: "Runs",
  run_command: "Runs",
  view_file: "Reads",
  write_to_file: "Writes",
  write_file: "Writes",
  replace_file_content: "Edits",
  multi_replace_file_content: "Edits",
  read_url_content: "Fetches",
  search_web: "Searches the web",
  ask_question: "Needs input",
};

const APPROVAL_FIELDS = ["command", "file_path", "path", "url", "query", "pattern", "prompt"];

export function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

export function stepLabel(tool: string, input: Record<string, unknown>): string {
  const labelTool = tool === "ask_question" || tool.endsWith(":ask_question") ? "ask_question" : tool;
  const label = TOOL_LABELS[labelTool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  if (
    (tool === "ask_question" || tool.endsWith(":ask_question")) &&
    Array.isArray(input["questions"]) &&
    input["questions"].length > 0
  ) {
    const first = input["questions"][0] as Record<string, unknown> | null;
    if (first && typeof first["question"] === "string" && first["question"].trim()) {
      return `${label} · ${first["question"].trim().slice(0, 40)}`;
    }
  }
  return label;
}

/// What the Allow button actually authorises. Approving "Write" tells you
/// nothing — approving `Write · C:\…\.env` tells you everything.
export function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) return `${tool} · ${value.trim()}`;
  }
  return tool;
}

/// The questions of an AskUserQuestion call, if the island can show all of them
/// as options to pick from. Anything it cannot is left to the terminal.
export function askedQuestions(tool: string, input: Record<string, unknown>): AskedQuestion[] | null {
  if (tool !== "AskUserQuestion" || !Array.isArray(input["questions"])) return null;
  const out: AskedQuestion[] = [];
  for (const raw of input["questions"] as unknown[]) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const question = typeof item["question"] === "string" ? item["question"] : "";
    const rawOptions = Array.isArray(item["options"]) ? item["options"] : [];
    const options = rawOptions
      .map((o) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>) : null))
      .filter((o): o is Record<string, unknown> => o !== null && typeof o["label"] === "string" && o["label"].length > 0)
      .map((o) => ({
        label: o["label"] as string,
        description: typeof o["description"] === "string" ? o["description"] : "",
      }));
    // A question cut short by the relay would be answered under the wrong text.
    if (!question || question.endsWith("…") || options.length < 2) return null;
    out.push({ question, options, multiSelect: item["multiSelect"] === true });
  }
  return out.length > 0 ? out : null;
}

export type Answer =
  | { kind: "word"; word: string }
  | { kind: "answers"; answers: Record<string, string | string[]> };

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (t) => globalThis.clearTimeout(t as NodeJS.Timeout),
};

export class SessionRegistry {
  sessions = new Map<string, Session>();
  pending: Approval | null = null;
  paused = false;

  private stopTimers = new Map<string, unknown>();
  private cardTimer: unknown = null;
  private clock: Timers;
  private notify: (actions: RegistryAction[]) => void;

  constructor(notify: (actions: RegistryAction[]) => void = () => {}, clock: Timers = realTimers) {
    this.notify = notify;
    this.clock = clock;
  }

  private emit(...actions: RegistryAction[]): void {
    if (actions.length) this.notify(actions);
  }

  session(agentId: string): Session | undefined {
    return this.sessions.get(agentId);
  }

  snapshot(): { sessions: Session[]; pending: Approval | null; paused: boolean } {
    return { sessions: [...this.sessions.values()], pending: this.pending, paused: this.paused };
  }

  /** The card goes down; with a decline action the terminal takes the question. */
  private dropPendingCard(reason: string, decline = false): RegistryAction[] {
    const pending = this.pending;
    if (!pending) return [];
    this.pending = null;
    if (this.cardTimer !== null) {
      this.clock.clearTimeout(this.cardTimer);
      this.cardTimer = null;
    }
    const actions: RegistryAction[] = [
      { type: "approval.drop", requestId: pending.requestId, reason },
      this.restoreView(pending.pillId),
    ];
    if (decline) actions.push({ type: "reply.decline", requestId: pending.requestId });
    return actions;
  }

  private restoreView(pillId: string): RegistryAction {
    const session = this.sessions.get(pillId) ?? this.placeholder(pillId);
    return { type: "session.updated", session };
  }

  private placeholder(pillId: string): Session {
    return {
      id: pillId,
      agent: pillId.startsWith("agent_") ? pillId.slice("agent_".length) : null,
      sessionId: "",
      projectName: "",
      cwd: "",
      status: "idle",
      steps: [],
      finalLine: null,
      updatedAt: 0,
    };
  }

  private cancelStopTimer(id: string): boolean {
    const timer = this.stopTimers.get(id);
    if (timer === undefined) return false;
    this.clock.clearTimeout(timer);
    this.stopTimers.delete(id);
    return true;
  }

  private ensureSession(agentId: string, projectName: string, cwd: string, sessionId: string, agent: string | null): Session {
    const existing = this.sessions.get(agentId);
    if (existing) {
      if (cwd) existing.cwd = cwd;
      if (sessionId) existing.sessionId = sessionId;
      existing.updatedAt = Date.now();
      return existing;
    }
    const session: Session = {
      id: agentId,
      agent,
      sessionId,
      projectName,
      cwd,
      status: "idle",
      steps: [],
      finalLine: null,
      updatedAt: Date.now(),
    };
    this.sessions.set(agentId, session);
    this.emit({ type: "session.started", session });
    return session;
  }

  private notifyChanged(session: Session): void {
    this.emit({ type: "session.updated", session });
  }

  /// One hook event. Notifications to the world go through the constructor's
  /// `notify` callback (the action array is returned for tests).
  ingest(payload: HookPayload): RegistryAction[] {
    const name = payload.hook_event_name ?? "";
    if (name === "StatusLine") return [];

    const raw = payload.hi_agent ?? payload.coucou_agent;
    const agent = validateAgent(raw);
    const isExternal = agent !== null;
    const agentId = agent ? `agent_${agent}` : "claude";
    const cwd = payload.cwd ?? "";
    const projectName = cwd ? lastPathComponent(cwd) : "Session";
    const sessionId = payload.session_id ?? "";

    const actions: RegistryAction[] = [];

    // A paused island says so immediately: the relay waits a few hundred
    // milliseconds, not two minutes, and the terminal takes the question.
    if (this.paused) {
      const id = payload.request_id;
      actions.push(...this.dropPendingCard("paused"));
      if (id) actions.push({ type: "reply.decline", requestId: id });
      this.emit(...actions);
      return actions;
    }

    // The turn that asked for a permission is over — answered in the terminal,
    // interrupted, or a new prompt — so the card would be lying.
    if (this.pending && TURN_OVER.has(name) && this.pending.pillId === agentId && this.pending.sessionId === sessionId) {
      actions.push(...this.dropPendingCard("turn over", true));
    }

    const ensure = () => this.ensureSession(agentId, projectName, cwd, sessionId, agent);

    switch (name) {
      case "SessionStart": {
        const session = ensure();
        session.finalLine = null;
        this.notifyChanged(session);
        break;
      }
      case "UserPromptSubmit": {
        const session = ensure();
        this.cancelStopTimer(agentId);
        session.finalLine = null;
        session.status = "thinking";
        const asked = typeof payload.prompt === "string" && payload.prompt ? payload.prompt : payload.message;
        if (typeof asked === "string" && asked) session.steps = [...session.steps, asked.slice(0, 60)];
        session.updatedAt = Date.now();
        this.notifyChanged(session);
        break;
      }
      case "PreToolUse": {
        const session = ensure();
        this.cancelStopTimer(agentId);
        session.finalLine = null;
        const tool = payload.tool_name ?? "Tool";
        const isQuestion = tool === "ask_question" || tool.endsWith(":ask_question");
        session.status = isQuestion ? "question" : "working";
        session.steps = [...session.steps, stepLabel(tool, payload.tool_input ?? {})];
        const nextCode = codeViewFrom(tool, (payload.tool_input ?? {}) as Record<string, unknown>, undefined);
        if (nextCode) session.code = nextCode;
        session.updatedAt = Date.now();
        this.notifyChanged(session);
        break;
      }
      case "PostToolUse": {
        this.cancelStopTimer(agentId);
        // The question was answered in the terminal: the card would be lying.
        if (
          payload.tool_name === "AskUserQuestion" &&
          this.pending?.questions &&
          this.pending.sessionId === (payload.session_id ?? "")
        ) {
          actions.push(...this.dropPendingCard("answered in terminal"));
        }
        const session = this.sessions.get(agentId);
        if (session) {
          session.status = "working";
          const change = fileChange(String(payload.tool_name ?? ""), payload.tool_input as Record<string, unknown> | null | undefined);
          if (change) {
            session.steps = [...session.steps, editLabel(change, session.cwd)];
          }
          const nextCode = codeViewFrom(String(payload.tool_name ?? ""), payload.tool_input as Record<string, unknown> | null | undefined, payload.tool_response);
          if (nextCode) session.code = nextCode;
          session.updatedAt = Date.now();
          this.notifyChanged(session);
        }
        break;
      }
      case "PostToolUseFailure": {
        this.cancelStopTimer(agentId);
        const session = this.sessions.has(agentId) ? this.sessions.get(agentId)! : ensure();
        session.status = "working";
        session.steps = [...session.steps, "failed"];
        session.updatedAt = Date.now();
        this.notifyChanged(session);
        break;
      }
      case "Notification": {
        const message = payload.message ?? "";
        const lower = message.toLowerCase();
        if (lower.includes("rate limit") || lower.includes("limite d")) {
          this.cancelStopTimer(agentId);
          const session = this.sessions.has(agentId) ? this.sessions.get(agentId)! : ensure();
          session.status = "ratelimit";
          session.updatedAt = Date.now();
          this.notifyChanged(session);
        } else if (message.endsWith("?")) {
          this.cancelStopTimer(agentId);
          const session = this.sessions.has(agentId) ? this.sessions.get(agentId)! : ensure();
          session.status = "question";
          session.steps = [...session.steps, message];
          session.updatedAt = Date.now();
          this.notifyChanged(session);
        }
        break;
      }
      case "Stop": {
        const session = this.sessions.get(agentId);
        if (session) {
          session.status = "finished";
          const finalText = oneLine((typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "") ?? (payload.message as string) ?? "");
          if (finalText) {
            session.steps = [...session.steps, finalText];
            session.finalLine = finalText;
          }
          session.updatedAt = Date.now();
          this.notifyChanged(session);
        }
        this.cancelStopTimer(agentId);
        // Every session — Claude Code and every external agent — drops to idle
        // and stays on the rail. Only SessionEnd (or Interrupt clearing the
        // steps) removes it, so the island keeps showing cwd, last steps and
        // diffs between prompts instead of reading "No agent sessions."
        const timer = this.clock.setTimeout(() => {
          this.stopTimers.delete(agentId);
          const s = this.sessions.get(agentId);
          if (!s) return;
          s.status = "idle";
          s.updatedAt = Date.now();
          this.emit({ type: "session.updated", session: s });
        }, STOP_TIMER_MS);
        this.stopTimers.set(agentId, timer);
        break;
      }
      case "Interrupt": {
        this.cancelStopTimer(agentId);
        const session = this.sessions.get(agentId);
        if (session) {
          session.status = "idle";
          session.updatedAt = Date.now();
          this.notifyChanged(session);
        }
        break;
      }
      case "StopFailure": {
        this.cancelStopTimer(agentId);
        const session = this.sessions.has(agentId) ? this.sessions.get(agentId)! : ensure();
        session.status = "error";
        session.updatedAt = Date.now();
        this.notifyChanged(session);
        break;
      }
      case "SessionEnd": {
        // Nothing left for the timer to do, and it must not outlive the session.
        this.cancelStopTimer(agentId);
        if (isExternal) {
          this.sessions.delete(agentId);
          actions.push({ type: "session.removed", id: agentId });
        } else {
          const session = this.sessions.get(agentId);
          if (session) {
            session.status = "idle";
            session.steps = [];
            session.finalLine = null;
            session.sessionId = "";
            session.updatedAt = Date.now();
            actions.push({ type: "session.updated", session });
          }
        }
        break;
      }
      case "SubagentStart": {
        const session = this.sessions.get(agentId);
        if (session) {
          session.steps = [...session.steps, "+ subagent"];
          this.notifyChanged(session);
        }
        break;
      }
      case "SubagentStop": {
        const session = this.sessions.get(agentId);
        if (session) {
          session.steps = [...session.steps, "subagent done"];
          this.notifyChanged(session);
        }
        break;
      }
      case "PermissionRequest": {
        // Only Claude Code and the agents the relay can answer for get a card.
        // Anyone else's request is declined at once, so the agent asks in its
        // own terminal.
        const requestId = payload.request_id ?? "";
        if (!isApprovalAgent(agent)) {
          if (requestId) actions.push({ type: "reply.decline", requestId });
          break;
        }
        // One card, one request. A second one must never quietly replace the
        // first — that would leave a human staring at request B while request
        // A waits for a decision nobody can give.
        if (this.pending && this.pending.requestId !== requestId) {
          if (requestId) actions.push({ type: "reply.decline", requestId });
          break;
        }
        const session = ensure();
        this.cancelStopTimer(agentId);
        if (this.cardTimer !== null) {
          this.clock.clearTimeout(this.cardTimer);
          this.cardTimer = null;
        }
        const tool = payload.tool_name ?? "Tool";
        const input = payload.tool_input ?? {};
        // Claude Code asking a question is not a permission to grant: the
        // island shows the options and sends back the one picked. Only Claude
        // Code asks questions this way.
        const questions = isExternal ? null : askedQuestions(tool, input);
        this.pending = {
          requestId,
          sessionId,
          pillId: agentId,
          tool,
          command: approvalTarget(tool, input),
          questions,
        };
        session.status = questions ? "question" : "approval";
        session.updatedAt = Date.now();
        this.notifyChanged(session);
        // Hi answers within 108 s or not at all; after that the terminal has
        // taken over and the card would be lying.
        this.cardTimer = this.clock.setTimeout(() => {
          this.cardTimer = null;
          this.emit(...this.dropPendingCard("timed out"));
        }, CARD_TIMEOUT_MS);
        actions.push({ type: "approval.begin", approval: this.pending });
        break;
      }
      default:
        break;
    }

    this.emit(...actions);
    return actions;
  }

  /// The renderer (or phone) confirmed the card is on screen: the long wait
  /// may begin. Returns true when the request is the live one.
  ack(requestId: string): boolean {
    return this.pending?.requestId === requestId;
  }

  /// Allow / Deny from a human click — desktop or phone. Returns the bare
  /// decision to write back, or null when it is not the live request.
  answer(requestId: string, decision: string): { actions: RegistryAction[]; decision: string | null } {
    if (!this.pending || this.pending.requestId !== requestId) return { actions: [], decision: null };
    const word = decision === "allow" || decision === "always" ? "allow" : "deny";
    const actions = this.removePending("answered");
    actions.push({ type: "reply.answer", requestId, decision: word });
    this.emit(...actions);
    return { actions, decision: word };
  }

  /// An option picked for a question Claude Code asked. `answers` maps each
  /// question's text to its chosen label(s) — one string for a single-select,
  /// a non-empty list of distinct labels for a multi-select (Claude Code
  /// 2.1.136+ takes the list, as the Mac sends it).
  answerQuestion(
    requestId: string,
    answers: Record<string, string | string[]>,
  ): { actions: RegistryAction[]; answers: Record<string, string | string[]> | null } {
    if (!this.pending || this.pending.requestId !== requestId || !this.pending.questions) {
      return { actions: [], answers: null };
    }
    const actions = this.removePending("answered a question");
    actions.push({ type: "reply.answer", requestId, decision: "a question" });
    this.emit(...actions);
    return { actions, answers };
  }

  /// The island is not answering this one — "answer in terminal". Nothing is
  /// written back; the terminal takes over exactly as if Hi were closed.
  decline(requestId: string): { actions: RegistryAction[]; declined: boolean } {
    if (!this.pending || this.pending.requestId !== requestId) return { actions: [], declined: false };
    const actions: RegistryAction[] = [
      ...this.removePending("declined"),
      { type: "reply.decline", requestId },
    ];
    this.emit(...actions);
    return { actions, declined: true };
  }

  private removePending(reason: string): RegistryAction[] {
    const pending = this.pending;
    if (!pending) return [];
    this.pending = null;
    if (this.cardTimer !== null) {
      this.clock.clearTimeout(this.cardTimer);
      this.cardTimer = null;
    }
    return [
      { type: "approval.drop", requestId: pending.requestId, reason },
      this.restoreView(pending.pillId),
    ];
  }

  /// Pause: cards are refused so the terminal takes over at once.
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.emit(...this.dropPendingCard("paused"));
  }

  dispose(): void {
    for (const t of this.stopTimers.values()) this.clock.clearTimeout(t);
    this.stopTimers.clear();
    if (this.cardTimer !== null) this.clock.clearTimeout(this.cardTimer);
    this.cardTimer = null;
  }
}

function isApprovalAgent(agent: string | null): boolean {
  return agent === null || APPROVAL_AGENTS.includes(agent);
}

/// The turn's final answer on one card line.
function oneLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}
