/**
 * Session pool: maps conversation fingerprint → managed M365 session.
 *
 * Handles session lifecycle, conversation state, tool call tracking,
 * and idle session pruning.
 */

import { createHash } from "node:crypto";
import { createLogger } from "@m365-copilot/core";
import { ModelSession, type ModelProvider, type ModelSessionOptions } from "@m365-copilot/core";
import { RequestScheduler, type ScheduleOptions, type SchedulerStats } from "./scheduler.js";
import { SessionStateStore } from "./session-store.js";

const log = createLogger("session-pool");

const MAX_IDLE_MS = Number(process.env.M365_SESSION_MEMORY_TTL_MS ?? 30 * 60 * 1000);

const DEFAULT_PRUNE_RETRY_MS = 15 * 60 * 1000;

/** How long a thread may sit idle before the reaper deletes it upstream. */
const DEFAULT_IDLE_TTL_MINUTES = 7 * 24 * 60;

export interface ConversationState {
  key: string;
  persistent: boolean;
  session: ModelProvider;
  sentMessageCount: number;
  lastAccessedAt: number;
  /**
   * A one-line correction to prepend to the next tool result when the proxy
   * executed less than the model wrote last turn (see executedOnlyFirstNote).
   * Per-conversation and one turn only: consumed or cleared by the handler.
   */
  pendingNote: string | null;
}

/** Pool occupancy for the health payload: live and stored conversations, plus scheduler state. */
export interface SessionPoolDiagnostics {
  activeSessions: number;
  persistedSessions: number;
  scheduler: SchedulerStats;
}

export type ConversationPruneSelector = { sessionKey: string } | { conversationId: string };

export type RemoteConversationPruner = (ids: {
  sessionId: string;
  conversationId: string;
}) => Promise<void>;

export interface SessionPoolOptions {
  scheduler?: RequestScheduler;
  stateStore?: SessionStateStore;
  remotePruner?: RemoteConversationPruner;
  now?: () => number;
  pruneRetryMs?: number;
  /**
   * Builds the backend session for each conversation. Defaults to the M365
   * `ModelSession`; pass a factory returning another `ModelProvider` to run
   * every conversation on a different backend. This is the single injection
   * point — nothing else in the pool knows which backend it is driving.
   */
  createSession?: (options: ModelSessionOptions) => ModelProvider;
}

export class SessionPool {
  private conversations = new Map<string, ConversationState>();
  private toolCallConversations = new Map<string, string>();
  private gates = new Map<string, Promise<void>>();
  private sessionOptions: ModelSessionOptions;
  private createSession: (options: ModelSessionOptions) => ModelProvider;
  private scheduler: RequestScheduler;
  private stateStore: SessionStateStore;
  private remotePruner?: RemoteConversationPruner;
  private now: () => number;
  private readonly pruneRetryMs: number;

  constructor(sessionOptions: ModelSessionOptions = {}, options: SessionPoolOptions = {}) {
    this.sessionOptions = sessionOptions;
    this.createSession = options.createSession ?? ((o) => new ModelSession(o));
    this.scheduler = options.scheduler ?? new RequestScheduler();
    this.stateStore = options.stateStore ?? new SessionStateStore();
    this.remotePruner = options.remotePruner;
    this.now = options.now ?? (() => Date.now());
    this.pruneRetryMs = Number.isFinite(options.pruneRetryMs) && options.pruneRetryMs! > 0
      ? options.pruneRetryMs!
      : DEFAULT_PRUNE_RETRY_MS;
  }

  async acquire(messages: Array<{ role: string; tool_calls?: Array<{ id: string }> }>, explicitKey?: string, managedKey?: string): Promise<() => void> {
    const key = managedKey ?? this.managedKey(messages, explicitKey);
    const previous = this.gates.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.gates.set(key, current);

    if (previous) await previous;

    return () => {
      release();

      if (this.gates.get(key) === current) this.gates.delete(key);
    };
  }

