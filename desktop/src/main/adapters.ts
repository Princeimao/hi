// Port of mu/windows/hook/src/normalize.rs — every agent's hook payload is
// mapped onto the canonical event names and fields Claude Code uses, so one
// session handler serves them all. Unknown names pass through.

type MapValue = Record<string, unknown>;

/// The canonical name of an agent's event.
export function normalizeEvent(name: string): string {
  switch (name) {
    // Gemini CLI
    case "BeforeTool":
    case "BeforeToolSelection":
      return "PreToolUse";
    case "AfterTool":
    case "AfterModel":
      return "PostToolUse";
    case "BeforeAgent":
      return "UserPromptSubmit";
    case "AfterAgent":
      return "Stop";
    case "startup":
      return "SessionStart";
    case "exit":
      return "SessionEnd";
    // Antigravity. PreInvocation = the model is about to be invoked with the
    // user's prompt; PostInvocation = that invocation finished (the turn is
    // over). Neither is a tool call — PostInvocation must NOT be PostToolUse.
    case "PreInvocation":
      return "UserPromptSubmit";
    case "PostInvocation":
      return "Stop";
    // snake_case relays
    case "pre_tool_use":
      return "PreToolUse";
    case "post_tool_use":
      return "PostToolUse";
    case "user_prompt_submit":
      return "UserPromptSubmit";
    case "session_start":
      return "SessionStart";
    case "session_end":
      return "SessionEnd";
    case "stop":
      return "Stop";
    // Copilot CLI (camelCase) — Cursor shares most of these
    case "sessionStart":
      return "SessionStart";
    case "userPromptSubmitted":
      return "UserPromptSubmit";
    case "agentStop":
      return "Stop";
    case "notification":
      return "Notification";
    case "preToolUse":
      return "PreToolUse";
    case "postToolUse":
      return "PostToolUse";
    case "permissionRequest":
      return "PermissionRequest";
    case "sessionEnd":
      return "SessionEnd";
    // Cursor
    case "beforeSubmitPrompt":
      return "UserPromptSubmit";
    case "postToolUseFailure":
      return "PostToolUseFailure";
    case "subagentStart":
      return "SubagentStart";
    case "subagentStop":
      return "SubagentStop";
    default:
      return name;
  }
}

/// Keys of Antigravity's `toolCall.args` read under another name.
const ARG_ALIASES: [string, string][] = [
  ["CommandLine", "command"],
  ["FilePath", "file_path"],
  ["Path", "path"],
  ["Url", "url"],
  ["Query", "query"],
  ["Pattern", "pattern"],
];

function nonEmptyStr(map: MapValue, key: string): string | undefined {
  const v = map[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/// Fills `tool_name`, `tool_input`, `session_id` and `cwd` from wherever the
/// agent put them. A field the payload already has is never overwritten. `env`
/// resolves an environment variable (a parameter so tests stay pure).
export function normalizeFields(
  map: MapValue,
  env: (name: string) => string | undefined,
): void {
  const toolCall = asObject(map["toolCall"]);

  if (!("tool_name" in map)) {
    // Copilot: toolName. Gemini CLI / Antigravity: toolCall.name. Others: tool.
    const name = nonEmptyStr(map, "toolName") ?? (toolCall ? nonEmptyStr(toolCall, "name") : undefined) ?? nonEmptyStr(map, "tool");
    if (name !== undefined) map["tool_name"] = name;
  }

  if (!("tool_input" in map)) {
    // Copilot sends toolArgs as an object, or as the JSON text of one.
    const rawArgs = map["toolArgs"];
    let args: Record<string, unknown> | null = null;
    if (typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)) {
      args = { ...(rawArgs as Record<string, unknown>) };
    } else if (typeof rawArgs === "string") {
      try {
        const parsed: unknown = JSON.parse(rawArgs);
        args = asObject(parsed);
      } catch {
        args = null;
      }
    }
    const input =
      args ??
      (toolCall && asObject(toolCall["args"])
        ? (() => {
            const flat = { ...(asObject(toolCall["args"]) as Record<string, unknown>) };
            for (const [from, to] of ARG_ALIASES) {
              if (from in flat) flat[to] = flat[from];
            }
            return flat;
          })()
        : null);
    if (input) map["tool_input"] = input;
  }

  if (!nonEmptyStr(map, "session_id")) {
    const sid =
      ["conversationId", "conversation_id", "sessionId", "GEMINI_SESSION_ID"]
        .map((k) => nonEmptyStr(map, k))
        .find((s) => s !== undefined) ?? env("GEMINI_SESSION_ID");
    if (sid) map["session_id"] = sid;
  }

  if (!nonEmptyStr(map, "cwd")) {
    // Copilot: workdir. Gemini CLI / Antigravity: workspacePaths. Cursor: workspace_roots.
    let cwd = nonEmptyStr(map, "workdir");
    if (cwd === undefined) {
      for (const key of ["workspacePaths", "workspace_roots"]) {
        const v = map[key];
        if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string" && v[0].length > 0) {
          cwd = v[0];
          break;
        }
      }
    }
    if (cwd !== undefined) map["cwd"] = cwd;
  }
}

/// The event once the payload is known: a stop that reports an error
/// (Cursor's `status: "error"`) is a StopFailure.
export function refineEvent(event: string, map: MapValue): string {
  if (event === "Stop" && map["status"] === "error") return "StopFailure";
  return event;
}
