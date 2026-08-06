export const OPENCLAW_DISABLED_MESSAGE = "OpenClaw integration is disabled in this build.";

export class OpenClawDisabledError extends Error {
  constructor() {
    super(OPENCLAW_DISABLED_MESSAGE);
    this.name = "OpenClawDisabledError";
  }
}

export interface OpenClawModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export interface OpenClawProviderConfig {
  baseUrl: string;
  apiKey: string;
  api: string;
  models: OpenClawModelConfig[];
}

export interface OpenClawConfig {
  models: {
    mode: "merge";
    providers: {
      m365: OpenClawProviderConfig;
    };
  };
  agents: {
    defaults: {
      models: Record<string, { alias: string }>;
    };
  };
}

export function generateOpenClawConfig(_proxyPort: number = 4141): OpenClawConfig {
  throw new OpenClawDisabledError();
}

export interface ProxyHandle {
  port: number;
  close: () => void;
}

export async function startForOpenClaw(options: { port?: number } = {}): Promise<{
  proxy: ProxyHandle;
  config: OpenClawConfig;
}> {
  void options;
  throw new OpenClawDisabledError();
}
