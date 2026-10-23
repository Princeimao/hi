// Port of mu/windows/src-tauri/src/agents.rs â€” hook and plugin installers for
// every agent other than Claude Code (hook-installer.ts). Each agent is a list
// of file edits handed to config-file.ts, which applies the rules once for all
// of them: strict read, refuse unexpected types, diff, dated backup that must
// succeed, fingerprint check, atomic write. Formats and paths follow the Mac
// app so a config shared between machines (dotfiles) looks the same everywhere.

import fs from "node:fs";
import path from "node:path";
import { homeDir, hookExePath, relayCommand } from "./settings";
import { type EditOutcome, type FileEdit, type Plan, apply, preview, pretty } from "./config-file";
import { type Shell } from "./relay-command";

/// Marker that identifies a Hi entry: the launcher's file name.
export const MARKER = "hi-hook";

export type AgentId =
  | "gemini"
  | "antigravity"
  | "cursor"
  | "codex"
  | "copilot"
  | "muse"
  | "opencode"
  | "amp"
  | "hermes";

export const ALL_AGENTS: AgentId[] = [
  "codex",
  "copilot",
  "muse",
  "gemini",
  "antigravity",
  "cursor",
  "opencode",
  "amp",
  "hermes",
];

export interface AgentMeta {
  id: AgentId;
  name: string;
  approvals: boolean;
  note: string;
}

export const AGENT_META: Record<AgentId, AgentMeta> = {
  gemini: { id: "gemini", name: "Gemini CLI", approvals: false, note: "Start a new Gemini CLI session to pick the hooks up." },
  antigravity: { id: "antigravity", name: "Antigravity", approvals: false, note: "Start a new Antigravity conversation to pick the hooks up." },
  cursor: { id: "cursor", name: "Cursor Agent", approvals: false, note: "Restart Cursor to pick the hooks up." },
  codex: { id: "codex", name: "Codex", approvals: true, note: "Codex runs new hooks only once you trust them: start Codex and review them once with /hooks." },
  copilot: { id: "copilot", name: "GitHub Copilot CLI", approvals: true, note: "Start a new Copilot CLI session to pick the hooks up." },
  muse: { id: "muse", name: "Muse Code", approvals: true, note: "Start a new Muse Code session to pick the hooks up." },
  opencode: { id: "opencode", name: "OpenCode", approvals: false, note: "Restart OpenCode to load the plugin." },
  amp: { id: "amp", name: "Amp", approvals: false, note: "Restart Amp to load the plugin." },
  hermes: { id: "hermes", name: "Hermes Agent", approvals: false, note: "Turn it on once with `hermes plugins enable coucou`, then start a new Hermes session." },
};

/// The files this agent's install touches, under `home`.
export function agentFiles(id: AgentId, home = homeDir()): string[] {
  switch (id) {
    case "gemini":
      return [path.join(home, ".gemini", "settings.json")];
    case "antigravity":
      return [path.join(home, ".gemini", "config", "hooks.json")];
    case "cursor":
      return [path.join(home, ".cursor", "hooks.json")];
    case "codex":
      return [path.join(home, ".codex", "hooks.json")];
    case "copilot":
      return [path.join(home, ".copilot", "hooks", "hi.json")];
    case "muse":
      return [path.join(home, ".config", "muse", "settings.json")];
    // OpenCode and Amp read ~/.config on Windows too.
    case "opencode":
      return [path.join(home, ".config", "opencode", "plugins", "hi.js")];
    case "amp":
      return [path.join(home, ".config", "amp", "plugins", "hi.ts")];
    case "hermes": {
      const dir = path.join(home, ".hermes", "plugins", "hi");
      return [path.join(dir, "__init__.py"), path.join(dir, "plugin.yaml")];
    }
  }
}

// â”€â”€ Gemini CLI â€” ~/.gemini/settings.json â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Claude-style groups with a `*` matcher and timeouts in milliseconds. The
// event name the launcher should report goes on the command line.

