// CDP navigate a page then screenshot. Usage: node _cdp-nav.mjs <wsUrl> <url> <out.png>
import { writeFileSync } from "node:fs";
const wsMod = await import("../packages/core/node_modules/ws/wrapper.mjs");
const WebSocket = wsMod.default ?? wsMod.WebSocket;
const [wsUrl, url, out] = process.argv.slice(2);
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
const send = (m, p={}) => new Promise((res,rej)=>{const i=++id; pending.set(i,{res,rej}); ws.send(JSON.stringify({id:i,method:m,params:p}));});
ws.on("message", d=>{const m=JSON.parse(String(d)); if(m.id&&pending.has(m.id)){const{res,rej}=pending.get(m.id); pending.delete(m.id); m.error?rej(new Error(m.error.message)):res(m.result);}});
ws.on("open", async ()=>{
  try{
    await send("Page.enable");
    await send("Page.navigate", {url});
    await new Promise(r=>setTimeout(r,8000));
    const {data} = await send("Page.captureScreenshot", {format:"png"});
    writeFileSync(out, Buffer.from(data,"base64"));
    console.log("[nav] wrote",out);
  }catch(e){console.error("[nav] ERR",e.message);}
  ws.close(); process.exit(0);
});
setTimeout(()=>{console.error("[nav] timeout");process.exit(1);},30000);
