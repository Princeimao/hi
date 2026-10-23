// E2E: Agentverse discovery → connect → send → delivered → reply, all real.
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const base = "http://127.0.0.1:8787";

async function register(): Promise<string> {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${randomUUID().slice(0, 8)}@friends.io`, password: "friends-pass-1" }),
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`register: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

const token = await register();
const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

// 1) discovery (official Agentverse search API, proxied)
const searchRes = await fetch(`${base}/api/friends/discover?q=${encodeURIComponent("chat assistant agent")}&limit=6`, { headers: H });
if (searchRes.status !== 200) throw new Error(`discover: ${searchRes.status} ${await searchRes.text()}`);
const hits = (await searchRes.json()) as { address: string; name: string; status: string; interactions: number }[];
console.log(`discover: ${hits.length} hits:`, hits.map((h) => `${h.name} [${h.status}] (${h.interactions})`).join(" | "));
if (hits.length === 0) throw new Error("no agents found");

// 2) facts
const pick = hits.filter((h) => h.status === "active")[0];
const facts = await fetch(`${base}/api/friends/facts?address=${pick.address}`, { headers: H });
console.log(`facts(${pick.name}):`, JSON.stringify(await facts.json()).slice(0, 160));

// 3) connect
const connectRes = await fetch(`${base}/api/friends`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ address: pick.address, name: pick.name, readme: "", status: pick.status }),
});
if (connectRes.status !== 201) throw new Error(`connect: ${connectRes.status} ${await connectRes.text()}`);
const friend = (await connectRes.json()) as { id: string; name: string };
console.log(`connected: ${friend.name} (${friend.id})`);

// 4) duplicate connect must refuse
const dup = await fetch(`${base}/api/friends`, { method: "POST", headers: H, body: JSON.stringify({ address: pick.address, name: "x" }) });
console.log(`duplicate connect -> ${dup.status} (want 409)`);
if (dup.status !== 409) throw new Error("duplicate connect was allowed");

// 5) list + history empty
const list = await fetch(`${base}/api/friends`, { headers: H });
const friends = (await list.json()) as unknown[];
if (friends.length !== 1) throw new Error(`list: expected 1, got ${friends.length}`);

// 6) send + wait for reply over WS
const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${token}`);
await new Promise((r) => ws.on("open", r));
let delivered = false;
const done = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no reply in 150s (delivered=${delivered})`)), 150_000);
  ws.on("message", async (data) => {
    const env = JSON.parse(String(data)) as { type: string; id?: number; event?: { type: string; [k: string]: unknown } };
    const ev = env.type === "event" && env.event ? env.event : env;
    if (ev.type === "friend.delivered") {
      delivered = true;
      console.log("DELIVERED (ack from agent)");
      return;
    }
    if (ev.type === "friend.reply") {
      console.log(`REPLY: ${String(ev["text"]).slice(0, 140)}`);
      clearTimeout(timer);
      resolve();
      return;
    }
    if (ev.type === "friend.error") {
      console.log(`ERROR: ${String(ev["reason"])}`);
      clearTimeout(timer);
      reject(new Error(`friend.error: ${String(ev["reason"])}`));
    }
  });
});
const msgRes = await fetch(`${base}/api/friends/${friend.id}/message`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ text: "In one short sentence introduce yourself and what you can do." }),
});
if (msgRes.status !== 201) throw new Error(`send: ${msgRes.status} ${await msgRes.text()}`);
console.log("message queued");

await done;
const history = await fetch(`${base}/api/friends/${friend.id}/messages`, { headers: H });
const rows = (await history.json()) as { role: string; state: string }[];
console.log(`history: ${rows.length} rows:`, rows.map((r) => `${r.role}:${r.state}`).join(", "));

console.log("FRIENDS E2E PASS");
ws.close();
process.exit(0);
