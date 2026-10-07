import { getToken } from "./auth.js";
import { getOrCreateAgent } from "./agent.js";
import { CopilotSession } from "./session.js";
import { createLogger, trunc } from "./log.js";
import { getAvailableModels, getToneForModel } from "./copilot.js";
import type { ImageInput } from "./images.js";
import type { ModelProvider, ProviderTurn } from "./provider.js";

const log = createLogger("model");

export interface ModelSessionOptions {
  /** Pre-resolved auth token. If not provided, getToken() is called. */
  getToken?: () => Promise<string>;
  /** Whether to attempt agent resolution. Default: true. */
  useAgent?: boolean;
  /** Stable transport IDs restored from the proxy session store. */
  sessionId?: string;
  conversationId?: string;
  /** Completed M365 turns restored with the conversation. */
  turnCount?: number;
}

/**
 * A stateful session for running M365 Copilot.
 * Manages auth, agent resolution, and conversation continuity.
 * String in, stream out.
 *
 * The same sessionId and conversationId are reused across CopilotSession
 * reconnections so M365 finds the existing server-side conversation
 * instead of creating a new one.
 */
export class ModelSession implements ModelProvider {
  private resolveToken: () => Promise<string>;
  private useAgent: boolean;
  private copilotSession: CopilotSession | null = null;
  private cachedAgentId: string | null | undefined = undefined;

  /** Stable IDs reused across CopilotSession reconnections. */
  readonly sessionId: string;
  private _conversationId: string;
  private persistedTurnCount: number;
  /** Current M365 ConversationId (the throttle/Disengage state keys on this). */
  get conversationId(): string { return this._conversationId; }
  /**
   * Rotate to a FRESH conversation. A conversation that has Disengaged appears to
   * STAY Disengaged (a clean retry in the same conversation kept refusing), so the
   * Disengage-recovery retry needs a new ConversationId, not just a different prompt.
   * See docs §10 F22.
   */
  newConversation(): void {
    this.reset();
    this._conversationId = crypto.randomUUID();
    this.persistedTurnCount = 0;
  }

  constructor(options: ModelSessionOptions = {}) {
    this.resolveToken = options.getToken ?? getToken;
    this.useAgent = options.useAgent !== false;
    this.sessionId = options.sessionId ?? crypto.randomUUID();
    this._conversationId = options.conversationId ?? crypto.randomUUID();
    this.persistedTurnCount = Math.max(0, Math.floor(options.turnCount ?? 0));
  }

  /** Number of turns completed in this session */
  get turnCount(): number {
    return this.copilotSession?.turnCount ?? this.persistedTurnCount;
  }

  /** Namespaces this backend's `usage` keys (`x_m365_*`). */
  get id(): string { return "m365"; }

  readonly refusalHint =
    "M365 Copilot disengaged from this request (its safety filter declined to answer). "
    + "Common causes: too many tools, jailbreak-shaped instructions, or pairing a non-default "
    + "model with the tool agent. Reduce the toolset or use the default model.";

  listModels(): string[] { return getAvailableModels(); }

  /** M365 routes by tone, so the tone is the honest model name to log. */
  describeModel(model: string): string { return getToneForModel(model); }

  /**
   * Claude tones tool-call reliably AGENT-LESS (probe: 4/4 ```bash, 0 disengage)
   * and self-ID as Claude Sonnet 4.5; the declarative agent would override the
   * tone back to GPT-5 (H8.6) AND add jailbreak-shape signal. The GPT chat
   * model, by contrast, won't tool-call agent-less (0/4) so it still needs the
   * agent. So: attach the tool agent EXCEPT on Claude tones. `M365_FORCE_AGENT=1`
   * restores the old always-agent behaviour.
   *
   * Derived from the RESOLVED tone, not the raw model string: getToneForModel
   * routes any unmapped `claude-*` (e.g. the `claude-opus-4-8[1m]` a Claude Code
   * client sends) to Claude_Sonnet, which keeps that request on the working
   * agent-less path. One resolved tone drives both decisions.
   */
  supportsTools(model: string): boolean {
    return process.env.M365_FORCE_AGENT === "1" || !/^Claude_/i.test(getToneForModel(model));
  }

  /**
   * F22: the default framing's override-shape language occasionally trips Azure
   * Prompt Shields (jailbreak classifier) on benign requests (e.g. "replace X
   * with Y, leave everything else unchanged"). Retry ONCE with the low-override
   * `softened` framing, and in a FRESH conversation — a Disengaged conversation
   * stays Disengaged, so a clean retry on the same ConversationId keeps
   * refusing. Drops the worst-case disengage ~100%→~4% (docs §10 F22).
   * Off via M365_NO_DISENGAGE_RETRY.
   */
  recoverFromRefusal(rebuild: (framing: "softened") => string): string | null {
    if (process.env.M365_NO_DISENGAGE_RETRY) return null;
    this.newConversation();

    return rebuild("softened");
  }

  /** Agent id baked into the current copilotSession (undefined = no agent). */
  private currentAgentId: string | undefined = undefined;
  private currentEnableCodeInterpreter = true;

