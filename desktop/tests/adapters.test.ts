import { describe, expect, it } from "vitest";
import { normalizeEvent, normalizeFields, refineEvent } from "../src/main/adapters";

describe("normalizeEvent", () => {
  it("maps Gemini CLI events", () => {
    expect(normalizeEvent("BeforeTool")).toBe("PreToolUse");
    expect(normalizeEvent("AfterTool")).toBe("PostToolUse");
    expect(normalizeEvent("BeforeAgent")).toBe("UserPromptSubmit");
    expect(normalizeEvent("AfterAgent")).toBe("Stop");
    expect(normalizeEvent("startup")).toBe("SessionStart");
    expect(normalizeEvent("exit")).toBe("SessionEnd");
  });

  it("maps Antigravity events", () => {
    expect(normalizeEvent("PreInvocation")).toBe("UserPromptSubmit");
    // PostInvocation is the model finishing its turn, not a tool completing.
    expect(normalizeEvent("PostInvocation")).toBe("Stop");
  });

  it("maps Copilot CLI camelCase events", () => {
    expect(normalizeEvent("sessionStart")).toBe("SessionStart");
    expect(normalizeEvent("userPromptSubmitted")).toBe("UserPromptSubmit");
    expect(normalizeEvent("preToolUse")).toBe("PreToolUse");
    expect(normalizeEvent("postToolUse")).toBe("PostToolUse");
    expect(normalizeEvent("agentStop")).toBe("Stop");
    expect(normalizeEvent("permissionRequest")).toBe("PermissionRequest");
    expect(normalizeEvent("notification")).toBe("Notification");
    expect(normalizeEvent("sessionEnd")).toBe("SessionEnd");
  });

  it("maps Cursor camelCase events and lets canonical names pass", () => {
    expect(normalizeEvent("beforeSubmitPrompt")).toBe("UserPromptSubmit");
    expect(normalizeEvent("postToolUseFailure")).toBe("PostToolUseFailure");
    expect(normalizeEvent("subagentStart")).toBe("SubagentStart");
    expect(normalizeEvent("SessionStart")).toBe("SessionStart");
    expect(normalizeEvent("PermissionRequest")).toBe("PermissionRequest");
  });
});

describe("normalizeFields", () => {
  it("reads Copilot's toolName and JSON toolArgs text", () => {
    const map: Record<string, unknown> = {
      toolName: "Bash",
      toolArgs: JSON.stringify({ command: "rm -rf /" }),
    };
    normalizeFields(map, () => undefined);
    expect(map["tool_name"]).toBe("Bash");
    expect(map["tool_input"]).toEqual({ command: "rm -rf /" });
  });

  it("reads Copilot's toolArgs object as-is", () => {
    const map: Record<string, unknown> = { toolName: "Write", toolArgs: { file_path: "C:\\x" } };
    normalizeFields(map, () => undefined);
    expect(map["tool_input"]).toEqual({ file_path: "C:\\x" });
  });

  it("reads Gemini's toolCall and aliases Antigravity PascalCase args", () => {
    const map: Record<string, unknown> = {
      toolCall: { name: "run_terminal_command", args: { CommandLine: "dir", FilePath: "C:\\x" } },
    };
    normalizeFields(map, () => undefined);
    expect(map["tool_name"]).toBe("run_terminal_command");
    expect(map["tool_input"]).toEqual({ CommandLine: "dir", command: "dir", FilePath: "C:\\x", file_path: "C:\\x" });
  });

  it("never overwrites the fields Claude Code already carries", () => {
    const map: Record<string, unknown> = {
      tool_name: "Bash",
      tool_input: { command: "ls" },
      session_id: "s1",
      cwd: "E:\\Projects",
    };
    normalizeFields(map, () => undefined);
    expect(map["tool_name"]).toBe("Bash");
    expect(map["tool_input"]).toEqual({ command: "ls" });
    expect(map["session_id"]).toBe("s1");
    expect(map["cwd"]).toBe("E:\\Projects");
  });

  it("takes session id from the conversation, env included", () => {
    const a: Record<string, unknown> = { conversationId: "conv-1" };
    normalizeFields(a, () => undefined);
    expect(a["session_id"]).toBe("conv-1");
    const b: Record<string, unknown> = {};
    normalizeFields(b, (k) => (k === "GEMINI_SESSION_ID" ? "gem-9" : undefined));
    expect(b["session_id"]).toBe("gem-9");
  });

  it("takes cwd from workdir, workspacePaths and Cursor's workspace_roots", () => {
    const a: Record<string, unknown> = { workdir: "E:\\w" };
    normalizeFields(a, () => undefined);
    expect(a["cwd"]).toBe("E:\\w");
    const b: Record<string, unknown> = { workspacePaths: ["E:\\g", "x"] };
    normalizeFields(b, () => undefined);
    expect(b["cwd"]).toBe("E:\\g");
    const c: Record<string, unknown> = { workspace_roots: ["E:\\c"] };
    normalizeFields(c, () => undefined);
    expect(c["cwd"]).toBe("E:\\c");
  });
});

describe("refineEvent", () => {
  it("turns an errored stop into StopFailure", () => {
    expect(refineEvent("Stop", { status: "error" })).toBe("StopFailure");
    expect(refineEvent("Stop", {})).toBe("Stop");
    expect(refineEvent("PreToolUse", { status: "error" })).toBe("PreToolUse");
  });
});
