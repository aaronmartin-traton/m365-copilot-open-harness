import { describe, expect, it } from "vitest";
import {
  generateOpenClawConfig,
  OpenClawDisabledError,
  OPENCLAW_DISABLED_MESSAGE,
  startForOpenClaw,
  type OpenClawConfig,
  type ProxyHandle,
} from "./index.js";

describe("disabled OpenClaw compatibility tombstone", () => {
  it("preserves the config function signature while failing closed", () => {
    const configFactory: (proxyPort?: number) => OpenClawConfig = generateOpenClawConfig;
    expect(configFactory).toBe(generateOpenClawConfig);
    expect(() => configFactory()).toThrowError(OpenClawDisabledError);
    expect(() => configFactory()).toThrowError(OPENCLAW_DISABLED_MESSAGE);
    expect(() => configFactory()).toThrowError(
      expect.objectContaining({ name: "OpenClawDisabledError" }),
    );
  });

  it("preserves the async startup signature while failing closed", async () => {
    const starter: (options?: { port?: number }) => Promise<{
      proxy: ProxyHandle;
      config: OpenClawConfig;
    }> = startForOpenClaw;
    expect(starter).toBe(startForOpenClaw);
    await expect(starter()).rejects.toBeInstanceOf(OpenClawDisabledError);
    await expect(starter({ port: 0 })).rejects.toThrow(OPENCLAW_DISABLED_MESSAGE);
  });
});
