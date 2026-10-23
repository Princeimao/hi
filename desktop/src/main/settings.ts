// Port of mu/windows/src-tauri/src/settings.rs + hooks.rs "ensure_hook_exe" —
// where Hi keeps things, and the relay command line for each agent's shell.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Relay, Shell, quoteFor } from "./relay-command";

export function homeDir(): string {
  if (process.env["HI_TEST_HOME"]) return process.env["HI_TEST_HOME"];
  return os.homedir();
}

export function localDir(): string {
  return process.env["HI_TEST_LOCAL"] ?? path.join(process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), ".local", "share"), "Hi");
}

export function binDir(): string {
  return path.join(localDir(), "bin");
}

/// The stable path Claude Code (and every other agent) runs: Hi's launcher in
/// bin/. A stable path survives app moves and reinstallations, and the folder
/// is ours alone — nobody else may swap the program agents run.
export function hookExePath(): string {
  return path.join(binDir(), process.platform === "win32" ? "hi-hook.cmd" : "hi-hook");
}

/// Writes (or refreshes) the launcher in bin/: a two-line forwarder to the
/// running app's executable, so a settings shared between machines always names
/// the same path. The app calls this on every launch.
export function ensureHookLauncher(): void {
  try {
    fs.mkdirSync(binDir(), { recursive: true, mode: 0o700 });
    const targets = hookCliCommand();
    if (process.platform === "win32") {
      // ELECTRON_RUN_AS_NODE=1 keeps the agent's stdin payload: Electron's GUI
      // subsystem drops it on Windows, which made every hook arrive empty.
      const body = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n${targets}\r\n`;
      fs.writeFileSync(hookExePath(), body, "utf8");
      const alias = hookCmdPath();
      fs.mkdirSync(path.dirname(alias), { recursive: true, mode: 0o700 });
      fs.writeFileSync(alias, body, "utf8");
    } else {
      fs.writeFileSync(hookExePath(), `#!/bin/sh\nexec ${targets}\n`, "utf8");
      fs.chmodSync(hookExePath(), 0o755);
    }
  } catch {
    // A launcher that cannot be written only means hooks cannot install; the
    // rest of Hi keeps working.
  }
}

/// `"<exe>" [<app dir>] --hook %*` — how the launcher starts the hook CLI,
/// which is this app in a special mode. In dev the electron binary needs the
/// app directory too; a packaged app does not.
export function hookCliCommand(): string {
  const exe = process.env["HI_TEST_HOOK_EXE"] ?? process.execPath;
  // Hook mode runs as plain Node (ELECTRON_RUN_AS_NODE=1 in the launcher):
  // Electron's GUI subsystem does not receive the agent's stdin payload on
  // Windows, and this path never needs an Electron window.
  if (appIsPackaged()) {
    const resources = process.resourcesPath ?? "";
    const entry = path.join(resources, "app.asar", "dist-electron", "hook-entry.js");
    return `"${exe}" "${entry}" --hook %*`;
  }
  const appDir = appDirGuess();
  if (!appDir) return `"${exe}" --hook %*`;
  return `"${exe}" "${path.join(appDir, "dist-electron", "hook-entry.js")}" --hook %*`;
}

function appIsPackaged(): boolean {
  const proc = process as unknown as { isPackaged?: boolean };
  return proc.isPackaged === true;
}

function appDirGuess(): string | null {
  // Wherever this module ends up compiled, the app home is the nearest parent
  // with a package.json.
  let dir = path.dirname(__dirname);
  for (let i = 0; i < 4 && dir; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/// The relay command for the running OS, for `args` — the launcher path, one
/// shell word, plus the event name.
/// A cmd.exe-safe path: 8.3 short names have no spaces or quotes, so agents
/// that run hooks through cmd never have to quote (Antigravity mis-escapes
/// `"C:\Users\First Last\..."` into `\"...\"`). Falls back to the long path.
export function hookCmdPath(): string {
  if (process.platform !== "win32") return hookExePath();
  const base = process.env["PUBLIC"] ?? "C:\\Users\\Public";
  return path.join(base, "Hi", "bin", "hi-hook.cmd");
}

export function relayCommand(shell: Shell, args: string): string {
  const exe = process.platform === "win32" && shell === "cmd" ? hookCmdPath() : hookExePath();
  return new Relay(exe, process.platform === "win32").command(shell, args);
}

export { Relay, Shell, quoteFor };
