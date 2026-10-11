import WebSocket from "ws";
import { z } from "zod";
import { getTokenForScope } from "./auth.js";
import { decodeJwt } from "./copilot.js";
import { decodeSocketPacket } from "./cowork-protocol.js";

const COWORK_SCOPE = ["6ab48b67-cd74-4ad4-81af-5932984589be/.default"];

const IC3_SCOPE = ["https://ic3.teams.office.com/.default"];

const REGISTRAR_URL = "https://edge.skype.com/registrar/prod/V3/registrations";

const DEFAULT_CONTAINER_CONFIG = "renderUi=true;searchBackend=bing;citationsEnabled=true;acceptLanguage=en-US;model=fable-5:claude";

// --- Wire vocabulary ---
// Every field on the Trouter socket is JSON, so the frames are modelled as JSON
// rather than an open `unknown` bag: the recursive value type is the contract,
// and the schemas below parse a frame into the fields this probe dispatches on.
// A field Trouter mistypes reads as absent, so one odd value never costs us the
// whole frame.

/** Any JSON value: what `JSON.parse` yields for a Trouter frame field. */
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A JSON object — the shape of a Trouter frame field. */
interface JsonObject {
  [key: string]: JsonValue;
}

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** A `5:::` event frame, including the `trouter.connected` handshake. */
const TrouterEventFrame = z.object({
  name: z.string().optional().catch(undefined),
  args: z.array(z.object({ surl: z.string().optional().catch(undefined) })).optional().catch(undefined),
});

/** A `3:::` delivery frame: the message this probe acknowledges and reads. */
const TrouterDeliveryFrame = z.object({
  method: z.string().optional().catch(undefined),
  id: z.string().optional().catch(undefined),
  status: JsonValueSchema.optional(),
  headers: z.record(z.string(), JsonValueSchema).optional().catch(undefined),
  body: z.string().optional().catch(undefined),
});

type TrouterDelivery = z.infer<typeof TrouterDeliveryFrame>;

/** A delivery ack's header values, keyed by header name. */
interface DeliveryAckHeaders {
  [key: string]: JsonValue;
}

/** The ack sent back for a `3:::` delivery frame. */
interface DeliveryAck {
  id?: string;
  status: number;
  headers: DeliveryAckHeaders;
  body: string;
}

/** One `properties.copilotTextSegments` entry: only `text` is read. An entry of
 *  another type reads as an entry with no text, as `segment?.text` did. */
const CopilotTextSegment = z
  .object({
    text: z.string().optional().catch(undefined),
  })
  .catch({});

/** The Copilot agent resource carried in a delivery body. */
const CopilotAgentResource = z.object({
  messagetype: z.string().optional().catch(undefined),
  content: z.string().optional().catch(undefined),
  properties: z
    .object({
      copilotTaskState: z.string().optional().catch(undefined),
      copilotTextSegments: z.array(CopilotTextSegment).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

/** A delivery body: the message activity whose `resource` carries the reply. */
const DeliveryBody = z.object({
  resource: CopilotAgentResource.optional().catch(undefined),
});

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

        if (packet.type === 5) {
          const event = TrouterEventFrame.safeParse(safeJson(packet.data));

          if (event.success && event.data.name === "trouter.connected") {
            await registerEndpoint(epid, event.data.args?.[0]?.surl, input.ic3Token);
            await sendCoworkMessage(input);
          }

          return;
        }

        if (packet.type !== 3) return;
        const delivery = TrouterDeliveryFrame.safeParse(safeJson(packet.data));

        if (!delivery.success || !delivery.data.method || delivery.data.status) return;
        deliveries++;
        socket.send(socketMessage(buildDeliveryAck(delivery.data)));
        const body = delivery.data.body;

        if (body === undefined) return;
        const activity = DeliveryBody.safeParse(safeJson(body));

        if (!activity.success) return;
        const resource = activity.data.resource;

        if (resource?.messagetype !== "RichText/Copilot_AgentResponse") return;
        const properties = resource.properties ?? {};

        const text = resource.content
          ? resource.content
          : (properties.copilotTextSegments ?? []).map((segment) => segment.text ?? "").join("");

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

function socketEvent(name: string, args: JsonValue[]): string {
  return `5:::${JSON.stringify({ name, args })}`;
}

function socketMessage(value: DeliveryAck): string {
  return `3:::${JSON.stringify(value)}`;
}

function buildDeliveryAck(delivery: TrouterDelivery): DeliveryAck {
  const headers: DeliveryAckHeaders = { "trouter-client": { cd: 1 } };

  for (const name of ["MS-CV", "trouter-request"]) {
    if (delivery.headers?.[name] !== undefined) headers[name] = delivery.headers[name];
  }

  return { id: delivery.id, status: 200, headers, body: "" };
}

/** The JSON a frame field carries; `undefined` when the text is not JSON. */
function safeJson(value: string): JsonValue | undefined {
  try { return JSON.parse(value); } catch { return undefined; }
}
