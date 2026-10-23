/**
 * Hi — shared protocol between the Express/WebSocket backend, the Electron
 * desktop companion, the Android app and the Fetch.ai agent gateway.
 *
 * Everything here is plain types with no runtime dependency, so the same
 * module is reused by all three TypeScript workspaces.
 */

// ── Avatar ───────────────────────────────────────────────────────────────────

/**
 * User-visible avatar states. Each maps to an animation of the
 * @bible-strong avatar definition of the companion.
 */
export type AvatarState =
  | "greeting"
  | "idle"
  | "thinking"
  | "working"
  | "searching"
  | "waiting"
  | "error"
  | "happy"
  | "sleeping";

export const AVATAR_STATES: readonly AvatarState[] = [
  "greeting",
  "idle",
  "thinking",
  "working",
  "searching",
  "waiting",
  "error",
  "happy",
  "sleeping",
];

/** Animation key of the bundled `hubu.avatar.json` definition for a state. */
export const AVATAR_ANIMATION: Record<AvatarState, string> = {
  greeting: "waking",
  idle: "idle",
  thinking: "thinking",
  working: "working",
  searching: "searching",
  waiting: "curious",
  error: "sad",
  happy: "celebrate",
  sleeping: "sleeping",
};

// ── Conversations and messages ───────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessageMeta {
  /** Model or agent that produced this message. */
  source?: string;
  /** Streaming is still in flight for this message. */
  streaming?: boolean;
  /** Agent tasks that contributed to this message. */
  tasks?: string[];
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  meta: ChatMessageMeta;
  createdAt: string;
  seq: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  lastMessageAt: string;
  messageCount?: number;
  lastPreview?: string;
}

// ── Tasks (delegations to agents) ────────────────────────────────────────────

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskKind =
  | "chat"
  | "research"
  | "plan"
  | "memory"
  | "friend"
  | "coding"
  | "custom";

/** Local coding CLIs the desktop island can drive for remote agents. */
export type CodingAgentId = "claude" | "opencode" | "antigravity";

export const CODING_AGENTS: readonly CodingAgentId[] = [
  "claude",
  "opencode",
  "antigravity",
];

/** What a remote agent asks the desktop to run. */
export interface CodingRequest {
  prompt: string;
  agent?: CodingAgentId;
  /** Must live under the desktop's allowed workspace roots. */
  cwd?: string;
  /** Hard wall-clock limit for one run. */
  timeoutMs?: number;
}