  private createCopilotSession(
    agentId: string | undefined,
    enableCodeInterpreter: boolean,
  ): CopilotSession {
    return new CopilotSession({
      agentId,
      enableCodeInterpreter,
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      turnCount: this.persistedTurnCount,
    });
  }

  /**
   * Send text to M365 Copilot and stream back the response.
   *
   * `useAgent` decides whether THIS turn attaches the tool-calling Copilot Studio
   * agent (`threadLevelGptId`). The handler passes `false` for tool-less requests
   * — the agent is only needed to coerce tool-call output, and crucially it
   * **overrides the `tone` and forces GPT-5** (docs/hypotheses.md H8.6): with the
   * agent attached a `Claude_*` tone silently routes to GPT, and heavy tool
   * prompts can Disengage. So plain chat skips the agent and gets the real model
   * the tone selects (e.g. Claude Sonnet 4.5).
   *
   * If `signal` aborts (the HTTP client disconnects) the in-flight turn is
   * cancelled by sending M365's Stop frame, mirroring the real UI's Stop button.
   */
  async run(
    text: string,
    model: string = "m365-copilot",
    signal?: AbortSignal,
    useAgent: boolean = true,
    images: ImageInput[] = [],
  ): Promise<ProviderTurn> {
    const token = await this.resolveToken();
    const wantAgent = this.useAgent && useAgent;

    // Resolve agent ID lazily (persists across resets), only when wanted.
    if (wantAgent && this.cachedAgentId === undefined) {
      try {
        this.cachedAgentId = await getOrCreateAgent();

        if (this.cachedAgentId) log.info(`Using agent: ${this.cachedAgentId}`);
        else log.info("No agent available");
      } catch {
        this.cachedAgentId = null;
      }
    }

    const agentForTurn = wantAgent ? (this.cachedAgentId ?? undefined) : undefined;
    // A tool-enabled turn must not be swallowed by M365's hosted `/mnt/data`
    // interpreter when agent provisioning is unavailable. Leave it enabled only
    // for ordinary agent-less chat, where it is an intentional capability.
    const enableCodeInterpreter = !wantAgent;

    // Create (or recreate) the session when missing or when this turn's
    // agent-ness differs from the current session's — switching the agent on/off
    // changes routing, so the WS session must carry the right threadLevelGptId.
    if (
      !this.copilotSession ||
      this.currentAgentId !== agentForTurn ||
      this.currentEnableCodeInterpreter !== enableCodeInterpreter
    ) {
      this.copilotSession = this.createCopilotSession(agentForTurn, enableCodeInterpreter);
      this.currentAgentId = agentForTurn;
      this.currentEnableCodeInterpreter = enableCodeInterpreter;
    }

    const turnOptions = { generateImages: !agentForTurn && !process.env.M365_NO_IMAGE_GEN };
    log.info(`run: model=${model}, agent=${agentForTurn ?? "none"}, turn=${this.copilotSession.turnCount}, sid=${this.sessionId}, cid=${this.conversationId}, text=${JSON.stringify(trunc(text, 200))}`);

    try {
      return await this.copilotSession.chat(token, text, model, signal, images, turnOptions);
    } catch (err: unknown) {
      // Session might be stale — reconnect with same IDs
      log.info("Session error, reconnecting:", err instanceof Error ? err.message : String(err));
      this.copilotSession = this.createCopilotSession(agentForTurn, enableCodeInterpreter);
      this.currentAgentId = agentForTurn;

      return await this.copilotSession.chat(token, text, model, signal, images, turnOptions);
    }
  }

  /**
   * Force a re-resolution of the tool-calling agent against the tenant and
   * reconnect if it changed. Recovers from the "deleted-agent trap": a
   * long-lived host caches its agent id for the whole process lifetime, so once
   * that agent is deleted from the tenant (e.g. by a newer-build's cleanup) it
   * would otherwise send `threadLevelGptId` at a dead bot forever and get empty
   * replies. Call this on an empty upstream reply before retrying. No-op when
   * the session isn't using an agent. Returns true if the agent id changed (and
   * the session was dropped to reconnect), so the caller can resend the original
   * prompt to the fresh agent.
   */
  async refreshTools(): Promise<boolean> {
    if (!this.useAgent) return false;

    try {
      const fresh = await getOrCreateAgent({ forceRefresh: true });

      if (fresh !== this.cachedAgentId) {
        log.info(`Agent refreshed: ${this.cachedAgentId ?? "none"} -> ${fresh ?? "none"}`);
        this.cachedAgentId = fresh;
        this.persistedTurnCount = this.turnCount;
        this.copilotSession = null; // reconnect so the new agent id takes effect
        this.currentAgentId = undefined;

        return true;
      }
    } catch (err: any) {
      log.info(`Agent refresh failed: ${err.message}`);
    }

    return false;
  }

  /**
   * Reset the CopilotSession. Next run() reconnects with the same
   * sessionId/conversationId. Also drops the cached agent id so the next run()
   * re-resolves it (cheap cache fast-path in the normal case).
   */
  reset() {
    this.persistedTurnCount = this.turnCount;
    this.copilotSession = null;
    this.cachedAgentId = undefined;
    this.currentAgentId = undefined;
  }
}
