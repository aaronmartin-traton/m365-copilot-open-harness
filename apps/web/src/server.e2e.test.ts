import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SupervisorEvent } from "@m365-copilot/harness";
import { describe, expect, it } from "vitest";

import { startWebServer, type RunningWebServer } from "./server.js";

/**
 * End-to-end coverage for the console: a real Bun HTTP server, a real
 * WebSocket, and a real child process on the far side of the harness. The
 * child is the protocol stand-in, so what is under test is the transport and
 * the event mapping the browser depends on. Hangs are caught by the test
 * timeout, not by a timer of our own.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const STUB_PI_BOLT = path.join(
  REPO_ROOT,
  "packages",
  "harness",
  "src",
  "testing",
  "stub-pi-bolt.mjs",
);

const TURN_TIMEOUT_MS = 20_000;

function bootServer(): RunningWebServer {
  return startWebServer({
    port: 0,
    piBoltCommand: process.execPath,
    piBoltCommandArgs: [STUB_PI_BOLT],
  });
}

async function createSession(server: RunningWebServer): Promise<string> {
  const response = await fetch(`${server.url}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  expect(response.status).toBe(201);

  const session = await response.json();

  return session.id;
}

async function openSocket(server: RunningWebServer, sessionId: string): Promise<WebSocket> {
  const socket = new WebSocket(`${server.url.replace("http", "ws")}/ws?session=${sessionId}`);

  await new Promise<void>((resolve) => {
    socket.addEventListener("open", () => {
      resolve();
    });
  });

  return socket;
}

function collectTurn(socket: WebSocket, prompt: string): Promise<SupervisorEvent[]> {
  return new Promise<SupervisorEvent[]>((resolve) => {
    const events: SupervisorEvent[] = [];

    socket.addEventListener("message", (message) => {
      const event: SupervisorEvent = JSON.parse(String(message.data));

      events.push(event);

      if (event.kind === "settled") resolve(events);
    });

    socket.send(JSON.stringify({ type: "prompt", message: prompt }));
  });
}

function assistantText(events: readonly SupervisorEvent[]): string {
  return events.flatMap((event) => (event.kind === "text" ? [event.delta] : [])).join("");
}

describe("web console", () => {
  it(
    "serves the console and streams a turn over the session socket",
    { timeout: TURN_TIMEOUT_MS },
    async () => {
      const server = bootServer();

      try {
        const page = await fetch(`${server.url}/`);

        expect(page.status).toBe(200);
        expect(await page.text()).toContain("M365 Copilot Open Harness");

        const script = await fetch(`${server.url}/app.js`);

        expect(script.status).toBe(200);
        expect(script.headers.get("content-type")).toContain("javascript");

        const sessionId = await createSession(server);

        expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);

        const socket = await openSocket(server, sessionId);
        const events = await collectTurn(socket, "hello console");

        expect(assistantText(events)).toBe("stub-reply:hello console");
        expect(
          events.some((event) => event.kind === "record" && event.record.type === "tool_start"),
        ).toBe(true);

        socket.close();
      } finally {
        await server.stop();
      }
    },
  );

  it(
    "creates, lists, prompts and closes sessions over REST",
    { timeout: TURN_TIMEOUT_MS },
    async () => {
      const server = bootServer();

      try {
        const sessionId = await createSession(server);
        const listed = await fetch(`${server.url}/api/sessions`);

        expect(listed.status).toBe(200);
        expect((await listed.json()).sessions[0].id).toBe(sessionId);

        const prompted = await fetch(`${server.url}/api/sessions/${sessionId}/prompts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "rest turn" }),
        });

        expect(prompted.status).toBe(202);

        const rejected = await fetch(`${server.url}/api/sessions/${sessionId}/prompts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "" }),
        });

        expect(rejected.status).toBe(400);

        const closed = await fetch(`${server.url}/api/sessions/${sessionId}`, { method: "DELETE" });

        expect(closed.status).toBe(200);
        expect((await (await fetch(`${server.url}/api/sessions`)).json()).sessions).toEqual([]);
      } finally {
        await server.stop();
      }
    },
  );
});
