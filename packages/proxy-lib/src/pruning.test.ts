import { describe, expect, it } from "vitest";
import { ConversationPruneSelectorSchema, handleConversationPrune } from "./pruning.js";

describe("conversation prune boundary", () => {
  it("accepts exactly one selector", () => {
    expect(ConversationPruneSelectorSchema.safeParse({ session_key: "stable" }).success).toBe(true);
    expect(ConversationPruneSelectorSchema.safeParse({ conversation_id: "conversation" }).success).toBe(true);
    expect(ConversationPruneSelectorSchema.safeParse({}).success).toBe(false);
    expect(ConversationPruneSelectorSchema.safeParse({ session_key: "a", conversation_id: "b" }).success).toBe(false);
  });

  it("maps unknown, failed, and successful pool operations", async () => {
    const unknown = await handleConversationPrune({ prune: async () => null }, { session_key: "stable" });
    expect(unknown.status).toBe(404);
    const failed = await handleConversationPrune({ prune: async () => { throw new Error("browser failed"); } }, { conversation_id: "c" });
    expect(failed.status).toBe(503);
    const success = await handleConversationPrune({ prune: async () => ({ deleted: true, conversationId: "c" }) }, { conversation_id: "c" });
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ deleted: true, conversation_id: "c" });
  });
});
