// Direct CDP screenshot of a live page by its webSocketDebuggerUrl.
// Usage: node scripts/_cdp-shot.mjs <wsUrl> <out.png>
import { writeFileSync } from "node:fs";
const wsMod = await import("../packages/core/node_modules/ws/wrapper.mjs");
const WebSocket = wsMod.default ?? wsMod.WebSocket;

const [wsUrl, out] = process.argv.slice(2);
if (!wsUrl || !out) { console.error("usage: node _cdp-shot.mjs <ws> <out.png>"); process.exit(1); }

const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.on("message", (d) => {
  const m = JSON.parse(String(d));
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
});
ws.on("open", async () => {
  try {
    await send("Page.enable");
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(out, Buffer.from(data, "base64"));
    console.log("[cdp] wrote", out);
  } catch (e) { console.error("[cdp] ERR", e.message); }
  ws.close();
  process.exit(0);
});
setTimeout(() => { console.error("[cdp] timeout"); process.exit(1); }, 20000);