const GEMINI_EVENTS: [string, string, number][] = [
  ["SessionStart", "SessionStart", 10_000],
  ["SessionEnd", "SessionEnd", 10_000],
  ["BeforeTool", "PreToolUse", 5_000],
  ["AfterTool", "PostToolUse", 5_000],
  ["BeforeAgent", "UserPromptSubmit", 5_000],
  ["AfterAgent", "Stop", 5_000],
];

// â”€â”€ Cursor Agent â€” ~/.cursor/hooks.json â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// `{"version": 1, "hooks": {"<event>": [{"command": â€¦}]}}`, camelCase events.
// The relay maps them and prints nothing back: no permission is ever given on
// Cursor's behalf.

const CURSOR_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "stop",
];

// â”€â”€ Codex â€” ~/.codex/hooks.json â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Claude-style groups without a matcher, timeouts in seconds. PermissionRequest
// waits for the island (120 s) and is answered with Claude Code's
// hookSpecificOutput â€” only after a click.

const CODEX_EVENTS: [string, number][] = [
  ["SessionStart", 10],
  ["UserPromptSubmit", 10],
  ["PreToolUse", 10],
  ["PermissionRequest", 120],
  ["PostToolUse", 10],
  ["Stop", 10],
  ["SubagentStart", 10],
  ["SubagentStop", 10],
  ["Interrupt", 3],
  ["SessionEnd", 3],
];

const CODEX_WAITING = "Waiting for your answer in the island (Hi)";

// â”€â”€ GitHub Copilot CLI â€” ~/.copilot/hooks/hi.json â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// A file of Hi's own in Copilot's hooks folder: camelCase events, each entry
// `{"type": "command", "bash": â€¦, "timeoutSec": N}`, plus `powershell` on
// Windows. Copilot is fail-closed on permissionRequest.

const COPILOT_EVENTS: [string, number][] = [
  ["sessionStart", 10],
  ["userPromptSubmitted", 10],
  ["preToolUse", 10],
  ["permissionRequest", 120],
  ["postToolUse", 10],
  ["agentStop", 10],
  ["sessionEnd", 3],
  ["notification", 10],
];

// â”€â”€ Muse Code â€” ~/.config/muse/settings.json â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Claude-style groups with a `*` matcher, PascalCase events, timeouts in
// milliseconds. Permission requests get the island's card and a bare
// permissionDecision back.

const MUSE_EVENTS: [string, number][] = [
  ["SessionStart", 10],
  ["UserPromptSubmit", 5],
  ["PreToolUse", 5],
  ["PermissionRequest", 120],
  ["PostToolUse", 5],
  ["Stop", 5],
  ["SessionEnd", 3],
];

// â”€â”€ Antigravity â€” ~/.gemini/config/hooks.json â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Hooks are named groups at the top level; Hi's is `hi`. Tool events take
// matcher groups, lifecycle events take handlers directly; timeouts are in
// seconds. The launcher answers PreToolUse with "{\"decision\":\"ask\"}" â€”
// never with an allow: Antigravity's own permission rules stay in charge.

const ANTIGRAVITY_TOOL_EVENTS = ["PreToolUse", "PostToolUse"];
const ANTIGRAVITY_LIFECYCLE_EVENTS = ["PreInvocation", "PostInvocation", "Stop"];

// â”€â”€ Plugins: OpenCode, Amp, Hermes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// These agents load code rather than run hook commands. Every one is
// fire-and-forget: the agent never waits on Hi, and if Hi is closed nothing
// happens. None of them ever answers a permission.

/// Every plugin file Hi writes says so; only such a file is replaced or removed.
const GENERATED = "generated by Hi";