export interface AgentTask {
  id: string;
  userId?: string;
  conversationId: string | null;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  /** Agent that claimed/was assigned the task, e.g. "coordinator", "researcher". */
  agent: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  /** 0-100. */
  progress: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStep {
  label: string;
  ts: string;
}

// ── Memories ─────────────────────────────────────────────────────────────────

export type MemoryKind =
  | "fact"
  | "preference"
  | "goal"
  | "person"
  | "routine"
  | "project";

export interface Memory {
  id: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  importance: number;
  sourceConversationId: string | null;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Notifications ────────────────────────────────────────────────────────────

export type NotificationKind =
  | "agent_completed"
  | "agent_failed"
  | "awaiting_input"
  | "memory"
  | "info";

export interface UserNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  taskId: string | null;
  readAt: string | null;
  createdAt: string;
}

// ── Coding sessions (desktop agents: Claude Code, Codex, Gemini CLI, …) ─────
//
// A separate world from the Fetch.ai tasks: these come from the desktop island
// (hi desktop window) watching real coding-agent hook traffic, and are relayed
// to other devices so a phone can see and answer permission requests.

export interface CodingStep {
  label: string;
  ts: string;
}

export interface CodingSession {
  id: string;
  /** Canonical pill id, e.g. "claude" or "agent_codex". */
  pillId: string;
  /** Valid agent tag, or null for Claude Code. */
  agent: string | null;
  sessionId: string;
  projectName: string;
  cwd: string;
  status:
    | "idle"
    | "thinking"
    | "working"
    | "question"
    | "approval"
    | "finished"
    | "error"
    | "ratelimit";
  steps: CodingStep[];
  finalLine: string | null;
  updatedAt: string;
}

export interface CodingQuestion {
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export interface CodingApproval {
  requestId: string;
  sessionId: string;
  pillId: string;
  /** Claude Code, Codex, Copilot CLI or Muse Code. */
  agent: string | null;
  tool: string;
  /** What the Allow button actually authorises (`Bash · rm -rf /`). */
  command: string;
  /** Claude Code's AskUserQuestion, when that is what is asked. */
  questions: CodingQuestion[] | null;
  createdAt: string;
}

// ── Events (the persisted per-user event stream) ─────────────────────────────

export type ServerEvent =
  | { type: "chat.message"; message: ChatMessage }
  | { type: "chat.delta"; messageId: string; conversationId: string; text: string }
  | { type: "chat.delivered"; messageId: string }
  | { type: "conversation.created"; conversation: Conversation }
  | { type: "conversation.updated"; conversation: Conversation }
  | { type: "conversation.deleted"; conversationId: string }
  | { type: "avatar.state"; state: AvatarState ; reason?: string }
  | { type: "task.created"; task: AgentTask }
  | { type: "task.updated"; task: AgentTask }
  | { type: "task.step"; taskId: string; step: TaskStep }
  | { type: "task.completed"; task: AgentTask }
  | { type: "task.failed"; task: AgentTask }
  | { type: "task.awaiting_input"; task: AgentTask; question: string; options?: string[] }
  | { type: "agent.event"; event: AgentActivity }
  | { type: "memory.extracted"; memories: Memory[] }
  | { type: "memory.deleted"; memoryId: string }
  | { type: "memory.updated"; memory: Memory }
  | { type: "notification"; notification: UserNotification }
  | { type: "agents.online"; agents: string[] }
  // Service integrations (tokens per user, set through the app).
  | { type: "integration.connected"; service: string; account?: string }
  | { type: "integration.disconnected"; service: string }
  | { type: "friend.delivered"; friendId: string; messageId: string; ackId: string }
  | { type: "friend.reply"; friendId: string; messageId: string; text: string }
  | { type: "friend.error"; friendId: string; messageId: string; reason: string }
  // Coding-agent world (desktop island).
  | { type: "coding.session"; session: CodingSession }
  | { type: "coding.session.removed"; pillId: string }
  | { type: "coding.approval"; approval: CodingApproval }
  | { type: "coding.approval.dropped"; requestId: string; reason: string }
  // Live stdout/stderr from a remote coding task (never persisted).
  | { type: "coding.task.output"; taskId: string; text: string }
  | { type: "chat.tool"; tool: string; label: string; ok: boolean; reason?: string }
  | { type: "chat.tool.result"; tool: string; label: string; ok: boolean; output: string; reason?: string } | { type: "chat.timer"; seconds: number } | { type: "todo.created"; todo: { id: string; text: string; done: boolean; source: string; created_at: string } } | { type: "todo.updated"; todo: { id: string; text: string; done: boolean; source: string; created_at: string } } | { type: "todo.deleted"; id: string } | { type: "coding.decision"; requestId: string; decision: "allow" | "deny"; answers?: Record<string, string> };

/** A single activity log line from the agent system, persisted in the trail. */
export interface AgentActivity {
  id: string;
  taskId: string | null;
  agent: string;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
}

export interface EventEnvelope {
  /** Per-user monotonic sequence, stored so disconnects can replay. */
  type: "event";
  id: number;
  ts: string;
  event: ServerEvent;
  /** Topics: "ui" (everything), "agents", "chat" — clients may filter. */
}

// ── Client → server frames ──────────────────────────────────────────────────

export interface HelloFrame {
  userId: string;
  role: "client" | "agent" | "unknown";
  reconnect: boolean;
  agentsOnline: string[];
}

/** Frames the backend sends over the WebSocket after the handshake. */
export type ServerFrame = { type: "hello"; hello: HelloFrame } | EventEnvelope;

export type ClientFrame =
  | {
      type: "chat.send";
      conversationId: string | null;
      text: string;
      /** Optional client-generated id so the message can be de-duplicated. */
      clientMessageId?: string;
    }
  | { type: "chat.stop"; conversationId: string; messageId: string }
  | { type: "task.resolve_input"; taskId: string; answer: string }
  | { type: "presence.state"; state: AvatarState }
  | { type: "ping" }
  /** A human answered an approval — from the phone, when the desktop relayed it. */
  | {
      type: "coding.decision";
      requestId: string;
      decision: "allow" | "deny";
      /** AskUserQuestion answers: one label, or the list of labels picked. */
      answers?: Record<string, string | string[]>;
    };

/** Frames agents (running Python uAgents or hosted on Agentverse) exchange with the backend. */
export type AgentFrame =
  | { type: "agent.hello"; agent: string; modes: string[]; capabilities: string[] }
  /** Ask for queued work the agent is able to run (capabilities: kinds it handles). */
  | { type: "task.claim"; agent: string; kinds: string[] }
  | {
      type: "task.update";
      taskId: string;
      status?: TaskStatus;
      progress?: number;
      agent?: string;
    }
  | { type: "task.step"; taskId: string; label: string }
  | { type: "task.result"; taskId: string; result: Record<string, unknown>; summary?: string }
  | { type: "task.error"; taskId: string; error: string }
  | { type: "task.await"; taskId: string; question: string; options?: string[] }
  /** Streaming assistant tokens produced by an agent while it runs a chat task. */
  | { type: "text.delta"; taskId: string; text: string }
  | { type: "agent.log"; level: "info" | "warn" | "error"; message: string; taskId?: string }
  | { type: "friend.delivered"; taskId: string; address: string; ackId: string }
  | { type: "friend.reply"; taskId: string; address: string; text: string }
  | { type: "friend.error"; taskId: string; address: string; detail: string };

/** A full assignment the hub sends to an agent — covers both push and claim flows. */
export type TaskAssignment = {
  type: "task.assign";
  task: AgentTask;
  /** Chat context when the task kind is "chat" (so agents do not refetch). */
  context:
    | {
        kind: "chat";
        conversationId: string;
        messageId: string;
        text: string;
        history: { role: "user" | "assistant"; content: string }[];
        memories: { kind: string; content: string }[];
        /** Output of an executed tool (integration or Agentverse friend). */
        tools?: string;
      }
    /** Coding context: the desktop island runs the CLI, not an agent. */
    | {
        kind: "coding";
        prompt: string;
        agent: CodingAgentId;
        cwd: string | null;
        timeoutMs: number;
      }
    | { kind: "generic" };
};

/** Additional frames the hub sends toward agents. */
export type AgentFrameFromHub =
  | TaskAssignment
  | { type: "task.input"; taskId: string; answer: string }
  | { type: "pong"; ts: string };

// ── REST payload shapes (documentation + clients) ────────────────────────────

export interface AuthTokenPair {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  displayName: string;
}

export interface DeviceInfo {
  id: string;
  kind: "desktop" | "mobile" | "agent";
  name: string;
  lastSeenAt: string;
  cursor: number;
}
