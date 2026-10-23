// Minimal probe: device.hello → ping → pong on the same socket, then chat.send
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const base = "http://127.0.0.1:8787";
const res = await fetch(`${base}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: `${randomUUID().slice(0, 8)}@probe.isle`, password: "island-pass-1" }),
});
const token = ((await res.json()) as { accessToken: string }).accessToken;

const ws = new WebSocket("ws://127.0.0.1:8787/ws");
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "device.hello", token, device: { kind: "desktop", name: "probe", platform: process.platform } }));
});
ws.on("message", (data) => {
  const outer = JSON.parse(String(data)) as { type: string; event?: { type: string; [k: string]: unknown } }; const f = (outer.type === "event" && outer.event ? outer.event : outer) as { type: string; [k: string]: unknown }; console.log("<<", f.type, f.type === "pong" ? "" : JSON.stringify(f).slice(0, 90));
  if (f.type === "hello") ws.send(JSON.stringify({ type: "ping" }));
  if (f.type === "pong") {
    console.log(">> chat.send now");
    ws.send(JSON.stringify({ type: "chat.send", conversationId: null, text: "Say pong back in five words or fewer.", clientMessageId: "probe-1" }));
  }
  if (f.type === "chat.delta") { console.log("PASS-DL"); process.exit(0); }
  if (f.type === "chat.message") {
    const msg = f.message as { role: string; content: string };
    if (msg.role === "assistant" && msg.content) {
      console.log(`PROBE PASS — reply: ${msg.content.slice(0, 60)}`);
      process.exit(0);
    }
  }
});
ws.on("error", (e) => {
  console.log("err", e.message);
  process.exit(1);
});
setTimeout(() => {
  console.log("TIMEOUT: no chat activity (hello/ping may have failed)");
  process.exit(2);
}, 70_000);
