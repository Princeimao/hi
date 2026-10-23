// Quick friend message test against ASI1-Mini (Fetch.ai-hosted chat agent).
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const base = "http://127.0.0.1:8787";
const addr = "agent1qdhaqxdvjhtchfmra6ycwjt7p3dj7ucq2ccnx2ppk4pa5mde4kc0ghep43j";
const reg = await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${randomUUID().slice(0, 8)}@asi.test`, password: "password-1234" }) });
const regj = await reg.json() as { accessToken?: string; error?: string };
console.log("register:", reg.status, JSON.stringify(regj).slice(0, 120));
const tok = regj.accessToken!;
const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };

const conn = await fetch(`${base}/api/friends`, { method: "POST", headers: H, body: JSON.stringify({ address: addr, name: "ASI1-Mini Agent" }) });
console.log("connect:", conn.status);
if (conn.status === 409) { /* already connected */ }
const list = (await (await fetch(`${base}/api/friends`, { headers: H })).json()) as { id: string; address: string }[];
const f = list.find((x) => x.address === addr)!;
console.log("friend id:", f.id);

const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${tok}`);
await new Promise((r) => ws.on("open", r));
const done = new Promise<void>((resolve, reject) => {
  setTimeout(() => reject(new Error("no reply within 120s")), 120_000);
  ws.on("message", (data) => {
    const e = JSON.parse(String(data));
    if (e.type === "event") {
      if (e.event.type === "friend.reply") {
        console.log("REPLY:", String(e.event.text).slice(0, 200));
        resolve();
      }
      if (e.event.type === "friend.error") {
        console.log("ERROR:", e.event.reason);
        resolve();
      }
    }
  });
});

const m = await fetch(`${base}/api/friends/${f.id}/message`, { method: "POST", headers: H, body: JSON.stringify({ text: "hello, reply in one short sentence" }) });
console.log("send:", m.status);
if (m.status !== 201) console.log(await m.text());
await done;
ws.close();
process.exit(0);