function openCodePlugin(): string {
  return `// Hi plugin for OpenCode â€” ${GENERATED}.
// Forwards OpenCode's events to Hi's launcher (hi-hook), fire-and-forget:
// OpenCode never waits on it, and nothing happens when Hi is closed.
import { spawn } from 'node:child_process';

const HOOK = ${JSON.stringify(hookExePath())};
const NEEDS_SHELL = HOOK.endsWith('.cmd');

// Per-session working directory, tracked from session events so tool hooks
// (which only get a sessionID) can report an accurate cwd.
const cwdBySession = new Map();
const lastText = new Map();

function runHook(hook_event_name, payload, onDecision) {
  try {
    const p = spawn(
      HOOK,
      ['--hook', hook_event_name, '--agent', 'opencode'],
      NEEDS_SHELL
        ? { shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
        : { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
    p.on('error', () => {});
    let out = '';
    if (onDecision) p.stdout?.on('data', (d) => { out += String(d); });
    if (p.stdout) p.stdout?.on('end', () => { try { onDecision && onDecision(out); } catch {} });
    p.stdin?.on('error', () => {});
    p.stdin?.end(JSON.stringify({ hook_event_name, ...payload }) + '\\n');
    return p;
  } catch {
    return null;
  }
}

function forward(hook_event_name, payload) {
  runHook(hook_event_name, payload, null);
}

// Session id + cwd extraction per OpenCode 1.18 SDK: session.* events carry
// {info: {id, directory}}; tool hooks carry {sessionID}.
function sidOf(props) {
  return (props && (props.sessionID || (props.info && props.info.id))) || '';
}
function cwdOf(sid) {
  return (sid && cwdBySession.get(sid)) || '';
}

export const HiPlugin = async (context) => {
  // Initialization diagnostic: prove the plugin actually loaded. Written to
  // stderr so it shows in OpenCode's log, never to the user's stdout.
  try { console.error('[hi] opencode plugin loaded, dir=' + (context && context.directory)); } catch {}
  // Discover any sessions that already exist when the plugin loads (e.g. a
  // resumed session), so the island shows them instead of staying empty. Only
  // real sessions from the SDK â€” never invent one.
  try {
    const client = context && context.client;
    if (client && client.session && typeof client.session.list === 'function') {
      const res = await client.session.list();
      const sessions = (res && (res.data || res)) || [];
      for (const s of Array.isArray(sessions) ? sessions : []) {
        if (!s || !s.id) continue;
        if (s.directory) cwdBySession.set(s.id, s.directory);
        forward('SessionStart', { session_id: s.id, cwd: s.directory || (context && context.directory) || '' });
      }
    }
  } catch {}

  return {
    event: async ({ event }) => {
      try {
        const type = (event && event.type) || '';
        const props = (event && event.properties) || {};
        const sid = sidOf(props);

        if (type === 'session.created' || type === 'session.updated') {
          const info = props.info || {};
          if (info.id && info.directory) cwdBySession.set(info.id, info.directory);
          forward('SessionStart', { session_id: info.id || sid, cwd: info.directory || cwdOf(sid) });
          return;
        }
        if (type === 'session.idle') {
          forward('Stop', { session_id: sid, cwd: cwdOf(sid), last_assistant_message: lastText.get(sid) || '' });
          lastText.delete(sid);
          return;
        }
        if (type === 'session.error') {
          forward('StopFailure', { session_id: sid, cwd: cwdOf(sid) });
          return;
        }
        if (type === 'session.deleted') {
          const info = props.info || {};
          forward('SessionEnd', { session_id: info.id || sid, cwd: info.directory || cwdOf(sid) });
          cwdBySession.delete(info.id || sid);
          lastText.delete(info.id || sid);
          return;
        }
        if (type === 'message.updated' || type === 'message.part.updated') {
          const msg = props.info || props.message || props;
          const text = typeof (msg && msg.text) === 'string' ? msg.text
            : (Array.isArray(msg && msg.parts)
              ? msg.parts.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ')
              : '');
          if (text && msg && msg.role === 'assistant' && sid) lastText.set(sid, text);
          return;
        }
        // permission.asked / permission.v2.asked are OBSERVATIONAL only â€” the
        // real decision happens in the permission.ask hook below. We do NOT
        // forward them here, or the island would show a duplicate card with no
        // way to answer.
      } catch {}
    },

    // The actual permission-control hook. opencode asks here before running a
    // tool; we show a card on the island and write the human's decision back.
    'permission.ask': async (input, output) => {
      try {
        const rid = (input && (input.id || input.callID)) || '';
        const sid = (input && input.sessionID) || '';
        const tool = (input && input.type) || 'tool';
        const target = (input && (input.title || input.pattern)) || '';
        const text = await new Promise((resolve) => {
          const p = runHook('PermissionRequest', {
            session_id: sid,
            request_id: String(rid),
            tool_name: tool,
            tool_input: { path: Array.isArray(target) ? target.join(', ') : String(target) },
          }, (out) => resolve(String(out || '')));
          if (!p) resolve('');
          // Fail-safe timeout: never block opencode forever; no decision = let
          // opencode ask in its own terminal.
          setTimeout(() => resolve(''), 108000);
        });
        const t = String(text || '').trim();
        if (t) {
          try {
            const j = JSON.parse(t);
            if (j && j.status === 'allow') { output.status = 'allow'; return; }
            if (j && j.status === 'deny') { output.status = 'deny'; return; }
          } catch {}
        }
        // No (or invalid) decision: leave output.status untouched so opencode
        // falls back to its own prompt. Never auto-allow.
      } catch {}
    },

    'tool.execute.before': async (input, output) => {
      try {
        const sid = (input && input.sessionID) || '';
        forward('PreToolUse', {
          session_id: sid,
          cwd: cwdOf(sid),
          tool_name: typeof (input && input.tool) === 'string' ? input.tool : '',
          tool_input: (output && output.args) ?? null,
        });
      } catch {}
    },
    'tool.execute.after': async (input) => {
      try {
        const sid = (input && input.sessionID) || '';
        forward('PostToolUse', {
          session_id: sid,
          cwd: cwdOf(sid),
          tool_name: typeof (input && input.tool) === 'string' ? input.tool : '',
        });
      } catch {}
    },
  };
};
`;
}

