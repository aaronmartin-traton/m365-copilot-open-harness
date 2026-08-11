// Unit tests for the pure helpers behind usage-endpoint-hunt-v2.mjs.
// No I/O, no M365, no build artifacts — import the lib directly.
import { describe, expect, it } from "vitest";
import { buildBrowserHeaders, classifyResult, pickWinners, normalizeResult, errorResult } from "./_endpoint-hunt-v2-lib.mjs";

describe("buildBrowserHeaders", () => {
  it("returns the full browser header set with the bearer token", () => {
    const h = buildBrowserHeaders("tok-123");
    expect(h).toEqual({
      Authorization: "Bearer tok-123",
      Accept: "application/json",
      Origin: "https://m365.cloud.microsoft",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0",
      "Accept-Language": "en-GB,en;q=0.9",
    });
  });

  it("returns a fresh object per call", () => {
    const a = buildBrowserHeaders("tok-a");
    const b = buildBrowserHeaders("tok-b");
    a.Authorization = "mutated";
    expect(b.Authorization).toBe("Bearer tok-b");
    expect(a.Authorization).toBe("mutated");
  });
});

describe("classifyResult", () => {
  it.each([
    [200, { ok: true, interesting: true }],
    [204, { ok: true, interesting: true }],
    [301, { ok: false, interesting: false }],
    [399, { ok: false, interesting: false }],
    [400, { ok: false, interesting: true }],
    [401, { ok: false, interesting: false }],
    [403, { ok: false, interesting: false }],
    [404, { ok: false, interesting: false }],
    [405, { ok: false, interesting: true }],
    [500, { ok: false, interesting: true }],
  ])("classifies status %i as %o", (status, expected) => {
    expect(classifyResult(status)).toEqual(expected);
  });
});

describe("pickWinners", () => {
  it("keeps only 2xx/3xx statuses, dropping falsy statuses", () => {
    const rows = [
      { status: 200 }, { status: 204 }, { status: 301 }, { status: 399 },
      { status: 199 }, { status: 400 }, { status: 404 }, { status: 500 },
      { status: null }, { status: 0 }, {},
    ];
    const winners = pickWinners(rows);
    expect(winners.map((r) => r.status)).toEqual([200, 204, 301, 399]);
  });
});

describe("normalizeResult", () => {
  it("carries the row fields and truncates the body to 800 chars", () => {
    const row = normalizeResult({
      tag: "sydney", method: "GET", url: "https://example.com/usage",
      kind: "usage", status: 200, contentType: "application/json",
      body: "x".repeat(1200),
    });
    expect(row.tag).toBe("sydney");
    expect(row.method).toBe("GET");
    expect(row.url).toBe("https://example.com/usage");
    expect(row.kind).toBe("usage");
    expect(row.status).toBe(200);
    expect(row.contentType).toBe("application/json");
    expect(row.body.length).toBe(800);
  });

  it("keeps a body that is exactly 800 chars", () => {
    const row = normalizeResult({ tag: "s", method: "GET", url: "u", kind: "k", status: 200, contentType: "", body: "y".repeat(800) });
    expect(row.body).toBe("y".repeat(800));
  });

  it("treats a missing body as an empty string", () => {
    const row = normalizeResult({ tag: "s", method: "GET", url: "u", kind: "k", status: 200, contentType: "" });
    expect(row.body).toBe("");
  });

  it("does not add an error field on a normal row", () => {
    const row = normalizeResult({ tag: "s", method: "GET", url: "u", kind: "k", status: 200, contentType: "" });
    expect("error" in row).toBe(false);
  });
});

describe("errorResult", () => {
  it("builds a row with only the envelope and the error message", () => {
    const row = errorResult({ tag: "pp", method: "GET", url: "https://example.com/x", kind: "usage", error: "ETIMEDOUT" });
    expect(row).toEqual({ tag: "pp", method: "GET", url: "https://example.com/x", kind: "usage", error: "ETIMEDOUT" });
  });
});
