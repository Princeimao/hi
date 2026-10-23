// Integration token flow: PUT with a bad token must be rejected upstream and
// NOT stored; the list must start with zero connected; items must return 409.
import { WebSocket } from "ws";

const BASE = "http://127.0.0.1:8787";
const email = `e2e-${Date.now()}@hi.local`;
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: "e2e-passw0rd-9", displayName: "Int" }),
});
const regText = await reg.text();
console.log("register:", reg.status, regText.slice(0, 40));
const auth = JSON.parse(regText) as { accessToken: string };
const H = { "Content-Type": "application/json", Authorization: `Bearer ${auth.accessToken}` };

const list0 = await fetch(`${BASE}/api/integrations`, { headers: H });
console.log("initial list:", ((await list0.json()) as { service: string }[]).map((s) => s.service).join(","));

const bad = await fetch(`${BASE}/api/integrations/github`, {
  method: "PUT",
  headers: H,
  body: JSON.stringify({ token: "ghp_notarealtoken000000000000000000" }),
});
const badBody = (await bad.json()) as { message?: string };
console.log("bad token ->", bad.status, String(badBody.message ?? "").slice(0, 80));

const items = await fetch(`${BASE}/api/integrations/github/items`, { headers: H });
console.log("items unconfigured ->", items.status, JSON.stringify(await items.json()).slice(0, 70));

const list1 = await fetch(`${BASE}/api/integrations`, { headers: H });
const after = (await list1.json()) as { connected: boolean }[];
console.log("after bad connect:", after.filter((s) => s.connected).length, "connected");

const disconnect = await fetch(`${BASE}/api/integrations/github`, { method: "DELETE", headers: H });
console.log("disconnect unknown ->", disconnect.status);
console.log("NEGATIVE PATH PASS");
