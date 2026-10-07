import { describe, expect, it } from "vitest";
import { TurnResultFrame } from "./schemas.js";

describe("TurnResultFrame (final type:2 item result)", () => {
  it("reads a Throttled result with scope and message", () => {
    expect(TurnResultFrame.parse({ value: "Throttled", errorCode: "PerUserThrottled", message: "Sorry" }))
      .toEqual({ value: "Throttled", errorCode: "PerUserThrottled", message: "Sorry" });
  });

  it("drops non-string optional fields instead of failing", () => {
    expect(TurnResultFrame.parse({ value: "Success", errorCode: 7 })).toEqual({ value: "Success" });
  });

  it("rejects a missing value", () => {
    expect(TurnResultFrame.safeParse({ errorCode: "x" }).success).toBe(false);
    expect(TurnResultFrame.safeParse(undefined).success).toBe(false);
  });
});
