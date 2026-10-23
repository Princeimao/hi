import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALL_AGENTS,
  agentFiles,
  agentInstalled,
  applyAgent,
  listAgents,
  previewAgent,
} from "../src/main/agent-installer";
import { settingsPath, status } from "../src/main/hook-installer";
import { hooksPresent } from "../src/main/hook-installer";

let home: string;
const newHome = (): void => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hi-agents-"));
  process.env["HI_TEST_HOME"] = home;
};
afterAll(() => {
  delete process.env["HI_TEST_HOME"];
  delete process.env["HI_TEST_HOOK_EXE"];
});

const readFirst = (id: Parameters<typeof agentFiles>[0]): string =>
  fs.readFileSync(agentFiles(id, home)[0], "utf8");

describe("other agents' installers", () => {
  it("every agent is listed with its file paths", () => {
    newHome();
    process.env["HI_TEST_HOOK_EXE"] = "C:\\fake\\electron.exe";
    const all = listAgents();
    expect(all.map((a) => a.id)).toEqual(ALL_AGENTS);
    for (const a of all) {
      expect(a.installed).toBe(false);
      expect(path.dirname(a.path.split("\n")[0])).toBeTruthy();
    }
  });

  it("Gemini's hooks land in ~/.gemini/settings.json and uninstall cleanly", () => {
    newHome();
    process.env["HI_TEST_HOOK_EXE"] = "C:\\fake\\electron.exe";
    const plan = previewAgent("gemini", home, true);
    applyAgent("gemini", home, true, plan.fingerprint);
    expect(agentInstalled("gemini", home)).toBe(true);
    const parsed = JSON.parse(readFirst("gemini")) as Record<string, unknown>;
    expect(hooksHaveGemini(parsed));
    const rm = previewAgent("gemini", home, false);
    applyAgent("gemini", home, false, rm.fingerprint);
    expect(agentInstalled("gemini", home)).toBe(false);
    expect(Object.keys(JSON.parse(readFirst("gemini")))).toEqual([]);

    function hooksHaveGemini(root: Record<string, unknown>): boolean {
      const hooks = root["hooks"] as Record<string, unknown[]>;
      return Array.isArray(hooks["BeforeTool"]) && hooks["BeforeTool"].length === 1;
    }
  });

  it("Codex's PermissionRequest carries the island's waiting message and 120 s", () => {
    newHome();
    process.env["HI_TEST_HOOK_EXE"] = "C:\\fake\\electron.exe";
    const plan = previewAgent("codex", home, true);
    applyAgent("codex", home, true, plan.fingerprint);
    const parsed = JSON.parse(readFirst("codex")) as {
      hooks: { PermissionRequest: { hooks: { command: string; timeout: number; statusMessage: string }[] }[] };
    };
    const entry = parsed.hooks["PermissionRequest"][0].hooks[0];
    expect(entry.timeout).toBe(120);
    expect(entry.statusMessage).toContain("island");
    expect(agentInstalled("codex", home)).toBe(true);
  });

  it("Copilot gets its own hooks file on every platform, bash + powershell fields", () => {
    newHome();
    process.env["HI_TEST_HOOK_EXE"] = "C:\\fake\\electron.exe";
    const plan = previewAgent("copilot", home, true);
    applyAgent("copilot", home, true, plan.fingerprint);
    expect(agentInstalled("copilot", home)).toBe(true);
    const parsed = JSON.parse(readFirst("copilot")) as {
      hooks: Record<string, { bash?: string; powershell?: string }[]>;
    };
    expect(Object.keys(parsed.hooks).length).toBeGreaterThanOrEqual(8);
    const perm = parsed.hooks["permissionRequest"][0];
    expect(perm.bash).toContain("hi-hook");
    if (process.platform === "win32") expect(perm.powershell).toContain("hi-hook");
    const rm = previewAgent("copilot", home, false);
    applyAgent("copilot", home, false, rm.fingerprint);
    expect(agentInstalled("copilot", home)).toBe(false);
  });

  it("Antigravity gets a named `hi` group, refused when the name is taken", () => {
    newHome();
    process.env["HI_TEST_HOOK_EXE"] = "C:\\fake\\electron.exe";
    const taken = path.join(home, ".gemini", "config", "hooks.json");
    fs.mkdirSync(path.dirname(taken), { recursive: true });
    fs.writeFileSync(taken, JSON.stringify({ hi: { PreToolUse: [] } }));
    expect(() => previewAgent("antigravity", home, true)).toThrow(/hook group named "hi"/);
    fs.writeFileSync(taken, "{}");
    const plan = previewAgent("antigravity", home, true);
    applyAgent("antigravity", home, true, plan.fingerprint);
    expect(agentInstalled("antigravity", home)).toBe(true);
    const parsed = JSON.parse(readFirst("antigravity")) as Record<string, unknown>;
    expect(JSON.stringify(parsed["hi"])).toContain("--agent antigravity");
  });

  it("Copilot's file is Hi's alone: an unreadable one is refused, not replaced", () => {
    newHome();
    process.env["HI_TEST_HOOK_EXE"] = "C:\\fake\\electron.exe";
    const file = path.join(home, ".copilot", "hooks", "hi.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "garbage");
    expect(() => previewAgent("copilot", home, true)).toThrow(/could not be parsed/);
  });

  it("OpenCode and Amp plugins are code files marked as Hi's; recognized and replaced", () => {
    newHome();
    process.env["HI_TEST_HOOK_EXE"] = "C:\\fake\\electron.exe";
    for (const id of ["opencode", "amp"] as const) {
      const plan = previewAgent(id, home, true);
      applyAgent(id, home, true, plan.fingerprint);
      const text = readFirst(id);
      expect(text).toContain("hi-hook");
      expect(text).toContain("generated by Hi");
      expect(agentInstalled(id, home)).toBe(true);
      const again = previewAgent(id, home, true);
      applyAgent(id, home, true, again.fingerprint);
      expect(readFirst(id)).toBe(text);
    }
  });

  it("OpenCode plugin uses the documented named export and permission hook", () => {
    newHome();
    process.env["HI_TEST_HOOK_EXE"] = "C:\\fake\\electron.exe";
    const plan = previewAgent("opencode", home, true);
    applyAgent("opencode", home, true, plan.fingerprint);
    const text = readFirst("opencode");
    // opencode only loads NAMED plugin exports; a default export is ignored.
    expect(text).toContain("export const HiPlugin");
    expect(text).not.toContain("export default");
    // The real permission-control hook, separate from observational events.
    expect(text).toContain("'permission.ask'");
    // Session discovery from the SDK, so an already-open session appears.
    expect(text).toContain("client.session.list");
    // Tracks cwd per session and reports it on tool events.
    expect(text).toContain("cwdBySession");
  });

  it("Hermes gets a two-file python pack, removed again with the folder", () => {
    newHome();
    process.env["HI_TEST_HOOK_EXE"] = "C:\\fake\\electron.exe";
    const plan = previewAgent("hermes", home, true);
    applyAgent("hermes", home, true, plan.fingerprints);
    expect(agentInstalled("hermes", home)).toBe(true);
    const py = readFirst("hermes");
    expect(py).toContain("register(ctx)");
    const files = agentFiles("hermes", home);
    expect(fs.existsSync(files[1])).toBe(true);
    const rm = previewAgent("hermes", home, false);
    applyAgent("hermes", home, false, rm.fingerprints);
    expect(agentInstalled("hermes", home)).toBe(false);
    expect(fs.existsSync(path.dirname(files[0]))).toBe(false);
  });

  it("nothing else's files are replaced: Claude Code install never lands here", () => {
    newHome();
    process.env["HI_TEST_HOOK_EXE"] = "C:\\fake\\electron.exe";
    for (const id of ALL_AGENTS) {
      expect(fs.existsSync(agentFiles(id, home)[0])).toBe(false);
    }
    expect(fs.existsSync(settingsPath(home))).toBe(false);
    expect(status()).toMatchObject({ installed: false });
  });
});
