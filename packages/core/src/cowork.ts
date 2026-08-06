import WebSocket from "ws";
import { getTokenForScope } from "./auth.js";
import { decodeJwt } from "./copilot.js";
import { decodeSocketPacket } from "./cowork-protocol.js";

const COWORK_SCOPE = ["6ab48b67-cd74-4ad4-81af-5932984589be/.default"];
const IC3_SCOPE = ["https://ic3.teams.office.com/.default"];
const REGISTRAR_URL = "https://edge.skype.com/registrar/prod/V3/registrations";
const DEFAULT_CONTAINER_CONFIG = "renderUi=true;searchBackend=bing;citationsEnabled=true;acceptLanguage=en-US;model=fable-5:claude";

export interface CoworkProbeOptions {
  runtimeHost?: string;
  trouterHost?: string;
  timeoutMs?: number;
  conversationId?: string;
  containerConfig?: string;
}

export interface CoworkProbeResult {
  text: string;
  conversationId: string;
  deliveries: number;
}

export async function runCoworkProbe(prompt: string, options: CoworkProbeOptions = {}): Promise<CoworkProbeResult> {
  const runtimeHost = options.runtimeHost ?? process.env.M365_COWORK_RUNTIME_HOST;
  if (!runtimeHost) throw new Error("M365_COWORK_RUNTIME_HOST is required; capture the tenant routing host from m365.cloud.microsoft before probing Cowork");
  const trouterHost = options.trouterHost ?? process.env.M365_COWORK_TROUTER_HOST ?? "go-eu.trouter.teams.microsoft.com";
  const timeoutMs = options.timeoutMs ?? Number(process.env.M365_COWORK_TIMEOUT_MS ?? 180_000);
  const [coworkToken, ic3Token] = await Promise.all([
    getTokenForScope(COWORK_SCOPE),
    getTokenForScope(IC3_SCOPE),
  ]);
  if (!coworkToken || !ic3Token) throw new Error("Cowork or IC3 token acquisition failed");
  const claims = decodeJwt(coworkToken);
  const conversationId = options.conversationId ?? `${claims.tid}:${claims.oid}:${crypto.randomUUID()}`;
  return receiveCoworkReply({
    prompt,
    runtimeHost,
    trouterHost,
    timeoutMs,
    conversationId,
    containerConfig: options.containerConfig ?? DEFAULT_CONTAINER_CONFIG,
    coworkToken,
    ic3Token,
    oid: claims.oid,
  });
}

interface ReceiveInput {
  prompt: string;
  runtimeHost: string;
  trouterHost: string;
  timeoutMs: number;
  conversationId: string;
  containerConfig: string;
  coworkToken: string;
  ic3Token: string;
  oid: string;
}

async function receiveCoworkReply(input: ReceiveInput): Promise<CoworkProbeResult> {
  const epid = crypto.randomUUID();
  const correlationId = crypto.randomUUID();
  const tc = encodeURIComponent(JSON.stringify({ cv: "2025.30.01.1", ua: "BizChat", hr: "", v: "3639/1.0.0" }));
  const wsUrl = `wss://${input.trouterHost}/v4/c?tc=${tc}&timeout=40&epid=${epid}&ccid=&dom=m365.cloud.microsoft&cor_id=${correlationId}&con_num=${Date.now()}_0`;
  const socket = new WebSocket(wsUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  let deliveries = 0;
  let settled = false;

  return new Promise<CoworkProbeResult>((resolve, reject) => {
    const finish = (error?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(ping);
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve({ text: text ?? "", conversationId: input.conversationId, deliveries });
    };
    const timeout = setTimeout(() => finish(new Error(`Cowork reply timed out after ${input.timeoutMs}ms (deliveries=${deliveries})`)), input.timeoutMs);
    const ping = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(socketEvent("ping", []));
    }, 15_000);
    socket.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    socket.on("message", async (raw) => {
      try {
        const frame = raw.toString();
        if (frame.startsWith("1::")) {
          socket.send(socketEvent("user.authenticate", [{ headers: { Authorization: `Bearer ${input.ic3Token}`, "X-MS-Migration": "True" } }]));
          return;
        }
        const packet = decodeSocketPacket(frame);
        const payload = packet.data ? safeJson(packet.data) : null;
        if (packet.type === 5 && payload?.name === "trouter.connected") {
          const info = payload.args?.[0] ?? {};
          await registerEndpoint(epid, info.surl, input.ic3Token);
          await sendCoworkMessage(input);
          return;
        }
        if (packet.type !== 3 || !payload?.method || payload.status) return;
        deliveries++;
        socket.send(socketMessage(buildDeliveryAck(payload)));
        const event = typeof payload.body === "string" ? safeJson(payload.body) : null;
        const resource = event?.resource;
        if (resource?.messagetype !== "RichText/Copilot_AgentResponse") return;
        const properties = resource.properties ?? {};
        const text = typeof resource.content === "string" && resource.content
          ? resource.content
          : (properties.copilotTextSegments ?? []).map((segment: any) => segment?.text ?? "").join("");
        if (properties.copilotTaskState === "completed") finish(undefined, text);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function registerEndpoint(epid: string, surl: string | undefined, token: string): Promise<void> {
  if (!surl) throw new Error("Trouter did not return a registrar path");
  const response = await fetch(REGISTRAR_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      clientDescription: {
        appId: "bizchat", aesKey: "", languageId: "en-US", platform: "3639/1.0.0",
        templateKey: "bizchat_5.0", platformUIVersion: "3639/1.0.0", productContext: "COPILOT",
      },
      registrationId: epid,
      nodeId: "",
      transports: { TROUTER: [{ context: "", path: surl, ttl: 3600 }] },
    }),
  });
  if (!response.ok) throw new Error(`Cowork Trouter registration failed: HTTP ${response.status}`);
}

async function sendCoworkMessage(input: ReceiveInput): Promise<void> {
  const response = await fetch(`https://${input.runtimeHost}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.coworkToken}`,
      "Content-Type": "application/json",
      Origin: "https://m365.cloud.microsoft",
      "X-User-ID": input.oid,
      "X-Container-Config": input.containerConfig,
    },
    body: JSON.stringify({
      connectorsConfig: { connectors: [], include_defaults: true, packages: [] },
      content: [{ text: input.prompt, type: "text" }],
      conversationId: input.conversationId,
      messageId: crypto.randomUUID(),
      role: "user",
    }),
  });
  if (!response.ok) throw new Error(`Cowork send failed: HTTP ${response.status} ${await response.text()}`);
}

function socketEvent(name: string, args: unknown[]): string {
  return `5:::${JSON.stringify({ name, args })}`;
}

function socketMessage(value: unknown): string {
  return `3:::${JSON.stringify(value)}`;
}

function buildDeliveryAck(delivery: any) {
  const headers: Record<string, unknown> = { "trouter-client": { cd: 1 } };
  for (const name of ["MS-CV", "trouter-request"]) {
    if (delivery.headers?.[name] !== undefined) headers[name] = delivery.headers[name];
  }
  return { id: delivery.id, status: 200, headers, body: "" };
}

function safeJson(value: string): any {
  try { return JSON.parse(value); } catch { return null; }
}
