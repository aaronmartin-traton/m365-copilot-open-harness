import { describe, expect, it } from "vitest";
import * as pkg from "@m365-copilot/chatgpt-web";

describe("@m365-copilot/chatgpt-web public surface (built dist)", () => {
  it.each([
    "ChatGptWebProvider",
    "ChatGptBrowserSession",
    "chatGptProfileDir",
    "chatGptWebModelNames",
    "chatGptWebCatalog",
    "listChatGptWebModels",
    "describeChatGptModel",
    "CHATGPT_WEB_MODELS",
  ])("exports %s", (name) => {
    expect(pkg).toHaveProperty(name);
  });
});
