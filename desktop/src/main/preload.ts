// The only bridge between the island's renderer and the main process: typed,
// permission-scoped, nothing else crosses the boundary.

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("hi", {
  snapshot: () => ipcRenderer.invoke("state:snapshot"),
  sessionSynthetic: (payload: Record<string, unknown>) => ipcRenderer.send("session:synthetic", payload),
  onActions: (cb: (actions: unknown[]) => void) => {
    ipcRenderer.on("registry:actions", (_e, actions: unknown[]) => cb(actions));
  },
  ack: (requestId: string) => ipcRenderer.send("approval:ack", requestId),
  answer: (requestId: string, decision: string) => ipcRenderer.send("approval:answer", requestId, decision),
  answerQuestion: (requestId: string, answers: Record<string, string | string[]>) =>
    ipcRenderer.send("approval:answerQuestion", requestId, answers),
  decline: (requestId: string) => ipcRenderer.send("approval:decline", requestId),
  status: () => ipcRenderer.invoke("settings:status"),
  preview: (agent: string, install: boolean) => ipcRenderer.invoke("settings:preview", agent, install),
  apply: (agent: string, install: boolean, fingerprint: string) =>
    ipcRenderer.invoke("settings:apply", agent, install, fingerprint),
  expand: (width: number, height: number) => ipcRenderer.send("window:expand", width, height),
  collapse: () => ipcRenderer.send("window:collapse"),
  onWindowBlur: (cb: () => void) => {
    ipcRenderer.on("window:blur", () => cb());
  },
  relaunch: () => ipcRenderer.invoke("app:relaunch"),
  onHubEvent: (cb: (event: Record<string, unknown>) => void) => {
    ipcRenderer.on("hub:event", (_e, event: Record<string, unknown>) => cb(event));
  },
  sendChat: (text: string, conversationId: string | null) =>
    ipcRenderer.send("relay:chat-send", text, conversationId),
  stopChat: (conversationId: string, messageId: string) =>
    ipcRenderer.send("relay:chat-stop", conversationId, messageId),
  setPaused: (paused: boolean) => ipcRenderer.send("presence:paused", paused),
  restAuth: () => ipcRenderer.invoke("relay:auth") as Promise<unknown>,
  home: () => ipcRenderer.invoke("cwd:home"),
  lanIp: () => ipcRenderer.invoke("net:lan-ip"),
  mediaAction: (kind: string, steps?: number) => ipcRenderer.send("media:action", kind, steps ?? 1),
  mediaInfo: () => ipcRenderer.invoke("media:info") as Promise<unknown>,
});