function ampPlugin(): string {
  return `// Hi plugin for Amp â€” ${GENERATED}.
// Forwards Amp's events to Hi's launcher (hi-hook), fire-and-forget and
// display only: Amp never waits on it, and it never decides anything for Amp.
import { spawn } from 'node:child_process';

const HOOK = ${JSON.stringify(hookExePath())};

function forward(hook_event_name, fields) {
  try {
    const p = spawn(
      HOOK,
      ['--hook', hook_event_name, '--agent', 'amp'],
      { shell: process.platform === 'win32', stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true },
    );
    p.on('error', () => {});
    p.stdin?.on('error', () => {});
    p.stdin?.end(JSON.stringify({ hook_event_name, ...fields }) + '\\n');
  } catch {}
}

export default function (amp) {
  const session = (e) => ({ session_id: e?.thread?.id ?? '' });
  amp.on('session.start', (e) => { forward('SessionStart', session(e)); });
  amp.on('agent.start', (e) => {
    forward('UserPromptSubmit', { ...session(e), prompt: typeof e?.message === 'string' ? e.message : '' });
  });
  // A step per tool once it has run: listening to tool.call would mean
  // returning a verdict for Amp, and Hi never makes one.
  amp.on('tool.result', (e) => {
    forward('PreToolUse', { ...session(e), tool_name: typeof e?.tool === 'string' ? e.tool : '', tool_input: e?.input ?? null });
  });
  amp.on('agent.end', (e) => { forward('Stop', { ...session(e), status: e?.status ?? '' }); });
}
`;
}

