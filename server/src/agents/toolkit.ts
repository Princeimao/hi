// The chat agent's hands: every connected integration (GitHub, Vercel, Cal.com,
// Notion) and every Agentverse friend is a callable tool. The router (ASI:ONE
// mini) picks at most one tool per request; friends are called through the
// same uAgents mailbox the Friends tab uses, so the "own agent" is the one
// doing the routing — shared conversation context, shared memory.
import { bus } from "../ws/bus.js";
import { hub } from "../ws/hub.js";
import { confirmedToken, type ServiceId } from "../integrations/service.js";
import * as friendsInt from "../integrations/friends.js";
import { asiJson, type AsiMessage } from "../asi/asi-one.js";

export interface ToolDescriptor {
  id: string;
  label: string;
  description: string;
}

export interface ToolResult {
  toolId: string;
  label: string;
  output: string;
  ok: boolean;
}

async function gh(token: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) throw new Error(`github HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
  return res.json();
}

/** Everything the user has wired up: integration tools + friend agents. */
export async function listAvailableTools(userId: string): Promise<ToolDescriptor[]> {
  const tools: ToolDescriptor[] = [];
  const services: ServiceId[] = ["github", "vercel", "calcom", "notion"];
  for (const svc of services) {
    const token = await confirmedToken(userId, svc).catch(() => undefined);
    if (!token) continue;
    if (svc === "github") {
      tools.push({ id: "github.list_repos", label: "GitHub: list my repos", description: "List the user's most recently updated repositories (name, description, stars)." });
      tools.push({ id: "github.list_pulls", label: "GitHub: open pull requests", description: "List open pull requests of a repo. Args: { repo: \"owner/name\" }." });
      tools.push({ id: "github.create_issue", label: "GitHub: create an issue", description: "Create an issue on a repo. Args: { repo: \"owner/name\", title: string, body?: string }." });
    }
    if (svc === "vercel") {
      tools.push({ id: "vercel.list_projects", label: "Vercel: list projects", description: "List the user's Vercel projects with framework and last updated date." });
    }
    if (svc === "calcom") {
      tools.push({ id: "calcom.list_bookings", label: "Cal.com: upcoming bookings", description: "List the user's upcoming bookings (time, title, status)." });
    }
    if (svc === "notion") {
      tools.push({ id: "notion.search", label: "Notion: search pages", description: "Search the user's Notion workspace. Args: { query: string }." });
    }
  }
  const friends = await friendsInt.listFriends(userId).catch(() => []);
  for (const f of friends) {
    const summary = String(f.readme ?? "").replace(/\s+/g, " ").slice(0, 180);
    tools.push({
      id: `friend:${f.id}`,
      label: `Agentverse: ${f.name}`,
      description: `Delegate to the connected Agentverse agent "${f.name}" over the uAgents network. Best for anything that agent is specialized in (flights, search, scheduling…). Summary: ${summary}`,
    });
  }
  tools.push({
    id: "local.exec",
    label: "Local: run a command on the user's PC",
    description:
      "Run a shell command on the user's actual computer (not the cloud) via the connected desktop island. " +
      "Args: { command: string, cwd?: string }. Use for reading files, listing directories, checking processes, " +
      "or anything that needs real local machine access. Returns stdout+stderr (truncated).",
  });
  tools.push({
    id: "pi.code",
    label: "Pi: write code on the user's PC",
    description:
      "Delegate a coding task to the Pi agent running on the user's actual machine (reads/writes real files). " +
      "Args: { task: string, cwd: string }. cwd is the folder to work in (must be confirmed with the user first " +
      "via a clarify card). Pi has its own model keys and can inspect, create and edit files. " +
      "Returns Pi's final summary of what it did.",
  });
  return tools;
}

/** Ask ASI:ONE mini which single tool (if any) fits this request. */
export async function pickTool(userId: string, text: string): Promise<{ id: string; args: Record<string, unknown> } | null> {
  const tools = await listAvailableTools(userId);
  if (!tools.length) return null;
  const catalog = tools.map((t) => `- ${t.id}: ${t.label} — ${t.description}`).join("\n");
  const messages: AsiMessage[] = [
    {
      role: "system",
      content:
        `You route ONE user request to at most one tool. Tools:\n${catalog}\n\n` +
        'Return JSON exactly like {"tool": "<id from the list>", "args": {…}} or {"tool": null, "args": {}} when no tool is needed. ' +
        "Chat, memory, timers and todos need no tool. If the user clearly wants real data (repos, PRs, bookings, pages) or a task for a connected agent, pick the matching tool.",
    },
    { role: "user", content: text.slice(0, 2000) },
  ];
  try {
    const parsed = await asiJson<{ tool?: string | null; args?: Record<string, unknown> }>(messages, { temperature: 0 });
    if (!parsed?.tool) return null;
    const match = tools.find((t) => t.id === parsed.tool);
    if (!match) return null;
    return { id: match.id, args: parsed.args ?? {} };
  } catch {
    return null;
  }
}

async function runIntegrationTool(userId: string, id: string, args: Record<string, unknown>): Promise<string> {
  const tokenOf = (svc: ServiceId) => confirmedToken(userId, svc).then((t) => {
    if (!t) throw new Error(`${svc} is not connected`);
    return t;
  });
  if (id === "github.list_repos") {
    const token = await tokenOf("github");
    const rows = (await gh(token, "/user/repos?per_page=10&sort=updated")) as { full_name: string; description: string | null; stargazers_count: number; html_url: string }[];
    return rows.map((r) => `${r.full_name} ★${r.stargazers_count} — ${r.description ?? ""} (${r.html_url})`).join("\n") || "no repos";
  }
  if (id === "github.list_pulls") {
    const token = await tokenOf("github");
    const repo = String(args.repo ?? "").trim();
    if (!repo) throw new Error('args.repo like "owner/name" is required');
    const rows = (await gh(token, `/repos/${repo}/pulls?state=open&per_page=10`)) as { number: number; title: string; html_url: string; user: { login: string } }[];
    return rows.map((p) => `#${p.number} ${p.title} — @${p.user.login} (${p.html_url})`).join("\n") || "no open PRs";
  }
  if (id === "github.create_issue") {
    const token = await tokenOf("github");
    const repo = String(args.repo ?? "").trim();
    const title = String(args.title ?? "").trim();
    if (!repo || !title) throw new Error("args.repo and args.title are required");
    const body = args.body ? String(args.body) : undefined;
    const row = (await gh(token, `/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, body }) })) as { number: number; html_url: string; title: string };
    return `Created issue #${row.number}: ${row.title} (${row.html_url})`;
  }
  if (id === "vercel.list_projects") {
    const token = await tokenOf("vercel");
    const res = await fetch("https://api.vercel.com/v9/projects?limit=10", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`vercel HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
    const body = (await res.json()) as { projects?: { name: string; framework: string | null; updatedAt?: number }[] };
    return (body.projects ?? [])
      .map((p) => `${p.name}${p.framework ? ` (${p.framework})` : ""}${p.updatedAt ? ` — updated ${new Date(p.updatedAt).toISOString().slice(0, 10)}` : ""}`)
      .join("\n") || "no projects";
  }
  if (id === "calcom.list_bookings") {
    const token = await tokenOf("calcom");
    const res = await fetch("https://api.cal.com/v2/bookings?limit=10&status=upcoming", {
      headers: { Authorization: `Bearer ${token}`, "Cal-API-Version": "2024-09-04" },
    });
    if (!res.ok) throw new Error(`cal.com HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
    const body = (await res.json()) as { data?: { start: string; title: string; status: string }[] };
    return (body.data ?? [])
      .map((b) => `${new Date(b.start).toLocaleString()} — ${b.title} [${b.status}]`)
      .join("\n") || "no upcoming bookings";
  }
  if (id === "notion.search") {
    const token = await tokenOf("notion");
    const res = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify({ query: String(args.query ?? "").slice(0, 200), page_size: 8 }),
    });
    if (!res.ok) throw new Error(`notion HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
    const body = (await res.json()) as { results?: { url: string; properties?: Record<string, { title?: { plain_text?: string }[] }> }[] };
    return (body.results ?? [])
      .map((r) => {
        const titleProp = Object.values(r.properties ?? {}).find((p) => p.title);
        const title = titleProp?.title?.map((t) => t.plain_text ?? "").join("") ?? "(untitled)";
        return `${title} (${r.url})`;
      })
      .join("\n") || "no pages matched";
  }
  throw new Error(`unknown tool ${id}`);
}

/** Run a command on the user's PC via the live desktop island (local.exec). */
export async function runLocalExec(userId: string, args: Record<string, unknown>): Promise<string> {
  const command = String(args.command ?? "").trim();
  if (!command) return "(local.exec needs a command)";
  const reply = await hub.callDesktop(
    userId,
    { type: "local.exec", command, cwd: args.cwd ? String(args.cwd) : undefined },
    20_000,
  );
  if (!reply) return "(the desktop island is not connected — the user must have Hi open on their PC)";
  if (reply.ok === false) return `(local exec failed: ${String(reply.error ?? "unknown")})`;
  const out = String(reply.output ?? "").trim();
  return out || "(command ran, no output)";
}

/** Delegate a coding task to the Pi agent on the user's PC (pi.code). */
async function runPiCode(userId: string, args: Record<string, unknown>): Promise<string> {
  const task = String(args.task ?? "").trim();
  const cwd = String(args.cwd ?? "").trim() || undefined;
  if (!task) return "(pi.code needs a task)";
  // Pi print mode: one-shot, final assistant text on stdout, exits when done.
  // --no-session keeps runs independent; quote the task for the shell.
  const quoted = task.replaceAll('"', '\\"');
  const command = `pi --print --no-session "${quoted}"`;
  const reply = await hub.callDesktop(
    userId,
    { type: "local.exec", command, cwd },
    115_000,
  );
  if (!reply) return "(the desktop island is not connected — the user must have Hi open on their PC)";
  if (reply.ok === false) return `(Pi failed: ${String(reply.error ?? "unknown")})`;
  const out = String(reply.output ?? "").trim();
  return out || "(Pi ran but produced no output)";
}

/** Send a message to a connected friend agent and wait for its reply. */
async function runFriendTool(userId: string, friendId: string, text: string): Promise<string> {
  const msg = await friendsInt.send(userId, friendId, text);
  return new Promise<string>((resolve) => {
    const timeout = setTimeout(() => {
      off();
      resolve("(the agent did not reply in time)");
    }, 25_000);
    const off = bus.on((rec) => {
      if (rec.userId !== userId) return;
      const ev = rec.event as { type?: string; messageId?: string; friendId?: string; text?: string; reason?: string };
      if (ev.type === "friend.reply" && ev.messageId === msg.id) {
        clearTimeout(timeout);
        off();
        resolve(String(ev.text ?? "(empty reply)"));
      }
      if (ev.type === "friend.error" && ev.messageId === msg.id) {
        clearTimeout(timeout);
        off();
        resolve(`(delivery failed: ${ev.reason ?? "unknown"})`);
      }
    });
  });
}

/** Executes one picked tool. Emits chat.tool so the island can show it. */
export async function executeTool(userId: string, pick: { id: string; args: Record<string, unknown> }): Promise<ToolResult> {
  const friends = await friendsInt.listFriends(userId).catch(() => [] as Awaited<ReturnType<typeof friendsInt.listFriends>>);
  const friend = pick.id.startsWith("friend:") ? friends.find((f) => f.id === pick.id.slice(7)) : null;
  const label = friend ? `Agentverse: ${friend.name}` : pick.id === "local.exec" ? "Local PC: run command" : pick.id === "pi.code" ? "Pi: writing code" : pick.id.replace(".", ": ");
  try {
    let output: string;
    if (pick.id === "local.exec") {
      output = await runLocalExec(userId, pick.args);
    } else if (pick.id === "pi.code") {
      output = await runPiCode(userId, pick.args);
    } else if (friend) {
      const ask = String(pick.args.text ?? pick.args.question ?? "").trim();
      output = await runFriendTool(userId, friend.id, ask);
    } else {
      output = await runIntegrationTool(userId, pick.id, pick.args);
    }
    const result: ToolResult = { toolId: pick.id, label, output: output.slice(0, 3500), ok: true };
    void bus.emit(userId, {
      type: "chat.tool.result",
      tool: result.toolId,
      label,
      ok: true,
      output: result.output,
    });
    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const result: ToolResult = { toolId: pick.id, label, output: `Tool failed: ${reason}`, ok: false };
    void bus.emit(userId, {
      type: "chat.tool.result",
      tool: result.toolId,
      label,
      ok: false,
      output: result.output,
      reason,
    });
    return result;
  }
}

/**
 * The full step: pick + execute for one chat request. Returns the context line
 * to hand the answering model, or null when no tool applies.
 */
export async function runForChat(userId: string, text: string): Promise<string | null> {
  const pick = await pickTool(userId, text);
  if (!pick) return null;
  // A bare tool call with no question attached still needs a task; for friend
  // routing the request itself is the payload.
  if (pick.id.startsWith("friend:") && !pick.args.text && !pick.args.question) pick.args.text = text;
  const result = await executeTool(userId, pick);
  return `Tool result [${result.label}]:\n${result.output}`;
}

// ── Multi-step orchestration ─────────────────────────────────────────────────
//
// The main agent can chain several tools in one request: ask the flight agent
// for flights, then the map agent for info about the destination, then offer a
// Cal.com / Notion follow-up. The router plans up to `MAX_STEPS` sequential
// tool calls; each step's input may reference the previous step's result via
// `{prev}`. All results are concatenated into one context line for the answer.

const MAX_STEPS = 3;

interface OrchestrationStep {
  id: string;
  args: Record<string, unknown>;
}

/**
 * Plan a sequence of tool calls for one request. Returns [] when no tool is
 * needed. Each step's `args.text` (for friend tools) may contain `{prev}` which
 * is replaced with the previous step's output at execution time.
 */
export async function planOrchestration(
  userId: string,
  text: string,
): Promise<OrchestrationStep[]> {
  const tools = await listAvailableTools(userId);
  if (!tools.length) return [];
  const catalog = tools.map((t) => `- ${t.id}: ${t.label} — ${t.description}`).join("\n");
  const messages: AsiMessage[] = [
    {
      role: "system",
      content:
        `You orchestrate up to ${MAX_STEPS} sequential tool calls to satisfy one user request.\n` +
        `Tools:\n${catalog}\n\n` +
        'Return JSON: {"steps": [{"tool": "<id>", "args": {...}}, ...]} with 0 to ' +
        `${MAX_STEPS} steps, in the order they must run. ` +
        "For friend agents, args.text is the message to send; use {prev} as a placeholder for the previous step's result. " +
        "For integration tools use their documented args. " +
        "Only include steps that clearly help; chat, memory, timers and todos need no tool. " +
        "If the user wants flights + destination info, chain them (flight agent first, then map/search agent). " +
        "Do not repeat the same tool twice unless the request clearly needs it.",
    },
    { role: "user", content: text.slice(0, 2000) },
  ];
  try {
    const parsed = await asiJson<{ steps?: { tool?: string; args?: Record<string, unknown> }[] }>(
      messages,
      { temperature: 0 },
    );
    const steps = (parsed?.steps ?? []).slice(0, MAX_STEPS);
    const out: OrchestrationStep[] = [];
    for (const s of steps) {
      if (!s?.tool) continue;
      const match = tools.find((t) => t.id === s.tool);
      if (!match) continue;
      out.push({ id: match.id, args: s.args ?? {} });
    }
    return out;
  } catch {
    return [];
  }
}

/** Execute a planned sequence, replacing {prev} placeholders, emitting chat.tool per step. */
export async function runOrchestration(
  userId: string,
  text: string,
): Promise<string | null> {
  const steps = await planOrchestration(userId, text);
  if (!steps.length) return null;
  const deadline = Date.now() + 40_000;
  let prev = "";
  const results: string[] = [];
  for (const step of steps) {
    if (Date.now() >= deadline) break;
    // Replace {prev} in any string arg with the previous step's output.
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step.args)) {
      args[k] = typeof v === "string" ? v.replaceAll("{prev}", prev.slice(0, 1500)) : v;
    }
    // Friend steps with no text fall back to the original request, then {prev}.
    if (step.id.startsWith("friend:") && !args.text && !args.question) {
      args.text = prev ? `Follow-up based on this result:\n${prev.slice(0, 1500)}` : text;
    }
    const result = await executeTool(userId, { id: step.id, args });
    prev = result.output;
    results.push(`[${result.label}]\n${result.output}`);
  }
  if (!results.length) return null;
  return `Tool results (ran ${results.length} step${results.length === 1 ? "" : "s"} in order):\n\n${results.join("\n\n")}`;
}
