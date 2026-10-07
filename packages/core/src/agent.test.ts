import { describe, it, expect } from "vitest";
import { environmentUrlFromName } from "./agent.js";

describe("environmentUrlFromName", () => {
  it("splits the last two env-ID chars into their own DNS label", () => {
    expect(environmentUrlFromName("Default-00000000-0000-4000-8000-000000000000")).toBe(
      "https://000000000000400080000000000000.df.environment.api.powerplatform.com",
    );
  });

  // Regression: the old hardcoded `.df.` only worked for IDs ending in "df".
  it("uses the real trailing chars, not a hardcoded `.df.`", () => {
    expect(environmentUrlFromName("Default-00000000-0000-4000-8000-000000000001")).toBe(
      "https://default000000000000400080000000000000.a1.environment.api.powerplatform.com",
    );
  });

  it("rejects a degenerate env ID", () => {
    expect(() => environmentUrlFromName("Default-")).toThrow(/Unexpected/);
  });
});
