import { describe, it, expect } from "vitest";
import { extractAuthCode, waitForAuthCode, type AuthCodeEventSource } from "./auth.js";

describe("extractAuthCode", () => {
  it("parses the code from the nativeclient redirect", () => {
    expect(
      extractAuthCode(
        "https://login.microsoftonline.com/common/oauth2/nativeclient?code=abc123&state=xyz",
      ),
    ).toBe("abc123");
  });

  it("returns null when the redirect carries no code", () => {
    expect(
      extractAuthCode("https://login.microsoftonline.com/common/oauth2/nativeclient?error=access_denied"),
    ).toBeNull();
  });

  it("returns null for URLs outside the nativeclient path", () => {
    expect(
      extractAuthCode("https://login.microsoftonline.com/common/oauth2/authorize?code=abc123"),
    ).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(extractAuthCode("not a url")).toBeNull();
  });
});

/** Minimal playwright-Page-shaped fake: records handlers, emits request URLs. */
function fakeEventSource() {
  const handlers = new Set<(request: { url(): string }) => void>();
  return {
    source: {
      on: (_event: "request", handler: (request: { url(): string }) => void) => {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
    } satisfies AuthCodeEventSource,
    handlers,
    emit(url: string) {
      for (const handler of [...handlers]) handler({ url: () => url });
    },
  };
}

describe("waitForAuthCode", () => {
  it("resolves with the code on the nativeclient redirect and ignores other traffic", async () => {
    const { source, emit } = fakeEventSource();
    const code = waitForAuthCode(source, 5000);
    emit("https://login.microsoftonline.com/common/oauth2/authorize?x=1");
    emit("https://login.microsoftonline.com/common/oauth2/nativeclient?error=access_denied");
    emit("https://login.microsoftonline.com/common/oauth2/nativeclient?code=final123");
    await expect(code).resolves.toBe("final123");
  });

  it("unsubscribes once the code is found", async () => {
    const { source, handlers, emit } = fakeEventSource();
    const code = waitForAuthCode(source, 5000);
    emit("https://login.microsoftonline.com/common/oauth2/nativeclient?code=first");
    await expect(code).resolves.toBe("first");
    expect(handlers.size).toBe(0);
  });

  it("rejects with the login timeout error when no redirect arrives", async () => {
    const { source } = fakeEventSource();
    const code = waitForAuthCode(source, 10);
    await expect(code).rejects.toThrow("Timed out waiting for Microsoft login");
  });

  it("unsubscribes the request handler when the login times out", async () => {
    const { source, handlers } = fakeEventSource();
    const code = waitForAuthCode(source, 10);
    await expect(code).rejects.toThrow("Timed out waiting for Microsoft login");
    expect(handlers.size).toBe(0);
  });
});