function hermesPlugin(): string {
  return `# Hi plugin for Hermes Agent â€” ${GENERATED}.
# Session and tool events go to Hi's launcher (hi-hook), fire-and-forget:
# Hermes never waits on it, and keeps every approval decision to itself.
import json, os, subprocess, threading

HOOK = ${JSON.stringify(hookExePath())}
_current_session_id = ''


def _fire(fields):
    """Non-blocking: start the relay and return at once. Reaps it in a thread."""
    def _run():
        try:
            event = fields.get('hook_event_name', '')
            extra = {'start_new_session': True} if os.name != 'nt' else {
                'creationflags': getattr(subprocess, 'CREATE_NO_WINDOW', 0)}
            p = subprocess.Popen([HOOK, '--hook', event, '--agent', 'hermes'],
                                 stdin=subprocess.PIPE,
                                 stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL,
                                 shell=(os.name == 'nt'), **extra)
            p.stdin.write(json.dumps(fields).encode() + b'\\n')
            p.stdin.close()
            p.wait(timeout=5)
        except Exception:
            pass
    threading.Thread(target=_run, daemon=True).start()


def register(ctx):
    def on_session_start(**kwargs):
        global _current_session_id
        sid = kwargs.get('session_id', '')
        _current_session_id = sid
        platform = kwargs.get('platform', 'cli') or 'cli'
        _fire({'hook_event_name': 'SessionStart', 'session_id': sid, 'platform': platform})

    def on_session_end(**kwargs):
        # Stop comes from post_llm_call, which has the last answer.
        if kwargs.get('interrupted'):
            _fire({'hook_event_name': 'StopFailure', 'session_id': kwargs.get('session_id', '')})

    def post_llm_call(**kwargs):
        _fire({'hook_event_name': 'Stop',
               'session_id': kwargs.get('session_id', '') or _current_session_id,
               'last_assistant_message': kwargs.get('assistant_response', '')})

    def pre_tool_call(**kwargs):
        _fire({'hook_event_name': 'PreToolUse',
               'session_id': kwargs.get('session_id', '') or _current_session_id,
               'tool_name': kwargs.get('tool_name', ''),
               'tool_input': kwargs.get('args') or {}})

    def post_tool_call(**kwargs):
        _fire({'hook_event_name': 'PostToolUse',
               'session_id': kwargs.get('session_id', '') or _current_session_id,
               'tool_name': kwargs.get('tool_name', '')})

    def pre_approval_request(**kwargs):
        # Observer only: Hermes asks and decides; the island just says so.
        _fire({'hook_event_name': 'PreToolUse',
               'session_id': kwargs.get('session_key', '') or _current_session_id,
               'tool_name': 'Approval pending in Hermes',
               'tool_input': {'command': kwargs.get('command', ''),
                              'description': kwargs.get('description', '')}})

    ctx.register_hook('on_session_start', on_session_start)
    ctx.register_hook('on_session_end', on_session_end)
    ctx.register_hook('post_llm_call', post_llm_call)
    ctx.register_hook('pre_tool_call', pre_tool_call)
    ctx.register_hook('post_tool_call', post_tool_call)
    ctx.register_hook('pre_approval_request', pre_approval_request)
`;
}

const HERMES_PLUGIN_YAML = `name: hi
version: "1.0"
description: Hi island integration â€” ${GENERATED}
`;

// â”€â”€ Shared JSON helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function unexpected(what: string): string {
  return `${what} has an unexpected type â€” Hi has not touched it.`;
}

function objectAt(root: Json, key: string): Json {
  if (!(key in root)) return {};
  if (!isObject(root[key])) throw new Error(unexpected(`"${key}"`));
  return root[key] as Json;
}

function listAt(hooks: Json, event: string): unknown[] {
  if (!(event in hooks)) return [];
  if (!isArray(hooks[event])) throw new Error(unexpected(`"hooks"."${event}"`));
  return hooks[event] as unknown[];
}