  resolve(messages: Array<{ role: string; tool_calls?: Array<{ id: string }> }>, explicitKey?: string, managedKey?: string): ConversationState {
    const key = managedKey ?? this.managedKey(messages, explicitKey);
    const persistent = managedKey !== undefined || !!explicitKey?.trim();
    const existing = this.conversations.get(key);

    if (existing) {
      if (messages.length < existing.sentMessageCount) {
        log.info(`Conversation ${key}: messages shrunk (${messages.length} < ${existing.sentMessageCount}), rotating M365 conversation`);
        existing.session.newConversation();
        existing.sentMessageCount = 0;
        existing.pendingNote = null;
      }

      return existing;
    }

    const persisted = persistent ? this.stateStore.get(key) : undefined;
    log.info(`${persisted ? "Restoring" : "New"} ${persistent ? "keyed" : "ephemeral"} conversation ${key}, ${this.conversations.size} active`);

    const sessionOptions: ModelSessionOptions = { ...this.sessionOptions };

    if (persisted?.restorable) {
      sessionOptions.sessionId = persisted.sessionId;
      sessionOptions.conversationId = persisted.conversationId;
      sessionOptions.turnCount = persisted.turnCount;
    }

    const state: ConversationState = {
      key,
      persistent,
      session: this.createSession(sessionOptions),
      sentMessageCount: persisted?.restorable ? persisted.sentMessageCount : 0,
      lastAccessedAt: persisted?.lastAccessedAt ?? this.now(),
      pendingNote: null,
    };

    this.conversations.set(key, state);

    return state;
  }

  markSent(state: ConversationState, messageCount: number): void {
    state.sentMessageCount = messageCount;
    state.lastAccessedAt = this.now();
    this.stateStore.set(state.key, {
      sessionId: state.session.sessionId,
      conversationId: state.session.conversationId,
      turnCount: state.session.turnCount,
      sentMessageCount: state.sentMessageCount,
      lastAccessedAt: state.lastAccessedAt,
      restorable: state.persistent,
      nextPruneAttemptAt: null,
    });
  }

  registerToolCalls(state: ConversationState, calls: Array<{ id: string }>): void {
    for (const call of calls) this.toolCallConversations.set(call.id, state.key);
  }

  /** True iff this proxy emitted the tool-call id (any conversation, not pruned). */
  knowsToolCallId(toolCallId: string): boolean {
    const key = this.toolCallConversations.get(toolCallId);

    return key !== undefined && this.conversations.has(key);
  }

  bindResponseId(responseId: string, key: string): void {
    this.stateStore.bindResponseId(responseId, key);
  }

  lookupResponseId(responseId: string): string | undefined {
    return this.stateStore.lookupResponseId(responseId);
  }

  managedKeyForSessionKey(sessionKey: string): string {
    return this.fingerprint(sessionKey);
  }

  async prune(selector: ConversationPruneSelector): Promise<{ deleted: true; conversationId: string } | null> {
    const key = "sessionKey" in selector
      ? this.fingerprint(selector.sessionKey)
      : this.conversationsForConversationId(selector.conversationId);

    if (!key) return null;

    return this.withKey(key, async () => {
      const state = this.conversations.get(key);
      const persisted = this.stateStore.get(key);
      const conversationId = state?.session.conversationId ?? persisted?.conversationId;
      const sessionId = state?.session.sessionId ?? persisted?.sessionId;

      if (!conversationId || !sessionId) return null;

      if (!this.remotePruner) throw new Error("remote_prune_unavailable");

      try {
        await this.scheduler.schedule({ newConversation: false, maintenance: true }, () =>
          this.remotePruner!({ sessionId, conversationId }));
      } catch (error) {
        const current = this.stateStore.get(key);

        if (current) this.stateStore.set(key, { ...current, nextPruneAttemptAt: this.now() + this.pruneRetryMs });
        throw error;
      }

      this.conversations.delete(key);

      for (const [callId, conversationKey] of this.toolCallConversations) {
        if (conversationKey === key) this.toolCallConversations.delete(callId);
      }

      this.stateStore.deleteConversation(key);

      return { deleted: true as const, conversationId };
    });
  }

