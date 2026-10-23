/**
 * Service integrations — per-user tokens, verified against the real APIs at
 * connect time, stored encrypted at rest, and used by the agent network to do
 * actual work (list repos and PRs, deployments, pages, bookings).
 *
 * Every call needs the service token the user configured; without one callers
 * get the typed NotConfigured error rather than fake data.
 */
import { one, query } from "../db/pool.js";
import { bus } from "../ws/bus.js";
import { decryptToken, encryptToken, UnreadableTokenError } from "./crypto.js";

export type ServiceId = "github" | "vercel" | "notion" | "calcom" | "elevenlabs";

export interface IntegrationStatus {
  service: ServiceId;
  name: string;
  connected: boolean;
  account: string | null;
  updatedAt: string | null;
}

export class NotConfiguredError extends Error {
  code = "integration_not_configured";
  service: ServiceId;
  constructor(service: ServiceId) {
    super(`${service} is not connected — add its token first`);
    this.service = service;
  }
}

export class UpstreamError extends Error {
  code = "integration_upstream";
  status: number;
  constructor(service: string, context: string, status: number, detail: string) {
    super(`[${service}] ${context}: HTTP ${status}${detail ? ` — ${detail}` : ""}`);
    this.status = status;
  }
}

export const SERVICE_NAMES: Record<ServiceId, string> = {
  github: "GitHub",
  vercel: "Vercel",
  notion: "Notion",
  calcom: "Cal.com",
  elevenlabs: "ElevenLabs",
};

export function isService(value: string): value is ServiceId {
  return value === "github" || value === "vercel" || value === "notion" || value === "calcom" || value === "elevenlabs";
}

/// ── Upstream plumbing ─────────────────────────────────────────────────────────

type Method = "GET" | "POST";

const AUTH_HEADERS: Record<ServiceId, (token: string) => Record<string, string>> = {
  github: (token) => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  }),
  vercel: (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/json" }),
  notion: (token) => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  }),
  calcom: (token) => ({ "x-cal-secret-key": token, Accept: "application/json" }),
  elevenlabs: (token) => ({ "xi-api-key": token, Accept: "application/json" }),
};

