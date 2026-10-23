import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOOK_EVENTS,
  hooksPresent,
  merged,
  previewInstall,
  status,
  withoutOurs,
  writeInstall,
} from "../src/main/hook-installer";

let home: string;
const newHome = (): void => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hi-hooks-"));
  process.env["HI_TEST_HOME"] = home;
};
afterAll(() => {
  delete process.env["HI_TEST_HOME"];
  delete process.env["HI_TEST_HOOK_EXE"];
});

function startSettings(): string {
  return fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8");
}

describe("Claude Code hook installer", () => {
  it("merged() adds every event once with the relay command, timeouts kept", () => {
    newHome();
    const relay = merged({});
    const hooks = relay["hooks"] as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual(
      HOOK_EVENTS.map(([e]) => e).sort(),
    );
    const perm = hooks["PermissionRequest"] as { hooks: { command: string; timeout: number }[] }[];
    expect(perm).toHaveLength(1);
    expect(perm[0].hooks[0].timeout).toBe(120);
    expect(perm[0].hooks[0].command).toContain("hi-hook");
    expect(perm[0].hooks[0].command).toContain("PermissionRequest");
    const start = hooks["SessionStart"] as { hooks: { timeout: number }[] }[];
    expect(start[0].hooks[0].timeout).toBe(10);
  });

  it("merged() replaces only Hi's groups, so other hooks stay put", () => {
    newHome();
    const theirs = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo mine" }] }] } };
    const once = merged(theirs);
    const twice = merged(once);
    const list = (twice["hooks"] as Record<string, unknown[]>)["PreToolUse"] as unknown[];
    expect(list).toHaveLength(2);
    expect(JSON.stringify(list)).toContain("echo mine");
    expect(JSON.stringify(list).match(/hi-hook/g)?.length).toBe(1);
  });

  it("withoutOurs() removes every Hi entry and never anything else", () => {
    newHome();
    const theirs = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo mine" }] }] }, other: 1 };
    const withOurs = merged(theirs);
    const cleaned = withoutOurs(withOurs);
    const hooks = cleaned["hooks"] as Record<string, unknown[]>;
    expect(hooks["PreToolUse"] as unknown[]).toEqual(
      (theirs["hooks"] as Record<string, unknown[]>)["PreToolUse"],
    );
    expect(Object.keys(hooks)).toEqual(["PreToolUse"]);
    fromScratchCheck();
    function fromScratchCheck(): void {
      expect(JSON.stringify(cleaned)).not.toContain("hi-hook");
      expect(cleaned["other"]).toBe(1);
    }
  });

  it("merged() refuses a hooks value of the wrong type rather than replacing it", () => {
    newHome();
    expect(() => merged({ hooks: "nope" })).toThrow(/unexpected type/);
    expect(() => merged({ hooks: { PreToolUse: 42 } })).toThrow(/unexpected type/);
  });

  it("it is wired into settings.json only after preview + apply, with a backup", () => {
    newHome();
    process.env["HI_TEST_HOOK_EXE"] = "C:\\fake\\electron.exe";
    expect(status().installed).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude"))).toBe(false);

    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), '{"theme":"dark"}');
    const before = fs.readFileSync(path.join(home, ".claude", "settings.json"));

    const plan = previewInstall(home, true);
    expect(plan.diff).toContain("+");
    const backup = writeInstall(home, true, plan.fingerprint);
    expect(backup).toBeTruthy();
    expect(fs.readFileSync(backup).equals(before)).toBe(true);

    const parsed = JSON.parse(startSettings()) as Record<string, unknown>;
    expect(parsed["theme"]).toBe("dark");
    expect(hooksPresent(parsed)).toBe(true);
    expect(status().installed).toBe(true);
  });

  it("uninstall clears the events and drops hooks entirely when nothing is left", () => {
    newHome();
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
    const plan = previewInstall(home, true);
    writeInstall(home, true, plan.fingerprint);
    expect(status().installed).toBe(true);
    const rmPlan = previewInstall(home, false);
    writeInstall(home, false, rmPlan.fingerprint);
    expect(status().installed).toBe(false);
    expect(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8").trim()).toBe("{}");
  });
});
