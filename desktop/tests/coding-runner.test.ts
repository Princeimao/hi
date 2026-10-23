import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CodingRunner,
  commandFor,
  parseAgentLine,
  parseAntigravityEvent,
  parseClaudeEvent,
  parseOpencodeEvent,
  resolveCommand,
  resolveWorkspace,
} from "../src/main/coding-runner";

const temp = mkdtempSync(path.join(os.tmpdir(), "hi-coding-"));
const root = path.join(temp, "root");
const inside = path.join(root, "project");
const outside = path.join(temp, "elsewhere");
mkdirSync(inside, { recursive: true });
mkdirSync(outside, { recursive: true });

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe("parseClaudeEvent", () => {
  it("reads the session id from the system banner", () => {
    expect(parseClaudeEvent({ type: "system", subtype: "init", session_id: "s-1" }).sessionId).toBe("s-1");
  });

  it("extracts assistant text and tool steps", () => {
    const parsed = parseClaudeEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Editing the file" },
          { type: "tool_use", name: "Edit", input: { file_path: "C:\\repo\\a.ts" } },
        ],
      },
    });
    expect(parsed.text).toBe("Editing the file");
    expect(parsed.steps?.[0]).toContain("Uses Edit");
    expect(parsed.steps?.[0]).toContain("a.ts");
  });

  it("turns an is_error result into an error", () => {
    const parsed = parseClaudeEvent({ type: "result", is_error: true, result: "rate limited" });
    expect(parsed.error).toBe("rate limited");
    expect(parsed.done).toBe(true);
  });
});

describe("parseOpencodeEvent", () => {
  it("reads text parts", () => {
    expect(parseOpencodeEvent({ type: "text", part: { type: "text", text: "hello" } }).text).toBe("hello");
  });

  it("reads tool parts as steps", () => {
    const parsed = parseOpencodeEvent({
      part: { type: "tool", tool: { name: "bash", input: { command: "npm test" } } },
    });
    expect(parsed.steps?.[0]).toContain("bash");
    expect(parsed.steps?.[0]).toContain("npm test");
  });

  it("reads errors", () => {
    expect(parseOpencodeEvent({ type: "error", error: { message: "boom" } }).error).toBe("boom");
  });
});

describe("parseAntigravityEvent", () => {
  it("reads delta messages", () => {
    const parsed = parseAntigravityEvent({ type: "message", role: "assistant", content: "working", delta: true });
    expect(parsed.text).toBe("working");
  });

  it("reads tool calls and the final result", () => {
    const tool = parseAntigravityEvent({ type: "tool_use", tool_name: "read_file", args: { path: "/x/y.ts" } });
    expect(tool.steps?.[0]).toContain("read_file");
    expect(parseAntigravityEvent({ type: "result", status: "success" }).done).toBe(true);
  });
});

describe("parseAgentLine", () => {
  it("keeps non-JSON lines as live output", () => {
    expect(parseAgentLine("claude", "building...").text).toBe("building...");
  });

  it("keeps malformed JSON visible instead of dropping it", () => {
    expect(parseAgentLine("opencode", '{"type":').text).toBe('{"type":');
  });
});

describe("resolveWorkspace", () => {
  it("accepts a directory inside a root", () => {
    const result = resolveWorkspace(inside, [root]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(path.resolve(result.cwd)).toBe(path.resolve(inside));
  });

  it("refuses a directory outside the roots", () => {
    const result = resolveWorkspace(outside, [root]);
    expect(result.ok).toBe(false);
  });

  it("refuses a path that does not exist", () => {
    expect(resolveWorkspace(path.join(root, "nope"), [root]).ok).toBe(false);
  });

  it("refuses a file", () => {
    const file = path.join(root, "file.txt");
    writeFileSync(file, "x");
    expect(resolveWorkspace(file, [root]).ok).toBe(false);
  });

  it("compares case-insensitively on Windows", () => {
    if (process.platform !== "win32") return;
    const upper = inside.replace(/[a-z]/g, (c) => c.toUpperCase());
    expect(resolveWorkspace(upper, [root], "win32").ok).toBe(true);
  });

  it("falls back to the first root when no cwd is given", () => {
    const result = resolveWorkspace(null, [root]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(path.resolve(result.cwd)).toBe(path.resolve(root));
  });
});

describe("commandFor", () => {
  it("streams Claude Code JSON and feeds the prompt on stdin", () => {
    const command = commandFor("claude", "do it");
    expect(command.file).toBe("claude");
    expect(command.stdinPrompt).toBe(true);
    expect(command.args).toContain("stream-json");
    expect(command.args).not.toContain("do it");
  });

  it("runs OpenCode with a JSON event stream", () => {
    const command = commandFor("opencode", "fix tests");
    expect(command.file).toBe("opencode");
    expect(command.args).toEqual(["run", "fix tests", "--format", "json"]);
  });

  it("runs Antigravity headlessly", () => {
    const command = commandFor("antigravity", "write docs");
    expect(command.file).toBe("agy");
    expect(command.args).toEqual(["-p", "write docs", "--output-format", "stream-json"]);
  });
});

describe("resolveCommand", () => {
  it("returns null when the binary is not on PATH", () => {
    expect(resolveCommand("definitely-not-a-real-cli-xyz", { PATH: temp }, "win32")).toBeNull();
  });

  it("finds a .cmd shim on Windows", () => {
    const shim = path.join(temp, "fake-cli.cmd");
    writeFileSync(shim, "@echo off\r\n");
    expect(resolveCommand("fake-cli", { PATH: temp }, "win32")).toBe(shim);
  });

  it("probe reports missing CLIs without throwing", () => {
    const runner = new CodingRunner(
      { onStep() {}, onOutput() {}, onHeartbeat() {}, onResult() {}, onError() {} },
      { env: { PATH: temp }, platform: "win32", roots: [root] },
    );
    const probes = runner.probe();
    expect(probes).toHaveLength(3);
    expect(probes.every((probe) => probe.available === false)).toBe(true);
  });

  it("refuses to start when the CLI is not installed", () => {
    const runner = new CodingRunner(
      { onStep() {}, onOutput() {}, onHeartbeat() {}, onResult() {}, onError() {} },
      { env: { PATH: temp }, platform: "win32", roots: [root] },
    );
    const outcome = runner.start({ taskId: "t1", prompt: "hi", agent: "claude", cwd: inside });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("not installed");
  });

  it("refuses a workspace outside the roots before spawning", () => {
    const runner = new CodingRunner(
      { onStep() {}, onOutput() {}, onHeartbeat() {}, onResult() {}, onError() {} },
      { env: { PATH: temp }, platform: "win32", roots: [root] },
    );
    const outcome = runner.start({ taskId: "t2", prompt: "hi", agent: "opencode", cwd: outside });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("outside HI_CODING_ROOTS");
  });
});
