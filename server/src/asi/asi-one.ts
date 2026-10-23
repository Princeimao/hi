/**
 * ASI:ONE client — the verified OpenAI-compatible API from ASI:One by Fetch.ai.
 *
 * Docs: https://docs.asi1.ai (endpoint `https://api.asi1.ai/v1`, header
 * `Authorization: Bearer $ASI_ONE_API_KEY`, models: asi1, asi1-ultra, asi1-mini).
 *
 * The key lives CI-side in `server/.env` (ASI_ONE_API_KEY); without it every
 * call surfaces a typed `NotConfiguredError` instead of silently faking an
 * answer.
 */
import { config } from "../config.js";

export class NotConfiguredError extends Error {
  code = "asi_not_configured";
  constructor() {
    super(
      "ASI:ONE is not configured: set ASI_ONE_API_KEY in server/.env (get a key at https://asi1.ai/dashboard/api-keys).",
    );
  }
}

export class AsiApiError extends Error {
  code = "asi_api_error";
  status: number;
  constructor(status: number, message: string) {
    super(`ASI:ONE request failed (${status}): ${message}`);
    this.status = status;
  }
}

export interface AsiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface AsiChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Live web search on /v1/chat/completions (docs: Web Search). */
  webSearch?: boolean;
  signals?: AbortSignal;
}

export interface AsiChatResult {
  content: string;
  reasoning: string | null;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const baseUrl = () => config.asi.baseUrl.replace(/\/$/, "");

function headers(): Record<string, string> {
  if (!config.asi.apiKey) throw new NotConfiguredError();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.asi.apiKey}`,
  };
}

/** Non-streaming completion. */
export async function asiChat(
  messages: AsiMessage[],
  options: AsiChatOptions = {},
): Promise<AsiChatResult> {
  const body: Record<string, unknown> = {
    model: options.model ?? config.asi.model,
    messages,
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options.webSearch) body.web_search_options = { search_context_size: "medium" };

  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: options.signals,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AsiApiError(res.status, detail.slice(0, 400) || res.statusText);
  }
  type ChatCompletion = {
    model: string;
    choices: { message: { content: string; reasoning_content?: string | null } }[];
    usage?: AsiChatResult["usage"];
  };
  const json = (await res.json()) as ChatCompletion;
  const choice = json.choices?.[0];
  if (!choice) throw new AsiApiError(res.status, "empty choices");
  return {
    content: choice.message.content ?? "",
    reasoning: choice.message.reasoning_content ?? null,
    model: json.model,
    usage: json.usage,
  };
}

export type ChatStreamEvent =
  | { type: "delta"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "done"; full: string; model: string };

/**
 * Streaming completion via SSE (verified format: lines `data: {...}` ending
 * with `data: [DONE]`, deltas in `choices[0].delta.content`).
 */
export async function* asiChatStream(
  messages: AsiMessage[],
  options: AsiChatOptions = {},
): AsyncGenerator<ChatStreamEvent> {
  const body: Record<string, unknown> = {
    model: options.model ?? config.asi.model,
    messages,
    stream: true,
  };
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options.webSearch) body.web_search_options = { search_context_size: "medium" };

  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: options.signals,
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new AsiApiError(res.status, detail.slice(0, 400) || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let model = options.model ?? config.asi.model;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const rawLine = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);
      if (!rawLine.startsWith("data:")) continue;
      const data = rawLine.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      const chunk = event as {
        model?: string;
        choices?: { delta?: { content?: string | null; reasoning_content?: string | null } }[];
      };
      if (chunk.model) model = chunk.model;
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) yield { type: "reasoning", delta: delta.reasoning_content };
      if (delta?.content) {
        full += delta.content;
        yield { type: "delta", delta: delta.content };
      }
    }
  }
  yield { type: "done", full, model };
}

/**
 * Structured JSON output via `response_format` (verified on both endpoints).
 * The model must respond with pure JSON; we sanitize fencing defensively.
 */
export async function asiJson<T>(
  messages: AsiMessage[],
  options: { model?: string; temperature?: number } = {},
): Promise<T> {
  const body: Record<string, unknown> = {
    model: options.model ?? config.asi.miniModel,
    messages,
    response_format: { type: "json_object" },
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;

  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AsiApiError(res.status, detail.slice(0, 400) || res.statusText);
  }
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  const raw = json.choices?.[0]?.message?.content ?? "{}";
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new AsiApiError(200, `invalid JSON payload: ${cleaned.slice(0, 200)}`);
  }
}
