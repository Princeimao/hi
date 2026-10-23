// E2E: the device path — connect as a desktop device, say hello, then send
// chat.send the same way the island does and verify deltas + final message
// stream back over the device socket.
import WebSocket, { type MessageEvent } from "ws";
import { randomUUID } from "node:crypto";

const base = "http://127.0.0.1:8787";

async function register(): Promise<string> {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${randomUUID().slice(0, 8)}@dev.isle`, password: "island-pass-1" }),
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`register: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

function connectDevice(token: string, name: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:8787/ws");
    const timer = setTimeout(() => reject(new Error("device handshake timeout")), 10_000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "device.hello", token, device: { kind: "desktop", name, platform: process.platform } }));
    };
    ws.onmessage = (e: MessageEvent) => {
      const f = JSON.parse(String(e.data)) as { type: string };
      if (f.type === "hello") {
        clearTimeout(timer);
        resolve(ws);
      }
    };
    ws.onerror = () => reject(new Error("device connect failed"));
  });
}

const token = await register();
const device = await connectDevice(token, "e2e-isle");
let deltas = 0;
let finalText = "";
let sawUserMsg = false;
let sawThinking = false;

const done = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no reply after ${deltas} deltas (user=${sawUserMsg} thinking=${sawThinking} final="${finalText.slice(0, 80)}")`)), 75_000);
  device.on("message", (data) => {
    const f = JSON.parse(String(data)) as { type: string; [k: string]: unknown };
    if (f.type === "chat.delta") deltas += 1;
    else if (f.type === "avatar.state" && f.state === "thinking") sawThinking = true;
    else if (f.type === "chat.message") {
      const msg = f.message as { role: string; content: string; meta?: { streaming?: boolean } };
      if (msg.role === "user") sawUserMsg = true;
      if (msg.role === "assistant" && msg.meta?.streaming !== true) {
        finalText = msg.content;
        clearTimeout(timer);
        resolve();
      }
    }
  });
});

device.send(JSON.stringify({ type: "chat.send", conversationId: null, text: "In one short sentence: what is the tallest mountain on Earth?", clientMessageId: "isle-1" }));

await done;

console.log(`DEVICE-ISLAND PATH PASS — deltas=${deltas} final="${finalText.slice(0, 120)}"`);
device.close();
process.exit(0);
