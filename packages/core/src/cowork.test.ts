import { describe, expect, it } from "vitest";
import { decodeSocketPacket } from "./cowork-protocol.js";

describe("Cowork Socket.IO framing", () => {
  it("preserves JSON containing colons", () => {
    const payload = JSON.stringify({ method: "POST", url: "https://example.test/messaging", body: "{\"text\":\"a:b\"}" });
    expect(decodeSocketPacket(`3:::${payload}`)).toEqual({
      type: 3,
      id: "",
      endpoint: "",
      data: payload,
    });
  });

  it("parses event ids and endpoints", () => {
    expect(decodeSocketPacket('5:1+:chat:{"name":"ping"}')).toEqual({
      type: 5,
      id: "1+",
      endpoint: "chat",
      data: '{"name":"ping"}',
    });
  });
});
