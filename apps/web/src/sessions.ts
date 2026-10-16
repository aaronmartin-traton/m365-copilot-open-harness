import { randomUUID } from "node:crypto";

import {
  PiBoltSupervisor,
  type SupervisorEvent,
  type SupervisorOptions,
} from "@m365-copilot/harness";

/**
 * One browser session owns one Pi-Bolt process. Pi keeps a session in memory
 * across turns, so the console holds the process open and streams its events
 * to whoever is watching that session.
 */

export interface SessionCreateRequest {
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
}

export interface SessionSummary {
  readonly id: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly running: boolean;
  readonly turns: number;
}

interface Session {
  readonly id: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly supervisor: PiBoltSupervisor;
  readonly subscribers: Set<(event: SupervisorEvent) => void>;
  turns: number;
}

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #options: SupervisorOptions;

  constructor(options: SupervisorOptions = {}) {
    this.#options = options;
  }

  create(request: SessionCreateRequest = {}): SessionSummary {
    const id = randomUUID();
    const cwd = request.cwd ?? this.#options.cwd ?? process.cwd();
    const model = request.model ?? this.#options.model ?? null;
    const createdAt = new Date().toISOString();

    const supervisor = new PiBoltSupervisor({
      ...this.#options,
      cwd,
      model: model ?? undefined,
      provider: request.provider ?? this.#options.provider,
    });

    const session: Session = {
      id,
      cwd,
      model,
      createdAt,
      supervisor,
      subscribers: new Set(),
      turns: 0,
    };

    supervisor.onEvent((event) => {
      for (const subscriber of session.subscribers) {
        subscriber(event);
      }
    });
    supervisor.start();
    this.#sessions.set(id, session);

    return { id, cwd, model, createdAt, running: true, turns: 0 };
  }

  list(): SessionSummary[] {
    const summaries: SessionSummary[] = [];

    for (const session of this.#sessions.values()) {
      summaries.push({
        id: session.id,
        cwd: session.cwd,
        model: session.model,
        createdAt: session.createdAt,
        running: session.supervisor.running,
        turns: session.turns,
      });
    }

    return summaries;
  }

  /** Send a prompt to the session's Pi-Bolt process; false when it is unknown. */
  prompt(id: string, message: string): boolean {
    const session = this.#sessions.get(id);

    if (!session) return false;

    session.supervisor.prompt(message);
    session.turns += 1;

    return true;
  }

  abort(id: string): boolean {
    const session = this.#sessions.get(id);

    if (!session) return false;

    session.supervisor.abort();

    return true;
  }

  /** Stream every supervisor event for one session, including its exit. */
  subscribe(id: string, listener: (event: SupervisorEvent) => void): (() => void) | null {
    const session = this.#sessions.get(id);

    if (!session) return null;

    session.subscribers.add(listener);

    return () => {
      session.subscribers.delete(listener);
    };
  }

  async close(id: string): Promise<boolean> {
    const session = this.#sessions.get(id);

    if (!session) return false;

    session.subscribers.clear();
    this.#sessions.delete(id);
    await session.supervisor.stop();

    return true;
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.#sessions.values()];

    this.#sessions.clear();

    for (const session of sessions) {
      session.subscribers.clear();
      await session.supervisor.stop();
    }
  }
}
