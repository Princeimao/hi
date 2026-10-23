// What the renderer sees of the main process. One small, explicit surface.

export interface CodeRow {
  n?: number;
  t: string;
  k: "ctx" | "add" | "del";
}

export interface CodeView {
  file: string;
  path: string;
  kind: "code" | "diff" | "shell";
  rows: CodeRow[];
}

export interface SessionView {
  code?: CodeView;
  id: string;
  agent: string | null;
  sessionId: string;
  projectName: string;
  cwd: string;
  status: string;
  steps: string[];
  finalLine: string | null;
  updatedAt: number;
}

export interface QuestionView {
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export interface ApprovalView {
  requestId: string;
  sessionId: string;
  pillId: string;
  tool: string;
  command: string;
  questions: QuestionView[] | null;
}

export interface Snapshot {
  sessions: SessionView[];
  pending: ApprovalView | null;
  paused: boolean;
}

export interface Action {
  type: string;
  [key: string]: unknown;
}

export interface SettingsStatus {
  claude: { installed: boolean; settingsPath: string; hookPath: string; hookReady: boolean };
  agents: {
    id: string;
    name: string;
    installed: boolean;
    path: string;
    approvals: boolean;
    note: string;
  }[];
}

export interface PreviewPlan {
  path: string;
  diff: string;
  backup: string;
  fingerprint: string;
  /** Per-file fingerprints, same order as `files` (multi-file plans). */
  fingerprints: string[];
  files: string;
}

export interface IntegrationInfo {
  service: string;
  name: string;
  connected: boolean;
  account: string | null;
  updatedAt: string | null;
}

export interface IntegrationRow {
  title: string;
  state?: string;
  at?: string;
}

export interface RestAuth {
  /** HTTP base of the Hi backend, e.g. http://localhost:4000 */
  restBase: string;
  /** This desktop's access token for the REST+WS backend. */
  token: string | null;
}

declare global {
  interface Window {
    hi: {
      snapshot(): Promise<Snapshot>;
      sessionSynthetic(payload: Record<string, unknown>): void;
      onActions(cb: (actions: Action[]) => void): void;
      ack(requestId: string): void;
      answer(requestId: string, decision: string): void;
      answerQuestion(requestId: string, answers: Record<string, string | string[]>): void;
      decline(requestId: string): void;
      status(): Promise<SettingsStatus>;
      preview(agent: string, install: boolean): Promise<{ ok: boolean; plan?: PreviewPlan; error?: string }>;
      apply(agent: string, install: boolean, fingerprint: string | string[]): Promise<{ ok: boolean; backups?: string; error?: string }>;
      expand(width: number, height: number): void;
      collapse(): void;
      onWindowBlur(cb: () => void): void;
      relaunch(): void;
      setPaused(paused: boolean): void;
      home(): Promise<string>;
      lanIp(): Promise<string>;
      restAuth(): Promise<RestAuth>;
      onHubEvent(cb: (event: Record<string, unknown>) => void): void;
      sendChat(text: string, conversationId: string | null): void;
      stopChat(conversationId: string, messageId: string): void;
      mediaAction(kind: "prev" | "playPause" | "next" | "volDown" | "volUp" | "mute", steps?: number): void;
      mediaInfo(): Promise<{ title: string; artist: string; status: string } | null>;
    };
  }
}

export const integration = {
  async list(): Promise<IntegrationInfo[]> {
    const { restBase, token } = await window.hi.restAuth();
    const res = await fetch(`${restBase}/api/integrations`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET /integrations: HTTP ${res.status}`);
    return (await res.json()) as IntegrationInfo[];
  },
  async connect(service: string, token: string): Promise<IntegrationInfo> {
    const { restBase, token: at } = await window.hi.restAuth();
    const res = await fetch(`${restBase}/api/integrations/${service}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${at}` },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as IntegrationInfo;
  },
  async disconnect(service: string): Promise<void> {
    const { restBase, token: at } = await window.hi.restAuth();
    const res = await fetch(`${restBase}/api/integrations/${service}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${at}` },
    });
    if (!res.ok) throw new Error(`DELETE: HTTP ${res.status}`);
  },
  async items(service: string, query = ""): Promise<IntegrationRow[]> {
    const { restBase, token: at } = await window.hi.restAuth();
    const res = await fetch(`${restBase}/api/integrations/${service}/items${query}`, {
      headers: { Authorization: `Bearer ${at}` },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
    }
    const raw = (await res.json()) as Record<string, unknown>[];
    return raw.map((r) => ({
      title: String(r["name"] ?? r["title"] ?? r["state"] ?? `${service} item`),
      state: r["state"] ? String(r["state"]) : undefined,
      at: r["pushedAt"] ? String(r["pushedAt"]) : r["createdAt"] ? String(r["createdAt"]) : r["lastEdited"] ? String(r["lastEdited"]) : r["start"] ? String(r["start"]) : undefined,
    }));
  },
};

export {};
