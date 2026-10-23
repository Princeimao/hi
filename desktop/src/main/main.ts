// Port of mu's app entry, rebuilt around Hi: the coding-agent island. The hook
// relay (pipe-server), the approval lifecycle (registry) and the settings
// installers all run here; the renderer only renders, over a typed preload API.

import { app, BrowserWindow, ipcMain, screen, session } from "electron";
import os from "node:os";
import path from "node:path";
import { SessionRegistry, type RegistryAction } from "./registry";
import * as mediaRemote from "./media-remote";
import {
  PermissionBroker,
  applyActionsToBroker,
  brokerAnswers,
  startPipeRelay,
} from "./pipe-server";
import { runHookCli, parseHookArgs } from "./hook-cli";
import { ensureHookLauncher, homeDir } from "./settings";
import * as claudeHooks from "./hook-installer";
import * as agentInstallers from "./agent-installer";
import { BackendRelay } from "./backend-relay";
import { pushActionNotifications, wireNotifications, type OpenCard } from "./notifier";

// ── Hook mode: `hi-hook.cmd <event> [--agent x]` ─────────────────────────────
//
// The launcher starts this very app; nothing opens, nothing waits beyond the
// event itself, and the answer (if any) goes to stdout for the agent to read.

const hookArgs = parseHookArgs(process.argv.slice(1));

if (hookArgs) {
  runHookCli(hookArgs)
    .then((code) => app.exit(code))
    .catch(() => app.exit(0));
} else {
  app.whenReady().then(boot);
}

app.on("window-all-closed", () => {
  // The island keeps running: Claude Code's questions are ours to answer.
  onQuit();
});

let quitting = false;
function onQuit(): void {
  if (quitting) return;
  quitting = true;
  relay.stop();
  registry.dispose();
  broker.clear();
  app.exit(0);
}

let registry = new SessionRegistry(() => {});
let broker = new PermissionBroker();
let relay = new BackendRelay();
let pipe: { stop(): void } | null = null;

async function boot(): Promise<void> {
  ensureHookLauncher();

  // Native voice: the island points at its own localhost backend, so mic
  // capture is allowed without prompts for this file:// origin.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "media" || permission === "pointerLock");
  });

  broker = new PermissionBroker();
  registry = new SessionRegistry(handleActions);
  pipe = startPipeRelay(registry, broker);
  startRelay();

  createWindow();
  setupIpc();
  wireNotifications(openIslandCard);
  watchDisplays();
  autoWireHooks();
  pushSnapshot();
}

/// Clicks on notifications: bring the island up around whatever is pending.
function openIslandCard(): void {
  const pending = registry.snapshot().pending;
  expand(720, pending ? 560 : 340);
}

/// The desktop's own backend connection: the renderer logs in (REST), then
/// hands the access token over; decisions from the phone come back here.
function startRelay(): void {
  const url = process.env["HI_BACKEND_URL"] ?? "ws://localhost:8787/ws";
  const rest = url.replace(/^ws/, "http").replace(/\/ws$/, "");
  relay.configure(
    url,
    process.env["HI_ACCESS_TOKEN"] ?? null,
    (frame: { type: string; requestId?: string; decision?: string; answers?: Record<string, string | string[]> }) => {
      if (frame.type !== "coding.decision") return;
      applyPhoneDecision({
        requestId: frame.requestId ?? "",
        decision: frame.decision ?? "",
        ...(frame.answers ? { answers: frame.answers } : {}),
      });
    },
    (event: Record<string, unknown>) => {
      try {
        mainWindow?.webContents.send("hub:event", event);
      } catch {
        // window gone mid-event
      }
    },
  );
  if (!process.env["HI_ACCESS_TOKEN"]) void bootstrapDeviceToken(rest);
  // Tokens are machine-scoped JWTs; if the server restarts and rejects this
  // device's token forever, silently re-bootstrap so the island keeps working.
  setInterval(() => {
    if (process.env["HI_ACCESS_TOKEN"]) return;
    if (relay.currentToken() && Date.now() - relay.lastAuthOkAt < 120_000) return;
    void bootstrapDeviceToken(rest);
  }, 90_000).unref();
}

