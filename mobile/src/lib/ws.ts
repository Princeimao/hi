import { getAccessToken, getApiUrl } from "./api";

type Listener = (event: any) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let reconnectTimer: any = null;
let pingTimer: any = null;

export function onEvent(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function emitLocal(event: any) {
  listeners.forEach((cb) => {
    try {
      cb(event);
    } catch {}
  });
}

function clearTimers() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

export async function connectWs(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const base = await getApiUrl();
  const token = await getAccessToken();
  if (!token) return;

  const wsBase = base.replace(/^https?/i, (scheme) => scheme.toLowerCase() === "https" ? "wss" : "ws");
  const wsUrl = `${wsBase}/ws?token=${encodeURIComponent(token)}`;

  try {
    socket = new WebSocket(wsUrl);
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: "ping" }));
        } catch {}
      }
    }, 25000);
  };

  socket.onmessage = (e) => {
    try {
      const data = JSON.parse(String(e.data));
      // Backend wraps live and persistent events in EventEnvelope { type: "event", id, ts, event }
      const ev = data && typeof data === "object" && data.type === "event" && data.event
        ? data.event
        : data;
      listeners.forEach((cb) => {
        try {
          cb(ev);
        } catch (cbErr) {
          console.warn("[ws] listener error:", cbErr);
        }
      });
    } catch {}
  };

  socket.onclose = () => {
    cleanupSocket();
    scheduleReconnect();
  };

  socket.onerror = () => {
    try {
      socket?.close();
    } catch {}
  };
}

function cleanupSocket() {
  socket = null;
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectWs();
    }, 3500);
  }
}

export function sendWs(frame: any): boolean {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function disconnectWs(): void {
  clearTimers();
  if (socket) {
    try {
      socket.close();
    } catch {}
    socket = null;
  }
}