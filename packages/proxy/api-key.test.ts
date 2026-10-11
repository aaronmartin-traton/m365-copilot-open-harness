import { afterEach, describe, expect, it } from "vitest";

import { checkApiKey, configuredApiKey } from "./api-key.js";

const savedKey = process.env.M365_API_KEY;

afterEach(() => {
  if (savedKey === undefined) delete process.env.M365_API_KEY;
  else process.env.M365_API_KEY = savedKey;
});

describe("configuredApiKey", () => {
  it("is null when M365_API_KEY is unset", () => {
    delete process.env.M365_API_KEY;
    expect(configuredApiKey()).toBeNull();
  });

  it("is null when M365_API_KEY is blank", () => {
    process.env.M365_API_KEY = "   ";
    expect(configuredApiKey()).toBeNull();
  });

  it("returns the trimmed key when set", () => {
    process.env.M365_API_KEY = "  secret  ";
    expect(configuredApiKey()).toBe("secret");
  });
});

describe("checkApiKey", () => {
  it("is a no-op when no key is configured", () => {
    expect(checkApiKey(null, null, null)).toBe(true);
    expect(checkApiKey(null, "Bearer whatever", "wrong")).toBe(true);
  });

  it("accepts the right key as a Bearer token", () => {
    expect(checkApiKey("secret", "Bearer secret", null)).toBe(true);
    expect(checkApiKey("secret", "bearer secret", null)).toBe(true);
    expect(checkApiKey("secret", "  Bearer   secret  ", null)).toBe(true);
  });

  it("accepts the right key in x-api-key", () => {
    expect(checkApiKey("secret", null, "secret")).toBe(true);
    expect(checkApiKey("secret", null, "  secret  ")).toBe(true);
  });

  it("accepts the right key from either header", () => {
    expect(checkApiKey("secret", "Bearer sec", "secret")).toBe(true);
    expect(checkApiKey("secret", "Bearer secret", "wrong")).toBe(true);
  });

  it("rejects a missing key", () => {
    expect(checkApiKey("secret", null, null)).toBe(false);
    expect(checkApiKey("secret", "", "")).toBe(false);
    expect(checkApiKey("secret", "Basic secret", null)).toBe(false);
  });

  it("rejects a wrong key", () => {
    expect(checkApiKey("secret", "Bearer wrong", null)).toBe(false);
    expect(checkApiKey("secret", null, "wrong")).toBe(false);
    expect(checkApiKey("secret", "Bearer secret-longer", null)).toBe(false);
  });
});