async function call(
  token: string,
  service: ServiceId,
  method: Method,
  url: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return fetch(url, {
    method,
    headers: AUTH_HEADERS[service](token),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

interface VerifyResult {
  account: string;
  meta?: Record<string, unknown>;
}

async function verifyGithub(token: string): Promise<VerifyResult> {
  const res = await call(token, "github", "GET", "https://api.github.com/user");
  if (!res.ok) return fail(res, "github", "account check");
  const u = (await res.json()) as { login?: string; name?: string };
  return { account: u.name || u.login || "account", meta: { login: u.login ?? null } };
}

async function verifyVercel(token: string): Promise<VerifyResult> {
  const res = await call(token, "vercel", "GET", "https://api.vercel.com/v2/user");
  if (!res.ok) return fail(res, "vercel", "account check");
  const u = (await res.json()) as Record<string, unknown>;
  const name = (u["username"] ?? u["name"] ?? "account") as string;
  return { account: name, meta: { uid: u["id"] ?? null } };
}

async function verifyNotion(token: string): Promise<VerifyResult> {
  const res = await call(token, "notion", "GET", "https://api.notion.com/v1/users/me");
  if (!res.ok) return fail(res, "notion", "account check");
  const u = (await res.json()) as { name?: string; type?: string };
  return {
    account: u.name ?? "Notion integration",
    meta: { type: u.type ?? null },
  };
}

async function verifyCalcom(token: string): Promise<VerifyResult> {
  const res = await call(token, "calcom", "GET", "https://api.cal.com/v2/me");
  if (!res.ok) return fail(res, "calcom", "account check");
  const u = (await res.json()) as { data?: { user?: { username?: string; email?: string } } };
  const user = u.data?.user;
  return {
    account: user?.username ?? user?.email ?? "cal.com account",
    meta: { email: user?.email ?? null },
  };
}

async function verifyElevenlabs(token: string): Promise<VerifyResult> {
  const res = await call(token, "elevenlabs", "GET", "https://api.elevenlabs.io/v1/user");
  if (!res.ok) return fail(res, "elevenlabs", "account check");
  const u = (await res.json()) as {
    xi_api_user_id?: string;
    first_name?: string;
    subscription?: { tier?: string; character_count?: number; character_limit?: number };
  };
  return {
    account: u.xi_api_user_id ?? u.first_name ?? "ElevenLabs account",
    meta: {
      tier: u.subscription?.tier ?? null,
      charactersRemaining: Math.max(0, (u.subscription?.character_limit ?? 0) - (u.subscription?.character_count ?? 0)),
    },
  };
}

const VERIFY: Record<ServiceId, (token: string) => Promise<VerifyResult>> = {
  github: verifyGithub,
  vercel: verifyVercel,
  notion: verifyNotion,
  calcom: verifyCalcom,
  elevenlabs: verifyElevenlabs,
};

async function fail(res: Response, service: ServiceId, context: string): Promise<never> {
  const detail = (await res.text().catch(() => "")).slice(0, 200);
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamError(SERVICE_NAMES[service], `${context} rejected the token`, res.status, detail);
  }
  throw new UpstreamError(SERVICE_NAMES[service], context, res.status, detail);
}

/// ── Stored tokens ─────────────────────────────────────────────────────────────

export async function listIntegrations(userId: string): Promise<IntegrationStatus[]> {
  const rows = await query<{ service: string; meta: Record<string, unknown>; updated_at: string }>(
    `SELECT service, meta, updated_at FROM integration_tokens WHERE user_id = $1`,
    [userId],
  );
  const byService = new Map(rows.map((r) => [r.service, r]));
  return (Object.keys(SERVICE_NAMES) as ServiceId[]).map((service) => {
    const row = byService.get(service);
    return {
      service,
      name: SERVICE_NAMES[service],
      connected: row !== undefined,
      account: row ? (String(row.meta["account"] ?? "") || null) : null,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

export async function connect(userId: string, service: string, token: string): Promise<IntegrationStatus> {
  if (!isService(service)) throw new Error(`unknown integration service: ${service}`);
  const verified = await VERIFY[service](token);
  const meta = { account: verified.account, ...(verified.meta ?? {}) };
  await query(
    `INSERT INTO integration_tokens (user_id, service, token, meta, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (user_id, service)
     DO UPDATE SET token = $3, meta = $4::jsonb, updated_at = now()`,
    [userId, service, encryptToken(token), JSON.stringify(meta)],
  );
  await bus.emit(userId, { type: "integration.connected", service, account: verified.account });
  return { service, name: SERVICE_NAMES[service], connected: true, account: verified.account, updatedAt: new Date().toISOString() };
}

export async function disconnect(userId: string, service: string): Promise<boolean> {
  if (!isService(service)) return false;
  const deleted = await query(`DELETE FROM integration_tokens WHERE user_id = $1 AND service = $2`, [userId, service]);
  await bus.emit(userId, { type: "integration.disconnected", service });
  return deleted.length > 0;
}

export async function confirmedToken(userId: string, service: ServiceId): Promise<string | undefined> {
  const row = await one<{ token: string }>(
    `SELECT token FROM integration_tokens WHERE user_id = $1 AND service = $2`,
    [userId, service],
  );
  if (!row) return undefined;
  try {
    return decryptToken(row.token);
  } catch (err) {
    if (err instanceof UnreadableTokenError) {
      await disconnect(userId, service);
      return undefined;
    }
    throw err;
  }
}

async function needToken(userId: string, service: ServiceId): Promise<string> {
  const token = await confirmedToken(userId, service);
  if (!token) throw new NotConfiguredError(service);
  return token;
}

/// ── Real data calls (agent tools) ────────────────────────────────────────────

export async function githubRepos(userId: string, limit = 20): Promise<unknown[]> {
  const token = await needToken(userId, "github");
  const res = await call(token, "github", "GET", `https://api.github.com/user/repos?sort=pushed&per_page=${limit}`);
  if (!res.ok) return fail(res, "github", "repos list");
  const repos = (await res.json()) as {
    full_name: string;
    private: boolean;
    pushed_at: string;
    description?: string;
    language?: string | null;
    stargazers_count?: number;
    html_url?: string;
    default_branch?: string;
  }[];
  return repos.map((r) => ({
    name: r.full_name,
    fullName: r.full_name,
    private: r.private,
    pushedAt: r.pushed_at,
    description: r.description ?? "",
    language: r.language ?? null,
    stars: r.stargazers_count ?? 0,
    url: r.html_url ?? `https://github.com/${r.full_name}`,
    defaultBranch: r.default_branch ?? "main",
  }));
}

export async function githubPulls(userId: string, repo: string, limit = 20): Promise<unknown[]> {
  const token = await needToken(userId, "github");
  const res = await call(
    token,
    "github",
    "GET",
    `https://api.github.com/repos/${encodeURIComponent(repo)}/pulls?state=open&per_page=${limit}`,
  );
  if (!res.ok) return fail(res, "github", "pull requests");
  const pulls = (await res.json()) as {
    number: number;
    title: string;
    draft: boolean;
    user?: { login: string } | null;
    created_at: string;
    html_url?: string;
  }[];
  return pulls.map((p) => ({
    number: p.number,
    title: p.title,
    author: p.user?.login ?? null,
    draft: p.draft,
    createdAt: p.created_at,
    url: p.html_url ?? null,
  }));
}

/** Directory listing of a repo path via the contents API. */
export async function githubContents(userId: string, repo: string, path = ""): Promise<unknown[]> {
  const token = await needToken(userId, "github");
  const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const res = await call(token, "github", "GET", `https://api.github.com/repos/${repo}/contents/${encoded}`);
  if (!res.ok) return fail(res, "github", `contents of ${path || "/"}`);
  const body = (await res.json()) as
    | { name: string; path: string; type: string; size?: number }[]
    | { name: string; path: string; type: string; size?: number };
  const entries = Array.isArray(body) ? body : [body];
  return entries.map((f) => ({
    name: f.name,
    path: f.path,
    type: f.type === "dir" ? "dir" : "file",
    size: f.size ?? 0,
  }));
}

/** Text content of one repo file, decoded from base64. Large binaries are refused. */
export async function githubFile(
  userId: string,
  repo: string,
  path: string,
): Promise<{ name: string; path: string; size: number; text?: string; tooLarge?: boolean }> {
  const token = await needToken(userId, "github");
  const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const res = await call(token, "github", "GET", `https://api.github.com/repos/${repo}/contents/${encoded}`);
  if (!res.ok) return fail(res, "github", `file ${path}`);
  const body = (await res.json()) as {
    name: string;
    path: string;
    size: number;
    content?: string;
    encoding?: string;
  };
  const size = body.size ?? 0;
  if (size > 400_000 || (!body.content && size > 0)) {
    return { name: body.name, path: body.path, size, tooLarge: true };
  }
  const text = body.encoding === "base64" ? Buffer.from(body.content ?? "", "base64").toString("utf8") : (body.content ?? "");
  return { name: body.name, path: body.path, size, text: text.slice(0, 200_000) };
}

export async function githubIssues(userId: string, repo: string, limit = 20): Promise<unknown[]> {
  const token = await needToken(userId, "github");
  const res = await call(
    token,
    "github",
    "GET",
    `https://api.github.com/repos/${encodeURIComponent(repo)}/issues?state=open&per_page=${limit}`,
  );
  if (!res.ok) return fail(res, "github", "issues");
  const issues = (await res.json()) as {
    number: number;
    title: string;
    user?: { login: string } | null;
    created_at: string;
    html_url?: string;
    pull_request?: unknown;
  }[];
  return issues
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      author: i.user?.login ?? null,
      createdAt: i.created_at,
      url: i.html_url ?? null,
    }));
}

export async function githubCommits(userId: string, repo: string, limit = 20): Promise<unknown[]> {
  const token = await needToken(userId, "github");
  const res = await call(
    token,
    "github",
    "GET",
    `https://api.github.com/repos/${encodeURIComponent(repo)}/commits?per_page=${limit}`,
  );
  if (!res.ok) return fail(res, "github", "commits");
  const commits = (await res.json()) as {
    sha: string;
    commit: { message: string; author?: { name?: string; date?: string } | null };
    html_url?: string;
  }[];
  return commits.map((c) => ({
    sha: c.sha.slice(0, 7),
    message: (c.commit.message ?? "").split("\n")[0],
    author: c.commit.author?.name ?? null,
    date: c.commit.author?.date ?? null,
    url: c.html_url ?? null,
  }));
}

export async function vercelDeployments(userId: string, limit = 20): Promise<unknown[]> {
  const token = await needToken(userId, "vercel");
  const res = await call(token, "vercel", "GET", `https://api.vercel.com/v6/deployments?limit=${limit}`);
  if (!res.ok) return fail(res, "vercel", "deployments");
  const body = (await res.json()) as {
    deployments?: {
      uid: string;
      name: string;
      state: string;
      created?: number;
      url?: string;
      environment?: string;
      meta?: Record<string, string>;
    }[];
  };
  return (body.deployments ?? []).map((d) => ({
    id: d.uid,
    project: d.name,
    state: d.state,
    createdAt: d.created ? new Date(d.created * 1000).toISOString() : null,
    url: d.url ? `https://${d.url}` : null,
    environment: d.environment ?? null,
    framework: d.meta?.framework ?? null,
  }));
}

export async function vercelProjects(userId: string, limit = 20): Promise<unknown[]> {
  const token = await needToken(userId, "vercel");
  const res = await call(token, "vercel", "GET", `https://api.vercel.com/v9/projects?limit=${limit}`);
  if (!res.ok) return fail(res, "vercel", "projects");
  const body = (await res.json()) as {
    projects?: {
      id: string;
      name: string;
      framework?: string | null;
      updatedAt?: number;
      latestDeployment?: { state?: string; created?: number; url?: string } | null;
    }[];
  };
  return (body.projects ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    framework: p.framework ?? null,
    updatedAt: p.updatedAt ? new Date(p.updatedAt * 1000).toISOString() : null,
    state: p.latestDeployment?.state ?? null,
    lastDeployed: p.latestDeployment?.created ? new Date(p.latestDeployment.created * 1000).toISOString() : null,
    url: p.latestDeployment?.url ? `https://${p.latestDeployment.url}` : null,
  }));
}

function notionPlain(rich: { plain_text?: string }[] | undefined): string {
  return (rich ?? []).map((r) => r.plain_text ?? "").join("");
}

function notionTitleOf(result: Record<string, unknown>): string {
  const props = (result["properties"] ?? {}) as Record<string, { title?: { plain_text?: string }[] }>;
  for (const value of Object.values(props)) {
    if (Array.isArray(value?.title) && value.title.length) return notionPlain(value.title);
  }
  if (Array.isArray(result["title"])) return notionPlain(result["title"] as { plain_text?: string }[]);
  const child = result["child_page"] as { title?: string } | undefined;
  if (child?.title) return child.title;
  return "Untitled";
}

export async function notionSearch(userId: string, term: string, limit = 20): Promise<unknown[]> {
  const token = await needToken(userId, "notion");
  const res = await call(token, "notion", "POST", "https://api.notion.com/v1/search", {
    query: term,
    page_size: limit,
  });
  if (!res.ok) return fail(res, "notion", "search");
  const body = (await res.json()) as {
    results?: {
      id: string;
      object: string;
      url: string;
      last_edited_time: string;
      icon?: { emoji?: string; type?: string } | null;
    }[];
  };
  return (body.results ?? []).map((r) => ({
    id: r.id,
    title: notionTitleOf(r as unknown as Record<string, unknown>),
    icon: r.icon?.emoji ?? (r.object === "database" ? "🗂️" : "📄"),
    url: r.url,
    lastEdited: r.last_edited_time,
  }));
}

export interface NotionLine {
  type: "h1" | "h2" | "h3" | "p" | "ul" | "ol" | "todo" | "quote" | "code" | "callout" | "hr" | "page" | "media";
  text: string;
  checked?: boolean;
  lang?: string;
}

/** One page's content, flattened to readable lines (headings, lists, todos…). */
export async function notionPage(
  userId: string,
  pageId: string,
): Promise<{ id: string; title: string; url: string; lines: NotionLine[] }> {
  const token = await needToken(userId, "notion");
  const pageRes = await call(token, "notion", "GET", `https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`);
  if (!pageRes.ok) return fail(pageRes, "notion", "page fetch");
  const page = (await pageRes.json()) as Record<string, unknown>;
  const res = await call(
    token,
    "notion",
    "GET",
    `https://api.notion.com/v1/blocks/${encodeURIComponent(pageId)}/children?page_size=100`,
  );
  if (!res.ok) return fail(res, "notion", "page content");
  const body = (await res.json()) as { results?: Record<string, unknown>[] };
  const lines: NotionLine[] = [];
  for (const block of body.results ?? []) {
    const type = String(block["type"] ?? "");
    const b = (block[type] ?? {}) as Record<string, unknown> & {
      rich_text?: { plain_text?: string }[];
      checked?: boolean;
      language?: string;
      title?: string;
      name?: string;
    };
    const text = notionPlain(b.rich_text);
    switch (type) {
      case "heading_1":
        lines.push({ type: "h1", text });
        break;
      case "heading_2":
        lines.push({ type: "h2", text });
        break;
      case "heading_3":
        lines.push({ type: "h3", text });
        break;
      case "bulleted_list_item":
        lines.push({ type: "ul", text });
        break;
      case "numbered_list_item":
        lines.push({ type: "ol", text });
        break;
      case "to_do":
        lines.push({ type: "todo", text, checked: Boolean(b.checked) });
        break;
      case "toggle":
        lines.push({ type: "ul", text });
        break;
      case "quote":
        lines.push({ type: "quote", text });
        break;
      case "code":
        lines.push({ type: "code", text, lang: b.language ?? undefined });
        break;
      case "callout":
        lines.push({ type: "callout", text });
        break;
      case "divider":
        lines.push({ type: "hr", text: "" });
        break;
      case "child_page":
        lines.push({ type: "page", text: b.title ?? "Child page" });
        break;
      case "image":
      case "file":
      case "pdf":
      case "video":
        lines.push({ type: "media", text: b.name ?? type });
        break;
      case "paragraph":
        if (text.trim()) lines.push({ type: "p", text });
        break;
      default:
        if (text.trim()) lines.push({ type: "p", text });
        break;
    }
  }
  return { id: pageId, title: notionTitleOf(page), url: String(page["url"] ?? ""), lines };
}

export async function calBookings(userId: string, limit = 20): Promise<unknown[]> {
  const token = await needToken(userId, "calcom");
  const res = await call(token, "calcom", "GET", `https://api.cal.com/v2/bookings?status=upcoming&take=${limit}`);
  if (!res.ok) return fail(res, "calcom", "bookings");
  const body = (await res.json()) as {
    data?: {
      id: number;
      title: string;
      start: string;
      end?: string;
      status: string;
      description?: string;
      duration?: number;
      location?: string | null;
      attendees?: { name?: string; email?: string }[];
      hosts?: { name?: string; username?: string }[];
    }[];
  };
  return (body.data ?? []).map((b) => ({
    id: b.id,
    title: b.title,
    start: b.start,
    end: b.end ?? null,
    status: b.status,
    description: (b.description ?? "").slice(0, 160),
    duration: b.duration ?? null,
    location: b.location ?? null,
    attendees: (b.attendees ?? []).map((a) => a.name || a.email).filter(Boolean).slice(0, 4),
    hosts: (b.hosts ?? []).map((h) => h.name || h.username).filter(Boolean).slice(0, 3),
  }));
}

export async function elevenVoiceList(userId: string): Promise<unknown[]> {
  const token = await needToken(userId, "elevenlabs");
  const res = await call(token, "elevenlabs", "GET", "https://api.elevenlabs.io/v1/voices");
  if (!res.ok) return fail(res, "elevenlabs", "voices");
  const body = (await res.json()) as {
    voices?: {
      voice_id: string;
      name: string;
      labels?: Record<string, string>;
      category?: string;
      preview_url?: string;
    }[];
  };
  return (body.voices ?? []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    labels: v.labels ?? {},
    category: v.category ?? v.labels?.["category"] ?? null,
    previewUrl: v.preview_url ?? null,
  }));
}

