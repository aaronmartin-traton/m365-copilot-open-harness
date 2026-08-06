import { describe, expect, it } from "vitest";
import {
  M365WebConversationClient,
  M365WebConversationError,
  M365WebSessionUnavailableError,
} from "./web-conversations.js";

function fakeBrowser(responses: Array<{ status: number; body: unknown }>, finalUrl = "https://m365.cloud.microsoft/chat/") {
  const requests: unknown[] = [];
  const bodies: unknown[] = [];
  let listener: ((request: unknown) => void) | undefined;
  let closed = false;
  const page = {
    on: (_event: string, callback: (request: unknown) => void) => { listener = callback; },
    off: () => { listener = undefined; },
    goto: async () => {
      listener?.({ method: () => "POST", url: () => "https://m365.cloud.microsoft/chat", headers: () => ({
        "x-client-eligibility": "eligibility",
        "x-host-context": "host",
        "x-route-id": "route",
        "x-session-id": "session",
        authorization: "must-not-forward",
      }) });
    },
    url: () => finalUrl,
    evaluate: async (_fn: unknown, arg: { body: unknown }) => {
      requests.push(arg.body);
      bodies.push(arg.body);
      const response = responses.shift();
      if (!response) throw new Error("unexpected browser fetch");
      return response;
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    close: async () => { closed = true; },
  };
  return { context, requests, bodies, get closed() { return closed; } };
}

describe("M365WebConversationClient", () => {
  it("refreshes, deletes exactly once, refreshes, and closes the browser", async () => {
    const fake = fakeBrowser([
      { status: 200, body: { store: { conversationPageHistoryList: { chats: [{ conversationId: "target" }] } } } },
      { status: 200, body: {} },
      { status: 200, body: { store: { conversationPageHistoryList: { chats: [] } } } },
    ]);
    const client = new M365WebConversationClient({
      profileDir: "profile",
      launchPersistentContext: async () => fake.context as never,
    });
    await client.deleteConversation({ conversationId: "target" });
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests[1]).toMatchObject({ action: "DeleteConversation", conversationId: "target", state: {
      conversationPageHistoryList: { chats: [{ conversationId: "target" }] },
      chatLandingPageHistoryList: null,
      tasksHub: null,
      tasksFlyout: null,
    } });
    expect(fake.closed).toBe(true);
  });

  it("fails closed when the target is not in the refreshed list", async () => {
    const fake = fakeBrowser([{ status: 200, body: { store: { conversationPageHistoryList: { chats: [] } } } }]);
    const client = new M365WebConversationClient({ launchPersistentContext: async () => fake.context as never });
    await expect(client.deleteConversation({ conversationId: "missing" })).rejects.toMatchObject({ code: "target_missing" });
    expect(fake.requests).toHaveLength(1);
    expect(fake.closed).toBe(true);
  });

  it("rejects a sign-in redirect without attempting credentials", async () => {
    const fake = fakeBrowser([], "https://login.microsoftonline.com/common/oauth2/authorize");
    const client = new M365WebConversationClient({ launchPersistentContext: async () => fake.context as never });
    await expect(client.deleteConversation({ conversationId: "target" })).rejects.toBeInstanceOf(M365WebSessionUnavailableError);
    expect(fake.closed).toBe(true);
  });

  it("preserves remote failure status and closes", async () => {
    const fake = fakeBrowser([
      { status: 200, body: { store: { conversationPageHistoryList: { chats: [{ conversationId: "target" }] } } } },
      { status: 403, body: {} },
    ]);
    const client = new M365WebConversationClient({ launchPersistentContext: async () => fake.context as never });
    await expect(client.deleteConversation({ conversationId: "target" })).rejects.toEqual(expect.objectContaining({
      code: "delete_failed",
    } satisfies Partial<M365WebConversationError>));
    expect(fake.requests).toHaveLength(2);
    expect(fake.closed).toBe(true);
  });
});
