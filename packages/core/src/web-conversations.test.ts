import { describe, expect, it } from "vitest";
import type { BrowserRequest } from "./auth.js";
import {
  M365WebConversationClient,
  M365WebConversationError,
  M365WebSessionUnavailableError,
  type M365ChatFetchInput,
  type M365ChatPageFunction,
  type M365WebBrowser,
  type M365WebPage,
} from "./web-conversations.js";

/** A chat entry the fake navigation payload exposes. */
type FakeChat = { conversationId: string };

/** A canned navigation payload the fake page serves back to the client. */
type FakeNavigationPayload = {
  store?: { conversationPageHistoryList?: { chats: FakeChat[] } };
};

/** A canned `/chat` response the fake page hands back. */
type FakeResponse = { status: number; body: FakeNavigationPayload };

/** The JSON body the client posts to `/chat`. */
type FakeRequest = M365ChatFetchInput["body"];

function fakeBrowser(responses: FakeResponse[], finalUrl = "https://m365.cloud.microsoft/chat/") {
  const requests: FakeRequest[] = [];
  let listener: ((request: BrowserRequest) => void) | undefined;
  let closed = false;

  const page: M365WebPage = {
    onRequest: (callback) => {
      listener = callback;

      return () => {
        listener = undefined;
      };
    },
    navigate: async () => {
      listener?.({
        url: "https://m365.cloud.microsoft/chat",
        method: "POST",
        headers: {
          "x-client-eligibility": "eligibility",
          "x-host-context": "host",
          "x-route-id": "route",
          "x-session-id": "session",
          authorization: "must-not-forward",
        },
      });
    },
    currentUrl: async () => finalUrl,
    waitForTimeout: async () => {},
    evaluate: async (_pageFunction: M365ChatPageFunction, input: M365ChatFetchInput) => {
      requests.push(input.body);
      const response = responses.shift();

      if (!response) throw new Error("unexpected browser fetch");

      return { status: response.status, text: JSON.stringify(response.body) };
    },
  };

  const browser: M365WebBrowser = {
    openPage: async () => page,
    close: async () => {
      closed = true;
    },
  };

  return {
    browser,
    requests,
    get closed() {
      return closed;
    },
  };
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
      launchBrowser: async () => fake.browser,
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
    const client = new M365WebConversationClient({ launchBrowser: async () => fake.browser });

    await expect(client.deleteConversation({ conversationId: "missing" })).rejects.toMatchObject({ code: "target_missing" });
    expect(fake.requests).toHaveLength(1);
    expect(fake.closed).toBe(true);
  });

  it("rejects a sign-in redirect without attempting credentials", async () => {
    const fake = fakeBrowser([], "https://login.microsoftonline.com/common/oauth2/authorize");
    const client = new M365WebConversationClient({ launchBrowser: async () => fake.browser });

    await expect(client.deleteConversation({ conversationId: "target" })).rejects.toBeInstanceOf(M365WebSessionUnavailableError);
    expect(fake.closed).toBe(true);
  });

  it("preserves remote failure status and closes", async () => {
    const fake = fakeBrowser([
      { status: 200, body: { store: { conversationPageHistoryList: { chats: [{ conversationId: "target" }] } } } },
      { status: 403, body: {} },
    ]);

    const client = new M365WebConversationClient({ launchBrowser: async () => fake.browser });

    await expect(client.deleteConversation({ conversationId: "target" })).rejects.toEqual(expect.objectContaining({
      code: "delete_failed",
    } satisfies Partial<M365WebConversationError>));
    expect(fake.requests).toHaveLength(2);
    expect(fake.closed).toBe(true);
  });
});
