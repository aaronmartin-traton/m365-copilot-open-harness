import { describe, it, expect } from "vitest";
import { buildImagePrompt, classifyImageFailure } from "./image.js";

describe("buildImagePrompt", () => {
  it("leaves natural prompts unchanged", () => {
    expect(buildImagePrompt("a red bicycle")).toBe("a red bicycle");
    expect(buildImagePrompt("a red bicycle", { style: "natural" })).toBe("a red bicycle");
  });
  it("adds style and orientation directives", () => {
    expect(buildImagePrompt("a cat", { orientation: "portrait" })).toContain("portrait");
    expect(buildImagePrompt("a lighthouse", { style: "icon" })).toContain("app icon");
    const combined = buildImagePrompt("a fox", { style: "designer", orientation: "square" });
    expect(combined).toContain("graphic-design");
    expect(combined).toContain("square");
  });
});

describe("classifyImageFailure", () => {
  it("classifies quota, capacity, and policy responses", () => {
    expect(classifyImageFailure("Sorry, I can't generate any more images today. Try again tomorrow.")).toBe("quota_exceeded");
    expect(classifyImageFailure("I'm having trouble creating images right now. Please try again in a bit.")).toBe("capacity");
    expect(classifyImageFailure("I can't create that image because it goes against our content policy.")).toBe("content_filtered");
  });
  it("leaves normal or empty responses as no_image", () => {
    expect(classifyImageFailure("")).toBe("no_image");
    expect(classifyImageFailure("Here is a serene image of a lighthouse at dawn.")).toBe("no_image");
  });
});