export type TextToSpeechDetail =
  | { ok: false; error: "not_configured" | "upstream"; status: number; reason: string };

/** Streams ElevenLabs TTS audio for `text`. Returns the upstream response for
 *  the route to pipe through, or a typed refusal. */
export async function streamTextToSpeech(
  userId: string,
  text: string,
  voiceId = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",
  model = process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2",
): Promise<Response | TextToSpeechDetail> {
  const clean = text.trim().slice(0, 10_000);
  if (!clean) return { ok: false, error: "upstream", status: 400, reason: "text required" };
  let token: string | undefined;
  try {
    token = await confirmedToken(userId, "elevenlabs");
  } catch {
    token = undefined;
  }
  if (!token) return { ok: false, error: "not_configured", status: 409, reason: "elevenlabs is not connected — add its token first" };
  const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: { "xi-api-key": token, Accept: "audio/mpeg", "Content-Type": "application/json" },
    body: JSON.stringify({ text: clean, model_id: model }),
  });
  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => "")).slice(0, 200);
    return { ok: false, error: "upstream", status: upstream.status, reason: detail || `HTTP ${upstream.status}` };
  }
  return upstream;
}

export type SpeechToTextDetail =
  | { ok: false; error: "not_configured" | "upstream"; status: number; reason: string };

/** ElevenLabs Scribe speech-to-text: `audio`/`webm` blob in, transcript out.
 *  Native island voice input rides on the same encrypted server-side token. */
export async function transcribeSpeech(
  userId: string,
  audio: Buffer,
  mimeType: string,
): Promise<{ text: string } | SpeechToTextDetail> {
  if (!audio.length) return { ok: false, error: "upstream", status: 400, reason: "empty audio" };
  let token: string | undefined;
  try {
    token = await confirmedToken(userId, "elevenlabs");
  } catch {
    token = undefined;
  }
  if (!token) return { ok: false, error: "not_configured", status: 409, reason: "elevenlabs is not connected — add its token first" };
  const form = new FormData();
  const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("wav") ? "wav" : mimeType.includes("mp4") || mimeType.includes("aac") ? "m4a" : "webm";
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `speech.${ext}`);
  form.append("model_id", process.env.ELEVENLABS_STT_MODEL ?? "scribe_v1");
  const upstream = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": token },
    body: form,
  });
  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => "")).slice(0, 200);
    return { ok: false, error: "upstream", status: upstream.status, reason: detail || `HTTP ${upstream.status}` };
  }
  const body = (await upstream.json()) as { text?: string };
  return { text: String(body.text ?? "").trim() };
}
