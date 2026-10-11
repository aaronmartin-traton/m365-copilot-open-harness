import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AuthenticationError,
  CLIENT_ID,
  FileTokenProvider,
  SCOPES,
  authorizationResponseFrom,
  authorizeUrl,
  pkce,
  scopeKey,
  tokenRequest,
  type BrowserRequest,
} from "./auth.js";

// ---------------------------------------------------------------------------
// Stub token endpoint
// ---------------------------------------------------------------------------

interface StubReply {
  readonly status: number;
  readonly body: string;
}

interface StubTokenServer {
  readonly endpoint: string;
  readonly forms: URLSearchParams[];
  close: () => Promise<void>;
}

const boundAddressSchema = z.object({ port: z.number() });

/** Starts an HTTP server on a loopback port that answers every POST with `reply`. */
async function startTokenServer(reply: (form: URLSearchParams) => StubReply): Promise<StubTokenServer> {
  const forms: URLSearchParams[] = [];

  const server: Server = createServer((request, response) => {
    let raw = "";

    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      const form = new URLSearchParams(raw);

      forms.push(form);
      const answered = reply(form);

      response.writeHead(answered.status, { "Content-Type": "application/json" });
      response.end(answered.body);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const bound = boundAddressSchema.safeParse(server.address());

  if (!bound.success) throw new Error("Token stub server did not bind a TCP port");

  return {
    endpoint: `http://127.0.0.1:${bound.data.port}/token`,
    forms,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

// ---------------------------------------------------------------------------
// Cache fixtures
// ---------------------------------------------------------------------------

const cacheSchema = z.object({
  refresh_token: z.string().optional(),
  username: z.string().optional(),
  access: z
    .record(z.string(), z.object({ token: z.string(), expires_at: z.number() }))
    .optional(),
});

type CacheFixture = z.infer<typeof cacheSchema>;

function tempCachePath(): string {
  return join(mkdtempSync(join(tmpdir(), "m365-auth-")), "token-cache.json");
}

function writeCache(path: string, cache: CacheFixture): void {
  writeFileSync(path, JSON.stringify(cache), "utf8");
}

function readCache(path: string): CacheFixture {
  return cacheSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** A minimal id_token carrying `preferred_username`, enough for the username read. */
function idTokenFor(username: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ preferred_username: username })).toString("base64url");

  return `${header}.${payload}.signature`;
}

// ---------------------------------------------------------------------------
// Nativeclient redirect parsing
// ---------------------------------------------------------------------------

/** A captured request to `url`, with the method and headers the parser ignores. */
function captured(url: string): BrowserRequest {
  return { url, method: "GET", headers: {} };
}

describe("authorizationResponseFrom", () => {
  it("reads the code and state from the nativeclient redirect", () => {
    expect(
      authorizationResponseFrom(
        captured("https://login.microsoftonline.com/common/oauth2/nativeclient?code=abc123&state=xyz"),
      ),
    ).toEqual({ code: "abc123", state: "xyz" });
  });

  it("reads an OAuth error from the nativeclient redirect", () => {
    expect(
      authorizationResponseFrom(
        captured("https://login.microsoftonline.com/common/oauth2/nativeclient?error=access_denied"),
      ),
    ).toEqual({ error: "access_denied" });
  });

  it("ignores the authorize path and other hosts", () => {
    expect(
      authorizationResponseFrom(
        captured("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?code=abc123"),
      ),
    ).toBeNull();
    expect(
      authorizationResponseFrom(
        captured("https://example.test/common/oauth2/nativeclient?code=abc123"),
      ),
    ).toBeNull();
  });

  it("ignores a redirect with neither a code nor an error", () => {
    expect(
      authorizationResponseFrom(captured("https://login.microsoftonline.com/common/oauth2/nativeclient")),
    ).toBeNull();
  });

  it("ignores a malformed URL", () => {
    expect(authorizationResponseFrom(captured("not a url"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

describe("pkce", () => {
  it("returns a base64url verifier and its S256 challenge", () => {
    const [verifier, challenge] = pkce();

    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier, "ascii").digest("base64url"));
  });

  it("generates a fresh verifier and challenge each call", () => {
    const [firstVerifier, firstChallenge] = pkce();
    const [secondVerifier, secondChallenge] = pkce();

    expect(secondVerifier).not.toBe(firstVerifier);
    expect(secondChallenge).not.toBe(firstChallenge);
  });
});

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

describe("authorizeUrl", () => {
  it("builds the v2 authorize URL with PKCE, offline_access, and no prompt", () => {
    const url = new URL(authorizeUrl(SCOPES, "challenge-1", "state-1", null));

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://login.microsoftonline.com/common/oauth2/nativeclient",
    );
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("scope")).toBe(`${[...SCOPES].join(" ")} offline_access openid profile`);
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("prompt")).toBeNull();
  });

  it("adds the prompt when asked", () => {
    const url = new URL(authorizeUrl(SCOPES, "c", "s", "select_account"));

    expect(url.searchParams.get("prompt")).toBe("select_account");
  });
});

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

describe("tokenRequest", () => {
  it("posts the form body and returns the decoded JSON", async () => {
    const server = await startTokenServer(() => ({
      status: 200,
      body: JSON.stringify({ access_token: "access-1", expires_in: 3600 }),
    }));

    try {
      const result = await tokenRequest({ grant_type: "authorization_code", code: "code-1" }, server.endpoint);

      expect(result["access_token"]).toBe("access-1");
      expect(server.forms.at(0)?.get("grant_type")).toBe("authorization_code");
      expect(server.forms.at(0)?.get("code")).toBe("code-1");
    } finally {
      await server.close();
    }
  });

  it("throws when the endpoint answers with a non-JSON failure", async () => {
    const server = await startTokenServer(() => ({ status: 500, body: "upstream exploded" }));

    try {
      await expect(tokenRequest({ grant_type: "refresh_token" }, server.endpoint)).rejects.toBeInstanceOf(
        AuthenticationError,
      );
    } finally {
      await server.close();
    }
  });

  it("throws when a successful reply is not JSON", async () => {
    const server = await startTokenServer(() => ({ status: 200, body: "<html>login</html>" }));

    try {
      await expect(tokenRequest({ grant_type: "refresh_token" }, server.endpoint)).rejects.toBeInstanceOf(
        AuthenticationError,
      );
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Authorization-code exchange and cache
// ---------------------------------------------------------------------------

describe("FileTokenProvider.interactive", () => {
  it("exchanges the captured code and writes the cache", async () => {
    const server = await startTokenServer(() => ({
      status: 200,
      body: JSON.stringify({
        access_token: "access-code",
        refresh_token: "refresh-code",
        expires_in: 3600,
        id_token: idTokenFor("user@example.com"),
      }),
    }));

    try {
      const cachePath = tempCachePath();
      const challenges: string[] = [];

      const provider = new FileTokenProvider({
        cacheFile: cachePath,
        tokenEndpoint: server.endpoint,
        authorizeResponse: async (authUri) => {
          const url = new URL(authUri);

          challenges.push(url.searchParams.get("code_challenge") ?? "");

          return { code: "code-123", state: url.searchParams.get("state") ?? "" };
        },
      });

      await expect(provider.interactive(["scope-c"], () => {})).resolves.toBe("access-code");
      expect(server.forms.at(0)?.get("grant_type")).toBe("authorization_code");
      expect(server.forms.at(0)?.get("code")).toBe("code-123");
      expect(server.forms.at(0)?.get("redirect_uri")).toBe(
        "https://login.microsoftonline.com/common/oauth2/nativeclient",
      );
      expect(server.forms.at(0)?.get("code_verifier")).not.toBeNull();

      // The challenge the provider sent is a real S256 of the verifier it exchanged.
      const verifier = server.forms.at(0)?.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");

      expect(challenges.at(0)).toBe(challenge);

      const cached = readCache(cachePath);

      expect(cached.refresh_token).toBe("refresh-code");
      expect(cached.username).toBe("user@example.com");
      expect(cached.access?.[scopeKey(["scope-c"])]?.token).toBe("access-code");
    } finally {
      await server.close();
    }
  });

  it("rejects an unexpected state before contacting the token endpoint", async () => {
    const server = await startTokenServer(() => ({ status: 200, body: "{}" }));

    try {
      const provider = new FileTokenProvider({
        cacheFile: tempCachePath(),
        tokenEndpoint: server.endpoint,
        authorizeResponse: async () => ({ code: "code-123", state: "not-the-state" }),
      });

      await expect(provider.interactive(["scope-c"], () => {})).rejects.toBeInstanceOf(AuthenticationError);
      expect(server.forms).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Refresh and cache round-trip
// ---------------------------------------------------------------------------

describe("FileTokenProvider refresh", () => {
  it("rotates a seeded refresh token and persists the result", async () => {
    const server = await startTokenServer(() => ({
      status: 200,
      body: JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
    }));

    try {
      const cachePath = tempCachePath();

      writeCache(cachePath, { refresh_token: "seed-refresh" });

      const provider = new FileTokenProvider({ cacheFile: cachePath, tokenEndpoint: server.endpoint });

      await expect(provider.tokenSilent(["scope-a"])).resolves.toBe("access-1");
      expect(server.forms).toHaveLength(1);
      expect(server.forms.at(0)?.get("grant_type")).toBe("refresh_token");
      expect(server.forms.at(0)?.get("refresh_token")).toBe("seed-refresh");
      expect(server.forms.at(0)?.get("scope")).toBe("scope-a");

      const cached = readCache(cachePath);

      expect(cached.refresh_token).toBe("refresh-1");
      expect(cached.access?.["scope-a"]?.token).toBe("access-1");
    } finally {
      await server.close();
    }
  });

  it("serves a second provider from the rotated cache without another request", async () => {
    const server = await startTokenServer(() => ({
      status: 200,
      body: JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
    }));

    try {
      const cachePath = tempCachePath();

      writeCache(cachePath, { refresh_token: "seed-refresh" });

      const writer = new FileTokenProvider({ cacheFile: cachePath, tokenEndpoint: server.endpoint });

      await expect(writer.tokenSilent(["scope-a"])).resolves.toBe("access-1");

      const reader = new FileTokenProvider({ cacheFile: cachePath, tokenEndpoint: server.endpoint });

      await expect(reader.tokenSilent(["scope-a"])).resolves.toBe("access-1");
      expect(server.forms).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("serializes concurrent calls so one refresh token grant is used", async () => {
    const server = await startTokenServer(() => ({
      status: 200,
      body: JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
    }));

    try {
      const cachePath = tempCachePath();

      writeCache(cachePath, { refresh_token: "seed-refresh" });

      const provider = new FileTokenProvider({ cacheFile: cachePath, tokenEndpoint: server.endpoint });

      const [first, second] = await Promise.all([
        provider.tokenSilent(["scope-a"]),
        provider.tokenSilent(["scope-a"]),
      ]);

      expect(first).toBe("access-1");
      expect(second).toBe("access-1");
      expect(server.forms).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("returns null when there is no cached sign-in", async () => {
    const provider = new FileTokenProvider({
      cacheFile: tempCachePath(),
      tokenEndpoint: "http://127.0.0.1:1/token",
    });

    await expect(provider.tokenSilent(["scope-a"])).resolves.toBeNull();
  });

  it("returns null when the refresh token is rejected", async () => {
    const server = await startTokenServer(() => ({
      status: 400,
      body: JSON.stringify({ error: "invalid_grant", error_description: "AADSTS70008: expired" }),
    }));

    try {
      const cachePath = tempCachePath();

      writeCache(cachePath, { refresh_token: "stale" });

      const provider = new FileTokenProvider({ cacheFile: cachePath, tokenEndpoint: server.endpoint });

      await expect(provider.tokenSilent(["scope-a"])).resolves.toBeNull();
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Status probe
// ---------------------------------------------------------------------------

describe("FileTokenProvider.tokenStatus", () => {
  // A dead endpoint proves the probe never touches the network.
  const untouched = "http://127.0.0.1:1/token";

  it("reports a live access token as valid and refreshable", async () => {
    const cachePath = tempCachePath();

    writeCache(cachePath, {
      refresh_token: "rt",
      username: "user@example.com",
      access: { [scopeKey(SCOPES)]: { token: "access", expires_at: Date.now() / 1000 + 3600 } },
    });

    const status = await new FileTokenProvider({ cacheFile: cachePath, tokenEndpoint: untouched }).tokenStatus(SCOPES);

    expect(status.valid).toBe(true);
    expect(status.refreshable).toBe(true);
    expect(status.secondsRemaining).toBeGreaterThan(3000);
    expect(status.username).toBe("user@example.com");
  });

  it("reports an expired access token as refreshable but not valid", async () => {
    const cachePath = tempCachePath();

    writeCache(cachePath, {
      refresh_token: "rt",
      access: { [scopeKey(SCOPES)]: { token: "access", expires_at: Date.now() / 1000 - 10 } },
    });

    const status = await new FileTokenProvider({ cacheFile: cachePath, tokenEndpoint: untouched }).tokenStatus(SCOPES);

    expect(status.valid).toBe(false);
    expect(status.refreshable).toBe(true);
    expect(status.secondsRemaining).toBe(0);
  });

  it("reports a refresh token alone as refreshable but not valid", async () => {
    const cachePath = tempCachePath();

    writeCache(cachePath, { refresh_token: "rt" });

    const status = await new FileTokenProvider({ cacheFile: cachePath, tokenEndpoint: untouched }).tokenStatus(SCOPES);

    expect(status.valid).toBe(false);
    expect(status.refreshable).toBe(true);
    expect(status.secondsRemaining).toBeNull();
    expect(status.username).toBeNull();
  });

  it("reports an empty cache as neither valid nor refreshable", async () => {
    const status = await new FileTokenProvider({
      cacheFile: tempCachePath(),
      tokenEndpoint: untouched,
    }).tokenStatus(SCOPES);

    expect(status.valid).toBe(false);
    expect(status.refreshable).toBe(false);
  });
});