/// A command line written by Hi for `agent`.
function isOurCommand(command: unknown, agent: string): boolean {
  return (
    typeof command === "string" && command.includes(MARKER) && command.includes(`--agent ${agent}`)
  );
}

/// Claude-style groups (`{"matcher"?, "hooks": [{"command"}]}`, or a legacy
/// flat `{"command"}`) without Hi's entries for `agent`. A group left empty
/// goes; everything else stays exactly as it was.
function withoutOursInGroups(groups: unknown[], agent: string): unknown[] {
  return groups
    .map((group) => {
      if (isObject(group) && isOurCommand(group["command"], agent)) return null;
      if (!isObject(group) || !isArray(group["hooks"])) return group;
      const inner = group["hooks"] as unknown[];
      const kept = inner.filter((h) => !(isObject(h) && isOurCommand(h["command"], agent)));
      if (kept.length === inner.length) return group;
      if (kept.length === 0) return null;
      return { ...group, hooks: kept };
    })
    .filter((g): g is unknown => g !== null);
}

/// `root` with one Hi group per event. Earlier Hi entries for `agent` are
/// replaced; nobody else's are touched.
function groupsInstall(root: unknown, agent: string, events: [string, unknown][]): Json {
  const out: Json = { ...(isObject(root) ? root : {}) };
  const hooks = objectAt(out, "hooks");
  for (const [event, group] of events) {
    const list = withoutOursInGroups(listAt(hooks, event), agent);
    list.push(group);
    hooks[event] = list;
  }
  out["hooks"] = hooks;
  return out;
}

/// `root` without any Hi group for `agent`; an event left empty goes, and so
/// does `hooks` when nothing is left in it.
function groupsUninstall(root: unknown, agent: string): Json {
  const out: Json = { ...(isObject(root) ? root : {}) };
  if (!("hooks" in out)) return out;
  const hooks = objectAt(out, "hooks");
  const next: Json = {};
  for (const [event, value] of Object.entries(hooks)) {
    if (isArray(value)) {
      const kept = withoutOursInGroups(value, agent);
      if (kept.length > 0) next[event] = kept;
    } else {
      next[event] = value;
    }
  }
  if (Object.keys(next).length === 0) delete out["hooks"];
  else out["hooks"] = next;
  return out;
}

function groupsHaveOurs(root: unknown, agent: string): boolean {
  if (!isObject(root) || !isObject(root["hooks"])) return false;
  return Object.values(root["hooks"]).some(
    (list) =>
      isArray(list) &&
      list.some(
        (group) =>
          (isObject(group) && isOurCommand(group["command"], agent)) ||
          (isObject(group) && isArray(group["hooks"]) &&
            (group["hooks"] as unknown[]).some((h) => isObject(h) && isOurCommand(h["command"], agent))),
      ),
  );
}

/// A named `hi` group Hi wrote (it runs the launcher as `--agent antigravity`).
function antigravityIsOurs(group: unknown): boolean {
  const text = JSON.stringify(group);
  return text.includes(MARKER) && text.includes("--agent antigravity");
}

function antigravityBlock(): Json {
  const handler = (event: string) => ({
    type: "command",
    command: relayCommand("cmd" as Shell, `${event} --agent antigravity`),
    timeout: 10,
  });
  const block: Json = {};
  for (const event of ANTIGRAVITY_TOOL_EVENTS) {
    block[event] = [{ matcher: "*", hooks: [handler(event)] }];
  }
  for (const event of ANTIGRAVITY_LIFECYCLE_EVENTS) {
    block[event] = [handler(event)];
  }
  return block;
}

function isOurPlugin(text: string): boolean {
  return text.includes(GENERATED);
}

