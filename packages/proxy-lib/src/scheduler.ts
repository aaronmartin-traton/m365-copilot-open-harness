export interface ScheduleOptions {
  signal?: AbortSignal;
  newConversation: boolean;
  maintenance?: boolean;
}

export interface SchedulerStats {
  active: number;
  queued: number;
  completed: number;
  rejected: number;
  averageWaitMs: number;
  maxConcurrency: number;
  maxQueueLength: number;
  newThreadsPerMinute: number;
  newThreadBurst: number;
}

export class SchedulerBusyError extends Error {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "SchedulerBusyError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

interface QueueEntry<T> {
  enqueuedAt: number;
  newConversation: boolean;
  maintenance: boolean;
  signal?: AbortSignal;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  removeAbort?: () => void;
}

interface RequestSchedulerOptions {
  maxConcurrency?: number;
  maxQueueLength?: number;
  newThreadsPerMinute?: number;
  newThreadBurst?: number;
  now?: () => number;
}

export class RequestScheduler {
  private readonly maxConcurrency: number;
  private readonly maxQueueLength: number;
  private readonly newThreadsPerMinute: number;
  private readonly newThreadBurst: number;
  private readonly now: () => number;
  private active = 0;
  private queue: Array<QueueEntry<unknown>> = [];
  private tokens: number;
  private lastRefillAt: number;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private completed = 0;
  private rejected = 0;
  private totalWaitMs = 0;

  constructor(options: RequestSchedulerOptions = {}) {
    this.maxConcurrency = positiveInt(options.maxConcurrency, envNumber("M365_MAX_UPSTREAM_CONCURRENCY", 1));
    this.maxQueueLength = nonNegativeInt(options.maxQueueLength, envNumber("M365_MAX_QUEUE_LENGTH", 8));
    this.newThreadsPerMinute = positiveNumber(options.newThreadsPerMinute, envNumber("M365_NEW_THREADS_PER_MINUTE", 2));
    this.newThreadBurst = positiveInt(options.newThreadBurst, envNumber("M365_NEW_THREAD_BURST", 1));
    this.now = options.now ?? Date.now;
    this.tokens = this.newThreadBurst;
    this.lastRefillAt = this.now();
  }

  schedule<T>(options: ScheduleOptions, task: () => Promise<T>): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    this.refillTokens();
    const canStartImmediately = this.active < this.maxConcurrency && this.queue.length === 0 &&
      (!options.newConversation || this.tokens >= 1);
    if (!canStartImmediately && this.queue.length >= this.maxQueueLength) {
      this.rejected++;
      return Promise.reject(new SchedulerBusyError("M365 upstream queue is full", this.retryAfterSeconds()));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        enqueuedAt: this.now(),
        newConversation: options.newConversation,
        maintenance: options.maintenance === true,
        signal: options.signal,
        task,
        resolve,
        reject,
      };
      if (options.signal) {
        const onAbort = () => {
          const index = this.queue.indexOf(entry as QueueEntry<unknown>);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError());
          this.pump();
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        entry.removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.queue.push(entry as QueueEntry<unknown>);
      this.pump();
    });
  }

  stats(): SchedulerStats {
    return {
      active: this.active,
      queued: this.queue.length,
      completed: this.completed,
      rejected: this.rejected,
      averageWaitMs: this.completed ? Math.round(this.totalWaitMs / this.completed) : 0,
      maxConcurrency: this.maxConcurrency,
      maxQueueLength: this.maxQueueLength,
      newThreadsPerMinute: this.newThreadsPerMinute,
      newThreadBurst: this.newThreadBurst,
    };
  }

  private pump(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    this.refillTokens();

    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      let index = this.queue.findIndex((entry) => !entry.newConversation && !entry.maintenance);
      let consumesFreshToken = false;
      if (index < 0 && this.tokens >= 1) {
        index = this.queue.findIndex((entry) => entry.newConversation && !entry.maintenance);
        if (index >= 0) consumesFreshToken = true;
      }
      if (index < 0) {
        index = this.queue.findIndex((entry) => entry.maintenance);
      }
      if (index < 0) {
        this.scheduleWake();
        return;
      }
      if (consumesFreshToken) this.tokens -= 1;

      const entry = this.queue.splice(index, 1)[0];
      entry.removeAbort?.();
      if (entry.signal?.aborted) {
        entry.reject(abortError());
        continue;
      }
      this.active++;
      this.totalWaitMs += Math.max(0, this.now() - entry.enqueuedAt);
      void entry.task().then(entry.resolve, entry.reject).finally(() => {
        this.active--;
        this.completed++;
        this.pump();
      });
    }
  }

  private refillTokens(): void {
    const current = this.now();
    const elapsed = Math.max(0, current - this.lastRefillAt);
    this.lastRefillAt = current;
    this.tokens = Math.min(
      this.newThreadBurst,
      this.tokens + elapsed * (this.newThreadsPerMinute / 60_000),
    );
  }

  private scheduleWake(): void {
    if (this.wakeTimer || this.queue.length === 0) return;
    const missing = Math.max(0, 1 - this.tokens);
    const waitMs = Math.max(1, Math.ceil(missing * 60_000 / this.newThreadsPerMinute));
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.pump();
    }, waitMs);
    this.wakeTimer.unref?.();
  }

  private retryAfterSeconds(): number {
    if (this.active < this.maxConcurrency) return 1;
    return Math.max(1, Math.ceil(60 / this.newThreadsPerMinute));
  }
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : Math.max(1, Math.floor(fallback));
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 0 ? Math.floor(value!) : Math.max(0, Math.floor(fallback));
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? value! : Math.max(Number.EPSILON, fallback);
}

function abortError(): Error {
  const error = new Error("Request aborted while waiting for M365 upstream");
  error.name = "AbortError";
  return error;
}