  /**
   * Delete every idle conversation older than `M365_SESSION_TTL_MINUTES`, so M365's
   * per-account conversation cap is not spent on threads nobody will return to.
   *
   * Unset falls back to `DEFAULT_IDLE_TTL_MINUTES` (a week) rather than disabling
   * reaping: an unbounded pile of idle threads is what trips the throttle in the
   * first place. Set it to `0` to switch reaping off, or to a negative number to
   * opt out explicitly. Deletion is one-way — an idle thread is gone from M365.
   */
  async reapIdle(): Promise<{ pruned: number; failed: number }> {
    const configured = process.env.M365_SESSION_TTL_MINUTES;
    const minutes = configured === undefined ? DEFAULT_IDLE_TTL_MINUTES : Number(configured);

    if (!Number.isFinite(minutes) || minutes <= 0) return { pruned: 0, failed: 0 };
    const cutoff = this.now() - minutes * 60_000;
    let pruned = 0;
    let failed = 0;

    for (const [key, state] of this.stateStore.entries()) {
      if (state.lastAccessedAt > cutoff || (state.nextPruneAttemptAt !== null && state.nextPruneAttemptAt > this.now())) continue;

      if (this.gates.has(key)) continue;

      try {
        const result = await this.prune({ conversationId: state.conversationId });

        if (result) pruned++;
      } catch {
        failed++;
        const current = this.stateStore.get(key);

        if (current) this.stateStore.set(key, { ...current, nextPruneAttemptAt: this.now() + this.pruneRetryMs });
      }
    }

    return { pruned, failed };
  }

  schedule<T>(options: ScheduleOptions, task: () => Promise<T>): Promise<T> {
    return this.scheduler.schedule(options, task);
  }

  diagnostics(): SessionPoolDiagnostics {
    return {
      activeSessions: this.conversations.size,
      persistedSessions: this.stateStore.size,
      scheduler: this.scheduler.stats(),
    };
  }

  private async withKey<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.gates.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.gates.set(key, current);

    if (previous) await previous;

    try {
      return await task();
    } finally {
      release();

      if (this.gates.get(key) === current) this.gates.delete(key);
    }
  }

  private managedKey(messages: Array<{ role: string; tool_calls?: Array<{ id: string }> }>, explicitKey?: string): string {
    this.evictStale();
    const normalizedKey = explicitKey?.trim();

    if (normalizedKey) return this.fingerprint(normalizedKey);

    return this.linkedConversationKey(messages) ?? `ephemeral-${crypto.randomUUID()}`;
  }

  private fingerprint(explicitKey: string): string {
    return createHash("sha256").update(`session:${explicitKey}`).digest("hex").slice(0, 24);
  }

  private conversationsForConversationId(conversationId: string): string | undefined {
    for (const [key, state] of this.conversations) {
      if (state.session.conversationId === conversationId) return key;
    }

    return this.stateStore.findByConversationId(conversationId)?.[0];
  }

  private linkedConversationKey(messages: Array<{ role: string; tool_calls?: Array<{ id: string }> }>): string | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
      const calls = messages[index].role === "assistant" ? messages[index].tool_calls : undefined;

      for (const call of calls ?? []) {
        const key = this.toolCallConversations.get(call.id);

        if (key && this.conversations.has(key)) return key;
      }
    }

    return undefined;
  }

  private evictStale(): void {
    const cutoff = this.now() - MAX_IDLE_MS;

    for (const [key, state] of this.conversations) {
      if (this.gates.has(key) || cutoff <= state.lastAccessedAt) continue;
      log.info(`Evicting idle in-memory conversation ${key}`);
      this.conversations.delete(key);

      for (const [callId, conversationKey] of this.toolCallConversations) {
        if (conversationKey === key) this.toolCallConversations.delete(callId);
      }
    }
  }

  get size(): number {
    return this.conversations.size;
  }
}