// â”€â”€ JSON per-agent changes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function jsonChange(id: AgentId, install: boolean): (current: unknown) => unknown {
  return (current) => {
    switch (id) {
      case "gemini": {
        if (!install) return groupsUninstall(current, "gemini");
        const root = groupsInstall(
          current,
          "gemini",
          GEMINI_EVENTS.map(([event, said, timeout]) => [
            event,
            { matcher: "*", hooks: [{ type: "command", command: relayCommand("powershell", `${said} --agent gemini`), timeout }] },
          ]),
        );
        return root;
      }
      case "antigravity": {
        if (!install) {
          const out: Json = { ...(isObject(current) ? current : {}) };
          if ("hi" in out && antigravityIsOurs(out["hi"])) delete out["hi"];
          return out;
        }
        const out: Json = { ...(isObject(current) ? current : {}) };
        if ("coucou" in out && !antigravityIsOurs(out["coucou"])) {
          throw new Error('A hook group named "coucou" that Hi did not write is already there â€” Hi has not touched it.');
        }
        if ("hi" in out && !antigravityIsOurs(out["hi"])) {
          throw new Error('A hook group named "hi" that Hi did not write is already there â€” Hi has not touched it.');
        }
        out["hi"] = antigravityBlock();
        return out;
      }
      case "cursor": {
        if (!install) return groupsUninstall(current, "cursor");
        const root = groupsInstall(
          current,
          "cursor",
          CURSOR_EVENTS.map((event) => [event, { command: relayCommand("cmd" as Shell, `${event} --agent cursor`) }]),
        );
        if (!("version" in root)) root["version"] = 1;
        return root;
      }
      case "codex": {
        if (!install) return groupsUninstall(current, "codex");
        const root = groupsInstall(
          current,
          "codex",
          CODEX_EVENTS.map(([event, timeout]) => {
            const hook: Json = { type: "command", command: relayCommand("cmd" as Shell, `${event} --agent codex`), timeout };
            if (event === "PermissionRequest") hook["statusMessage"] = CODEX_WAITING;
            return [event, { hooks: [hook] }];
          }),
        );
        return root;
      }
      case "copilot": {
        if (!install) {
          const root: Json = { ...(isObject(current) ? current : {}) };
          if ("hooks" in root) {
            const hooks = objectAt(root, "hooks");
            for (const event of Object.keys(hooks)) {
              if (isArray(hooks[event])) {
                hooks[event] = (hooks[event] as unknown[]).filter((e) => !copilotEntryIsOurs(e));
              }
            }
            for (const event of Object.keys(hooks)) {
              if (isArray(hooks[event]) && (hooks[event] as unknown[]).length === 0) delete hooks[event];
            }
            if (Object.keys(hooks).length === 0) delete root["hooks"];
          }
          if (Object.keys(root).every((k) => k === "version")) return null; // file was Hi's alone: it goes
          return root;
        }
        const root: Json = { ...(isObject(current) ? current : {}) };
        const hooks = objectAt(root, "hooks");
        for (const [event, timeout] of COPILOT_EVENTS) {
          const args = `${event} --agent copilot`;
          const entry: Json = { type: "command", bash: relayCommand("sh", args), timeoutSec: timeout };
          if (process.platform === "win32") entry["powershell"] = relayCommand("powershell", args);
          const list = listAt(hooks, event).filter((e) => !copilotEntryIsOurs(e));
          list.push(entry);
          hooks[event] = list;
        }
        root["hooks"] = hooks;
        root["version"] = 1;
        return root;
      }
      case "muse": {
        if (!install) return groupsUninstall(current, "muse");
        const fresh = !isObject(current) || Object.keys(current).length === 0;
        let root = groupsInstall(
          current,
          "muse",
          MUSE_EVENTS.map(([event, seconds]) => [
            event,
            {
              matcher: "*",
              hooks: [{ type: "command", command: relayCommand("cmd" as Shell, `${event} --agent muse`), timeout: seconds * 1000 }],
            },
          ]),
        );
        if (fresh && !("schema_version" in root)) root["schema_version"] = 1;
        return root;
      }
    }
  };
}