/// Serverless-pairing: the desktop gets a machine-scoped user token with no UI.
async function bootstrapDeviceToken(rest: string): Promise<void> {
  for (const _ of [0, 1, 2]) {
    try {
      const res = await fetch(`${rest}/api/auth/device-bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: os.hostname() }),
      });
      if (res.status === 200 || res.status === 201) {
        const body = (await res.json()) as { accessToken?: string };
        if (body.accessToken) {
          relay.setAccessToken(body.accessToken);
          pushSnapshot();
          return;
        }
      }
    } catch {
      // backend down; the e2e loop retries
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/// Every registry action: to the renderer, to the broker, to other devices.


function handleActions(actions: RegistryAction[]): void {
  if (!actions.length) return;
  dispatchToRenderer(actions);
  applyActionsToBroker(broker, actions);
  pushActionNotifications(actions);
  pushSnapshot();
}

const isoNow = (): string => new Date().toISOString();

function wireSession(session: import("./registry").Session): import("./backend-relay").CodingSessionWire {
  return {
    id: session.id,
    agent: session.agent,
    sessionId: session.sessionId,
    projectName: session.projectName,
    cwd: session.cwd,
    status: session.status,
    steps: session.steps.map((label) => ({ label, ts: new Date().toISOString() })),
    finalLine: session.finalLine,
    updatedAt: isoNow(),
  };
}

function wireApproval(approval: import("./registry").Approval): import("./backend-relay").CodingApprovalWire {
  return {
    requestId: approval.requestId,
    sessionId: approval.sessionId,
    pillId: approval.pillId,
    agent: approval.pillId.startsWith("agent_") ? approval.pillId.slice(6) : null,
    tool: approval.tool,
    command: approval.command,
    questions: approval.questions,
    createdAt: isoNow(),
  };
}

function pushSnapshot(): void {
  const snap = registry.snapshot();
  relay.setSnapshot(
    snap.sessions.map(wireSession),
    snap.pending ? wireApproval(snap.pending) : null,
  );
}

function dispatchToRenderer(actions: RegistryAction[]): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  win.webContents.send("registry:actions", actions);
}

let mainWindow: BrowserWindow | null = null;

// Island geometry, mu-style: a slim strip at the top center that grows into a
// panel. All values are logical (DIP) so Windows scaling works out of the box.
const STRIP = { w: 300, h: 48 };
const PANEL_W = 720;
const PANEL_H = 340;
const CARD_MAX_H = 640;
const TOP_MARGIN = 0;

/// The display to live on: the one holding the cursor, else the primary.
function targetDisplay(): Electron.Display {
  try {
    const cursor = screen.getCursorScreenPoint();
    return screen.getDisplayNearestPoint(cursor);
  } catch {
    return screen.getPrimaryDisplay();
  }
}

function frame(w: number, h: number): { x: number; y: number; width: number; height: number } {
  const d = targetDisplay();
  const wa = d.workArea;
  const width = Math.min(w, wa.width);
  const height = Math.min(Math.max(h, STRIP.h), CARD_MAX_H);
  return {
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: wa.y + TOP_MARGIN,
    width: Math.round(width),
    height: Math.round(height),
  };
}

/// Animated top-anchored resize: height grows downward from the strip, the
/// window stays centered above the cursor's display. Steps follow an ease-out
/// curve; final setBounds guarantees the exact frame.
function expand(width: number, height: number): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const target = frame(width, height);
  const from = mainWindow.getBounds();
  const end = {
    x: target.x,
    y: target.y,
    width: Math.round(target.width),
    height: Math.round(target.height),
  };
  if (from.width === end.width && from.height === end.height) return;
  const dx = end.x - from.x;
  const dw = end.width - from.width;
  const dh = end.height - from.height;
  const STEPS = 6;
  const DURATION = 200;
  let step = 0;
  const tick = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    step += 1;
    const t = step >= STEPS ? 1 : 1 - Math.pow(1 - step / STEPS, 3);
    mainWindow.setBounds({
      x: Math.round(from.x + dx * t),
      y: from.y,
      width: Math.round(from.width + dw * t),
      height: Math.round(from.height + dh * t),
    });
    if (step < STEPS) setTimeout(tick, DURATION / STEPS);
    else mainWindow.setBounds(end);
  };
  tick();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    ...frame(STRIP.w, STRIP.h),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.on("blur", () => {
    // mu collapses back to the strip on click-away; the renderer decides
    // whether a pending card must stay up.
    mainWindow?.webContents.send("window:blur");
  });
  const dev = !!process.env["HI_RENDERER_URL"];
  if (dev) void mainWindow.loadURL(process.env["HI_RENDERER_URL"]!);
  else void mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

/// Monitoring is default-on: any detected coding agent gets its hooks wired at
/// startup, with backups (un-install stays available in the Agents tab). This
/// is how mu achieves the severed-pipe permission flow without asking twice.
function autoWireHooks(): void {
  const home = currentHome();
  try {
    const claude = claudeHooks.status();
    if (!claude.installed || !claude.hookReady) {
      const plan = claudeHooks.previewInstall(home, true);
      claudeHooks.writeInstall(home, true, plan.fingerprints);
      console.log("[hi] claude code hooks wired automatically");
    }
  } catch (err) {
    console.log(`[hi] claude auto-wire skipped: ${err instanceof Error ? err.message : err}`);
  }
  for (const a of agentInstallers.listAgents()) {
    if (a.approvals) continue;
    try {
      const plan = agentInstallers.previewAgent(a.id, home, true);
      agentInstallers.applyAgent(a.id, home, true, plan.fingerprints);
      console.log(`[hi] ${a.id} hooks wired automatically`);
    } catch (err) {
      console.log(`[hi] ${a.id} auto-wire skipped: ${err instanceof Error ? err.message : err}`);
    }
  }
  ensureHookLauncher();
}

/// The island always lives on the cursor's display: re-apply the frame when
/// monitors change and keep the top strip glued to the top of its screen.
function watchDisplays(): void {
  screen.on("display-metrics-changed", () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    win.setBounds(frame(win.getBounds().width, win.getBounds().height));
  });
}

function setupIpc(): void {
  ipcMain.handle("state:snapshot", () => registry.snapshot());
  ipcMain.on("session:synthetic", (_e, payload: Record<string, unknown>) => {
    registry.ingest(payload as Parameters<typeof registry.ingest>[0]);
    pushSnapshot();
  });
  ipcMain.on("approval:ack", (_e, requestId: string) => {
    if (registry.ack(requestId)) broker.ack(requestId);
    relay.acknowledge(requestId);
  });
  ipcMain.on("approval:answer", (_e, requestId: string, decision: string) => {
    const { decision: word, actions } = registry.answer(requestId, decision);
    dispatchToRenderer(actions);
    if (word) {
      broker.decide(requestId, { word });
      relay.resolve(requestId, word === "allow" ? "allow" : "deny");
      pushSnapshot();
    }
  });
  ipcMain.on("approval:answerQuestion", (_e, requestId: string, answers: Record<string, string | string[]>) => {
    const { answers: valid, actions } = registry.answerQuestion(requestId, answers);
    dispatchToRenderer(actions);
    if (valid) {
      brokerAnswers(broker, requestId, valid);
      relay.resolve(requestId, "allow", valid);
      pushSnapshot();
    }
  });
  ipcMain.on("approval:decline", (_e, requestId: string) => {
    const { actions, declined } = registry.decline(requestId);
    dispatchToRenderer(actions);
    if (declined) applyActionsToBroker(broker, actions);
    pushSnapshot();
  });
  ipcMain.handle("settings:status", () => ({
    claude: claudeHooks.status(),
    agents: agentInstallers.listAgents(),
  }));
  ipcMain.handle("settings:preview", (_e, agent: string, install: boolean) => {
    try {
      const plan =
        agent === "claude"
          ? claudeHooks.previewInstall(currentHome(), install)
          : agentInstallers.previewAgent(agent as agentInstallers.AgentId, currentHome(), install);
      return { ok: true, plan: { ...plan, files: plan.files.join("\n") } };
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) };
    }
  });
  ipcMain.handle("settings:apply", (_e, agent: string, install: boolean, fingerprint: string | string[]) => {
    try {
      const dirs: string[] =
        agent === "claude"
          ? [claudeHooks.writeInstall(currentHome(), install, fingerprint)]
          : agentInstallers.applyAgent(agent as agentInstallers.AgentId, currentHome(), install, fingerprint);
      return { ok: true, backups: dirs.filter(Boolean).join("\n") };
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) };
    }
  });
  ipcMain.on("window:expand", (_e, width: number, height: number) => {
    if (typeof width !== "number" || typeof height !== "number") return;
    expand(width, height);
  });
  ipcMain.on("window:collapse", () => expand(STRIP.w, STRIP.h));
  ipcMain.handle("app:relaunch", () => {
    app.relaunch();
    onQuit();
  });
  // A cross-device answer (phone): validate, then act exactly like a click.
  ipcMain.on("coding:decision", (_e, frame: { requestId: string; decision: string; answers?: Record<string, string> }) => {
    applyPhoneDecision(frame);
  });
  ipcMain.on("presence:paused", (_e, paused: boolean) => {
    registry.setPaused(paused);
    pushSnapshot();
  });
  ipcMain.handle("relay:auth", () => ({ restBase: relay.restBase(), token: relay.currentToken() }));
  ipcMain.on("relay:chat-send", (_e, text: string, conversationId: string | null) => {
    relay.sendChat(String(text ?? ""), conversationId ?? null, `d-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  });
  ipcMain.on("relay:chat-stop", (_e, conversationId: string, messageId: string) => {
    relay.stopChat(String(conversationId), String(messageId));
  });
  ipcMain.handle("cwd:home", () => os.homedir());
  // Native dock controls: system media keys + WinRT track info.
  ipcMain.on("media:action", (_e, kind: string, steps: number) => {
    const known = ["prev", "playPause", "next", "volDown", "volUp", "mute"];
    if (known.includes(String(kind))) mediaRemote.mediaAction(kind as never, Number(steps) || 1);
  });
  ipcMain.handle("media:info", async () => mediaRemote.mediaInfo());
  ipcMain.handle("net:lan-ip", () => {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === "IPv4" && !net.internal) return net.address;
      }
    }
    return "127.0.0.1";
  });
}

/// The phone (or another device of the same user) answered. The registry's own
/// rules — one card, live request only, the documented reply shapes — decide
/// whether it is actionable; nothing is written without it being the live one.
function applyPhoneDecision(frame: {
  requestId: string;
  decision: string;
  answers?: Record<string, string | string[]>;
}): void {
  const { requestId, decision: word, answers } = frame;
  if (!requestId) return;
  if (answers) {
    const { answers: valid, actions } = registry.answerQuestion(requestId, answers);
    dispatchToRenderer(actions);
    if (valid) {
      brokerAnswers(broker, requestId, valid);
      relay.resolve(requestId, "allow", valid);
    }
    pushSnapshot();
    return;
  }
  const { actions, decision: answered } = registry.answer(requestId, word ?? "deny");
  dispatchToRenderer(actions);
  if (answered) {
    broker.decide(requestId, { word: answered });
    relay.resolve(requestId, answered === "allow" ? "allow" : "deny");
  }
  pushSnapshot();
}


let homeOverride: string | null = null;
export function currentHome(): string {
  return homeOverride ?? homeDir();
}

export type { RegistryAction };
