import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { SessionManager, type SessionCreateRequest } from "./sessions.js";

/**
 * Bun HTTP + WebSocket host for the console. REST manages session lifecycle;
 * one WebSocket per session carries prompts in and supervisor events out, so a
 * turn streams without polling.
 */

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const DEFAULT_PORT = 4173;

const sessionCreateSchema = z
  .object({
    cwd: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
  })
  .loose();

const promptSchema = z.object({ message: z.string().min(1) }).loose();

const socketCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt"), message: z.string().min(1) }),
  z.object({ type: z.literal("abort") }),
]);

interface SocketData {
  readonly sessionId: string;
  unsubscribe: (() => void) | null;
}

export interface WebServerOptions {
  readonly port?: number;
  readonly hostname?: string;
  readonly workspaceDir?: string;
  readonly piBoltCommand?: string;
  readonly piBoltCommandArgs?: readonly string[];
}

export interface RunningWebServer {
  readonly port: number;
  readonly url: string;
  readonly sessions: SessionManager;
  stop(): Promise<void>;
}

/** Content type of a served asset, or null when the name is not one we ship. */
function contentTypeFor(name: string): string | null {
  if (name === "index.html") return "text/html; charset=utf-8";

  if (name === "app.js") return "text/javascript; charset=utf-8";

  if (name === "style.css") return "text/css; charset=utf-8";

  return null;
}

async function serveAsset(pathname: string): Promise<Response> {
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  const contentType = contentTypeFor(name);

  if (contentType === null) return new Response("Not found", { status: 404 });

  const asset = Bun.file(path.join(PUBLIC_DIR, name));

  if (!(await asset.exists())) return new Response("Not found", { status: 404 });

  return new Response(asset, { headers: { "content-type": contentType } });
}

export function startWebServer(options: WebServerOptions = {}): RunningWebServer {
  const requestedPort = options.port ?? (process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT);

  const sessions = new SessionManager({
    command: options.piBoltCommand,
    commandArgs: options.piBoltCommandArgs,
    cwd: options.workspaceDir ?? process.cwd(),
    model: process.env.M365_MODEL,
    provider: process.env.M365_PROVIDER,
  });

  const server = Bun.serve<SocketData>({
    port: requestedPort,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      const segments = url.pathname.split("/").filter((part) => part.length > 0);

      if (url.pathname === "/ws") {
        const sessionId = url.searchParams.get("session") ?? "";

        if (bunServer.upgrade(request, { data: { sessionId, unsubscribe: null } })) {
          return undefined;
        }

        return Response.json({ error: "WebSocket upgrade failed" }, { status: 400 });
      }

      if (segments[0] !== "api") return serveAsset(url.pathname);

      if (segments[1] !== "sessions") return Response.json({ error: "Not found" }, { status: 404 });

      const sessionId = segments[2];

      if (!sessionId) {
        if (request.method === "GET") return Response.json({ sessions: sessions.list() });

        if (request.method === "POST") {
          const parsed = sessionCreateSchema.safeParse(await request.json());

          const created: SessionCreateRequest = parsed.success
            ? {
                cwd: parsed.data.cwd,
                model: parsed.data.model,
                provider: parsed.data.provider,
              }
            : {};

          return Response.json(sessions.create(created), { status: 201 });
        }

        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }

      if (request.method === "DELETE") {
        const closed = await sessions.close(sessionId);

        return closed
          ? Response.json({ closed: sessionId })
          : Response.json({ error: "Unknown session" }, { status: 404 });
      }

      if (request.method === "POST" && segments[3] === "prompts") {
        const parsed = promptSchema.safeParse(await request.json());

        if (!parsed.success) {
          return Response.json({ error: "A message is required" }, { status: 400 });
        }

        const accepted = sessions.prompt(sessionId, parsed.data.message);

        return accepted
          ? Response.json({ accepted: true }, { status: 202 })
          : Response.json({ error: "Unknown session" }, { status: 404 });
      }

      if (request.method === "POST" && segments[3] === "abort") {
        const aborted = sessions.abort(sessionId);

        return aborted
          ? Response.json({ aborted: sessionId })
          : Response.json({ error: "Unknown session" }, { status: 404 });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
    websocket: {
      open(socket) {
        const unsubscribe = sessions.subscribe(socket.data.sessionId, (event) => {
          socket.send(JSON.stringify(event));
        });

        if (unsubscribe === null) {
          socket.close(1011, "Unknown session");

          return;
        }

        socket.data.unsubscribe = unsubscribe;
      },
      message(socket, raw) {
        const command = socketCommandSchema.safeParse(JSON.parse(String(raw)));

        if (!command.success) return;

        if (command.data.type === "prompt") {
          sessions.prompt(socket.data.sessionId, command.data.message);

          return;
        }

        sessions.abort(socket.data.sessionId);
      },
      close(socket) {
        socket.data.unsubscribe?.();
        socket.data.unsubscribe = null;
      },
    },
  });

  const port = server.port ?? requestedPort;

  return {
    port,
    url: `http://${server.hostname}:${port}`,
    sessions,
    async stop() {
      await sessions.closeAll();
      await server.stop(true);
    },
  };
}

if (import.meta.main) {
  const running = startWebServer();

  console.log(`m365-copilot-open-harness console listening on ${running.url}`);

  process.on("SIGINT", () => {
    void running.stop().then(() => {
      process.exit(0);
    });
  });
}
