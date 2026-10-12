/**
 * CDP event dispatch, driven against a real WebSocket server on a loopback port.
 *
 * The fakes elsewhere fire their listeners synchronously inside `navigate()`,
 * which cannot model the bug these cover: the redirect that matters arrives as
 * an event *after* the navigation command has already been answered, when no
 * command is in flight to dispatch it. Only a real socket reproduces that.
 */
import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod/v4";
import { BrowserSession, type BrowserPage } from "./auth.js";

// --- wire contract -----------------------------------------------------------

/** A JSON value, as a CDP frame carries it. */
const JsonValueSchema = z.json();

/** One CDP frame: an event, or a reply to a command. */
const CdpFrameSchema = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  sessionId: z.string().optional(),
  result: JsonValueSchema.optional(),
  params: JsonValueSchema.optional(),
});

/** A decoded CDP frame, as the fake browser writes one. */
type CdpFrame = z.infer<typeof CdpFrameSchema>;

/** A JSON value, as a CDP command result carries it. */
type JsonValue = z.infer<typeof JsonValueSchema>;

/** The loopback address a listening server reports. */
const BoundAddressSchema = z.object({ port: z.number() });

/** The id and method of an inbound command; enough to answer it. */
const CdpCommandSchema = z.object({ id: z.number(), method: z.string() });

/** A CDP event frame, built by the fake and decoded by the client under test. */
const CdpEventSchema = z.object({
  method: z.string(),
  sessionId: z.string(),
  params: z.object({
    request: z.object({ url: z.string(), method: z.string(), headers: z.record(z.string(), z.string()) }),
  }),
});

/** Sends one CDP event frame to the attached client. */
type Emit = (event: z.infer<typeof CdpEventSchema>) => void;

/** What the fake browser does once a page session is attached. */
interface FakeBrowserScript {
  pageAttached(sessionId: string, emit: Emit): void;
}

interface FakeBrowser {
  readonly debuggerUrl: string;
  /** Drops every connection, as a browser quitting would. */
  drop: () => Promise<void>;
  close: () => Promise<void>;
}

/** A `Network.requestWillBeSent` frame for `url`, as the request listener reads. */
function requestEvent(sessionId: string, url: string): z.infer<typeof CdpEventSchema> {
  return {
    method: "Network.requestWillBeSent",
    sessionId,
    params: { request: { url, method: "GET", headers: {} } },
  };
}

/** Answers each CDP command as a browser would; `script` then drives the flow. */
async function startFakeBrowser(script: FakeBrowserScript): Promise<FakeBrowser> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const sockets = new Set<WebSocket>();
  let sessionId: string | null = null;

  server.on("connection", (socket: WebSocket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));

    const emit: Emit = (event) => {
      socket.send(JSON.stringify(event));
    };

    const send = (frame: CdpFrame): void => {
      socket.send(JSON.stringify(frame));
    };

    socket.on("message", (raw: WebSocket.RawData) => {
      const command = CdpCommandSchema.parse(JSON.parse(raw.toString()));

      const reply = (result: JsonValue): void => {
        send({ id: command.id, result, sessionId });
      };

      switch (command.method) {
        case "Target.createTarget":
          reply({ targetId: "target-1" });

          return;
        case "Target.attachToTarget": {
          sessionId = "session-1";
          reply({ sessionId });
          script.pageAttached(sessionId, emit);

          return;
        }

        case "Page.navigate":
          // The document has committed. The redirect comes later, on its own,
          // with nothing in flight — which is the case under test.
          reply({ frameId: "frame-1" });

          return;

        case "Runtime.evaluate":
          // Echo the command id as the evaluated value, so a reply crossed onto
          // the wrong command shows up as a wrong result rather than passing.
          reply({ result: { value: command.id } });

          return;

        default:
          reply({});
      }
    });
  });

  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = BoundAddressSchema.parse(server.address());

  const dropAll = (): Promise<void> =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.terminate();
      sockets.clear();
      setTimeout(resolve, 20);
    });

  return {
    debuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/fake`,
    drop: dropAll,
    close: async () => {
      await dropAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Attaches to the fake browser and opens one page on it. */
async function openFakePage(browser: FakeBrowser): Promise<BrowserPage> {
  const session = await BrowserSession.attach(browser.debuggerUrl);

  return session.openPage();
}

/** Waits `ms`, letting any already-queued socket frames be dispatched. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- tests ------------------------------------------------------------------

describe("CDP event dispatch", () => {
  it("delivers a request event that arrives after its navigate reply", async () => {
    const browser = await startFakeBrowser({
      pageAttached: (_sessionId, emit) => {
        setTimeout(() => {
          emit(requestEvent("session-1", "https://login.microsoftonline.com/common/oauth2/nativeclient?code=abc"));
        }, 10);
      },
    });

    try {
      const page = await openFakePage(browser);
      const seen: string[] = [];
      const unsubscribe = page.onRequest((request) => seen.push(request.url));

      await page.navigate("https://login.microsoftonline.com/authorize");
      await settle(100);
      unsubscribe();

      expect(seen).toEqual(["https://login.microsoftonline.com/common/oauth2/nativeclient?code=abc"]);
    } finally {
      await browser.close();
    }
  });

  it("delivers an error redirect once the caller is only awaiting its own promise", async () => {
    const browser = await startFakeBrowser({
      pageAttached: (_sessionId, emit) => {
        setTimeout(() => {
          emit(requestEvent("session-1", "https://login.microsoftonline.com/common/oauth2/nativeclient?error=access_denied"));
        }, 10);
      },
    });

    try {
      const page = await openFakePage(browser);
      const seen: string[] = [];
      page.onRequest((request) => seen.push(request.url));

      await page.navigate("https://login.microsoftonline.com/authorize");
      // Nothing is outstanding on the connection now: the caller is waiting on
      // its own promise for the event that has not been dispatched yet.
      await settle(100);

      expect(seen).toEqual([
        "https://login.microsoftonline.com/common/oauth2/nativeclient?error=access_denied",
      ]);
    } finally {
      await browser.close();
    }
  });

  it("rejects the closed promise promptly when the socket drops mid-flow", async () => {
    const browser = await startFakeBrowser({ pageAttached: () => {} });
    const page = await openFakePage(browser);

    await page.navigate("https://login.microsoftonline.com/authorize");
    const started = Date.now();
    // No command is in flight when the browser goes away, so only the event
    // path can report it: waiting it out is what the 300 s sign-in timer did.
    const hung = new Promise((resolve) => setTimeout(() => resolve("still-open"), 3_000));
    await browser.drop();

    await expect(Promise.race([page.closed, hung])).rejects.toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(2_000);

    await browser.close();
  });

  it("settles concurrent commands against their own replies, not a crossed one", async () => {
    const browser = await startFakeBrowser({
      pageAttached: (_sessionId, emit) => {
        // An interleaved event must never be mistaken for a command's reply.
        setTimeout(() => emit(requestEvent("session-1", "https://example.test/interleaved")), 5);
      },
    });

    try {
      const page = await openFakePage(browser);
      // Each reply carries its own command id as the evaluated value, so a reply
      // delivered to the wrong waiter fails rather than passing quietly. The
      // ids continue the handshake (createTarget, attach, enable, enable,
      // navigate), so these three are the fifth through seventh.

      const results = await Promise.all([
        page.evaluate(() => Promise.resolve(0), null),
        page.evaluate(() => Promise.resolve(1), null),
        page.evaluate(() => Promise.resolve(2), null),
      ]);

      expect(results).toEqual([5, 6, 7]);
    } finally {
      await browser.close();
    }
  });
});