function copilotEntryIsOurs(entry: unknown): boolean {
  return ["bash", "powershell", "command"].some((k) => isObject(entry) && isOurCommand(entry[k], "copilot"));
}

// â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface AgentStatus {
  id: AgentId;
  name: string;
  installed: boolean;
  path: string;
  approvals: boolean;
  note: string;
}

export function agentInstalled(id: AgentId, home = homeDir()): boolean {
  const files = agentFiles(id, home);
  const first = files[0];
  try {
    if (id === "opencode" || id === "amp" || id === "hermes") {
      return isOurPlugin(fs.readFileSync(first, "utf8"));
    }
    const bytes = fs.readFileSync(first);
    const text = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
      ? bytes.toString("utf8").slice(1)
      : bytes.toString("utf8");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return false;
    }
    switch (id) {
      case "gemini":
        return groupsHaveOurs(parsed, "gemini");
      case "antigravity":
        return isObject(parsed) && antigravityIsOurs(parsed["hi"]);
      case "cursor":
        return groupsHaveOurs(parsed, "cursor");
      case "codex":
        return groupsHaveOurs(parsed, "codex");
      case "copilot":
        return (
          isObject(parsed) &&
          isObject(parsed["hooks"]) &&
          Object.values(parsed["hooks"]).some(
            (list) => isArray(list) && (list as unknown[]).some(copilotEntryIsOurs),
          )
        );
      case "muse":
        return groupsHaveOurs(parsed, "muse");
    }
  } catch {
    return false;
  }
  return false;
}

export function listAgents(home = homeDir()): AgentStatus[] {
  return ALL_AGENTS.map((id) => ({
    id,
    name: AGENT_META[id].name,
    installed: agentInstalled(id, home),
    path: agentFiles(id, home).join("\n"),
    approvals: AGENT_META[id].approvals,
    note: AGENT_META[id].note,
  }));
}

function edits(id: AgentId, home: string, install: boolean): FileEdit[] {
  if (id === "opencode" || id === "amp" || id === "hermes") {
    const contents = id === "opencode" ? [openCodePlugin()] : id === "amp" ? [ampPlugin()] : [hermesPlugin(), HERMES_PLUGIN_YAML];
    return agentFiles(id, home).map((p, i) => ({
      path: p,
      edit: (current): EditOutcome => {
        if (current.bytes !== null && !isOurPlugin(current.text)) {
          return { error: `${current.label} wasn't written by Hi â€” Hi has not touched it.` };
        }
        return { value: install ? contents[i] : null };
      },
    }));
  }
  const change = jsonChange(id, install);
  return [
    {
      path: agentFiles(id, home)[0],
      edit: (current): EditOutcome => {
        if (current.parsed === null && current.bytes !== null) {
          return { error: `${current.label} could not be parsed as JSON â€” Hi has not touched it.` };
        }
        try {
          const next = change(current.parsed);
          return next === null ? { value: null } : { value: pretty(next) };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}

export function previewAgent(id: AgentId, home: string, install: boolean): Plan {
  return preview(edits(id, home, install));
}

/// Only ever called from an explicit confirmation. Returns the backups taken.
export function applyAgent(id: AgentId, home: string, install: boolean, fingerprint: string | string[]): string[] {
  const backups = apply(edits(id, home, install), fingerprint);
  // Hermes loads every folder under plugins/: an empty `hi` one goes too,
  // including the dated backups apply() took of Hi's own plugin files.
  if (id === "hermes" && !install) {
    const dir = path.dirname(agentFiles(id, home)[0]);
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith("__init__.py.") || name.startsWith("plugin.yaml.")) {
          fs.rmSync(path.join(dir, name), { force: true });
        }
      }
      fs.rmdirSync(dir);
    } catch {
      // Anything else left in the folder stays.
    }
  }
  return backups;
}

