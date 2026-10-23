// Port of mu/windows/src-tauri/src/hooks.rs — Claude Code hook installation.
//
// The rule is strict and followed to the letter: read
// %USERPROFILE%\.claude\settings.json, take a dated backup, merge without
// touching anybody else's hooks, show the diff, and write only after an
// explicit confirmation. Uninstall removes Hi's entries and nothing else.
//
// The command is only the quoted exe path in forward slashes plus the event
// name: on Windows Claude Code runs hook commands through Git Bash, and
// anything with PowerShell or cmd in it breaks.

import fs from "node:fs";
import path from "node:path";
import { homeDir, hookExePath, relayCommand } from "./settings";
import { type EditOutcome, type FileEdit, type Plan, apply, preview, pretty, tryParse } from "./config-file";

/// Every event Hi reacts to, with the hook timeout written to settings.json.
/// PermissionRequest waits for a human, so it gets the decision timeout + 10 s.
export const HOOK_EVENTS: [string, number][] = [
  ["SessionStart", 10],
  ["SessionEnd", 10],
  ["UserPromptSubmit", 10],
  ["PreToolUse", 10],
  ["PostToolUse", 10],
  ["PostToolUseFailure", 10],
  ["PermissionRequest", 120],
  ["Notification", 10],
  ["Stop", 10],
  ["StopFailure", 10],
  ["SubagentStart", 10],
  ["SubagentStop", 10],
];

/// Marker that identifies a Hi entry inside settings.json.
export const MARKER = "hi-hook";

export function settingsPath(home = homeDir()): string {
  return path.join(home, ".claude", "settings.json");
}

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

export function status(home = homeDir()): HookStatus {
  const current = tryParse(readIfExists(settingsPath(home)));
  const installed =
    !!current?.hooks &&
    isObject(current.hooks) &&
    Object.values(current.hooks).some((list) => isArray(list) && (list as unknown[]).some(entryIsOurs));
  return {
    installed,
    settingsPath: settingsPath(home),
    hookPath: hookExePath(),
    hookReady: fs.existsSync(hookExePath()),
  };
}

/// True when a parsed settings.json routes Claude Code's SessionStart events to
/// Hi — or to anything matching the broader "island hook" families (the Mac or
/// mu builds), so a settings file shared between machines reads the same.
export function hooksPresent(settings: unknown): boolean {
  if (!isObject(settings)) return false;
  const hooks = settings["hooks"];
  if (!isObject(hooks)) return false;
  const groups = hooks["SessionStart"];
  if (!isArray(groups)) return false;
  return (groups as unknown[]).some((group) => {
    if (!isObject(group)) return false;
    const inner = group["hooks"];
    return (
      isArray(inner) &&
      (inner as unknown[]).some((hook) =>
        isObject(hook) &&
        typeof hook["command"] === "string" &&
        (hook["command"].includes("hi-hook") ||
          hook["command"].includes("coucou-hook") ||
          hook["command"].includes("nb-hook")),
      )
    );
  });
}

function readIfExists(p: string): Buffer | null {
  try {
    return fs.readFileSync(p) as Buffer;
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function entryIsOurs(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  const hooks = entry["hooks"];
  if (!isArray(hooks)) return false;
  return (hooks as unknown[]).some(
    (h) => isObject(h) && typeof h["command"] === "string" && h["command"].includes(MARKER),
  );
}

function unexpected(what: string): string {
  return `settings.json: "${what}" has an unexpected type — Hi has not touched it.`;
}

/// Settings with Hi's hooks added; everything else is left untouched. A `hooks`
/// (or one of its events) that is not what Claude Code documents is refused
/// rather than replaced.
export function merged(existing: unknown, home = homeDir()): Record<string, unknown> {
  const root: Record<string, unknown> = { ...(isObject(existing) ? existing : {}) };
  let hooks: Record<string, unknown> = {};
  if ("hooks" in root) {
    if (!isObject(root["hooks"])) throw new Error(unexpected("hooks"));
    hooks = { ...root["hooks"] };
  }
  for (const [event, timeout] of HOOK_EVENTS) {
    let list: unknown[];
    if (!(event in hooks)) {
      list = [];
    } else if (!isArray(hooks[event])) {
      throw new Error(unexpected(`hooks.${event}`));
    } else {
      list = [...(hooks[event] as unknown[])];
    }
    const filtered = list.filter((entry) => !entryIsOurs(entry));
    filtered.push({
      hooks: [
        {
          type: "command",
          command: relayCommand("sh", event),
          timeout,
        },
      ],
    });
    hooks[event] = filtered;
  }
  root["hooks"] = hooks;
  return root;
}

/// Settings with every Hi entry removed, and nothing else changed.
export function withoutOurs(existing: unknown): Record<string, unknown> {
  const root: Record<string, unknown> = { ...(isObject(existing) ? existing : {}) };
  if (!("hooks" in root)) return root;
  if (!isObject(root["hooks"])) throw new Error(unexpected("hooks"));
  const out: Record<string, unknown> = {};
  for (const [event, value] of Object.entries(root["hooks"])) {
    if (!isArray(value)) {
      out[event] = value;
      continue;
    }
    const kept = (value as unknown[]).filter((e) => !entryIsOurs(e));
    if (kept.length > 0) out[event] = kept;
  }
  if (Object.keys(out).length === 0) delete root["hooks"];
  else root["hooks"] = out;
  return root;
}

function edits(home: string, install: boolean): FileEdit[] {
  return [
    {
      path: settingsPath(home),
      edit: (current): EditOutcome => {
        if (current.parsed === null && current.bytes !== null) {
          return { error: "settings.json could not be parsed as JSON — Hi has not touched it." };
        }
        try {
          return { value: pretty(install ? merged(current.parsed, home) : withoutOurs(current.parsed)) };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}

export function previewInstall(home: string, install: boolean): Plan {
  return preview(edits(home, install));
}

/// Writes the merged (or cleaned) settings after taking a dated backup, and
/// returns where the backup went ("" when there was no file to back up).
export function writeInstall(home: string, install: boolean, fingerprint: string | string[]): string {
  const backups = apply(edits(home, install), fingerprint);
  return backups[0] ?? "";
}
