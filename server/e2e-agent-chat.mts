// E2E: chat through the uAgents gateway (coordinator → researcher) instead of
// the hub-local runner. Expects text.delta frames from the agent.
import { WebSocket } from "ws";

const email = `e2e-${Date.now()}@hi.local`;
const reg = await fetch("http://localhost:8787/api/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: "e2e-passw0rd-9", displayName: "E2E", deviceKind: "desktop", deviceLabel: "probe" }),
});
if (!reg.ok) throw new Error(`register failed ${reg.status}: ${await reg.text()}`);
const { accessToken } = await reg.json();

const ws = new WebSocket(`ws://localhost:8787/ws?token=${accessToken}&since=0`);
const frames = [];
ws.on("message", (d) => frames.push(JSON.parse(String(d))));
await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });

const event = (f) => (f.type === "event" ? f.event : f.type === "event_ack" ? null : f);
const waitEvent = async (pred, ms, what) => {
  const start = Date.now();
  for (;;) {
    const hit = frames.find(pred);
    if (hit) return hit;
    if (Date.now() - start > ms) throw new Error(`timeout waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

ws.send(JSON.stringify({ type: "chat.send", text: "Research in one short sentence: what is Agentverse hosting?", clientMessageId: `e2e-${Date.now()}` }));
const delta = await waitEvent((f) => event(f)?.type === "chat.delta", 40000, "chat.delta");
const text = String(delta.event.text ?? "");
console.log("delta text sample:", text.slice(0, 120));
const fin = await waitEvent((f) => event(f)?.type === "chat.message" && event(f).message?.role === "assistant" && !event(f).message?.meta?.streaming, 120000, "final");
console.log("final reply:", (fin.event?.message?.content ?? "").slice(0, 240));
console.log("done");
ws.close();
process.exit(0);
