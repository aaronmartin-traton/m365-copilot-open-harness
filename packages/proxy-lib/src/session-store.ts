import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface PersistedSessionState {
  sessionId: string;
  conversationId: string;
  turnCount: number;
  sentMessageCount: number;
  lastAccessedAt: number;
  restorable: boolean;
  nextPruneAttemptAt: number | null;
}

interface StoreData {
  version: 2;
  sessions: Record<string, PersistedSessionState>;
  responseIds: Record<string, string>;
}

interface LegacyStoreData {
  version: 1;
  sessions: Record<string, Omit<PersistedSessionState, "restorable" | "nextPruneAttemptAt">>;
}

export class SessionStateStore {
  private readonly path: string;
  private data: StoreData;

  constructor(path = defaultPath()) {
    this.path = path;
    this.data = this.load();
  }

  get(key: string): PersistedSessionState | undefined {
    return this.data.sessions[key];
  }

  set(key: string, state: PersistedSessionState): void {
    this.data.sessions[key] = state;
    this.save();
  }

  entries(): Array<[string, PersistedSessionState]> {
    return Object.entries(this.data.sessions);
  }

  findByConversationId(conversationId: string): [string, PersistedSessionState] | undefined {
    for (const entry of this.entries()) {
      if (entry[1].conversationId === conversationId) return entry;
    }
    return undefined;
  }

  bindResponseId(responseId: string, key: string): void {
    if (!this.data.sessions[key]) return;
    this.data.responseIds[responseId] = key;
    this.save();
  }

  lookupResponseId(responseId: string): string | undefined {
    const key = this.data.responseIds[responseId];
    return key && this.data.sessions[key] ? key : undefined;
  }

  deleteConversation(key: string): void {
    let changed = key in this.data.sessions;
    delete this.data.sessions[key];
    for (const [responseId, mappedKey] of Object.entries(this.data.responseIds)) {
      if (mappedKey === key) {
        delete this.data.responseIds[responseId];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  get size(): number {
    return Object.keys(this.data.sessions).length;
  }

  private load(): StoreData {
    if (!existsSync(this.path)) return { version: 2, sessions: {}, responseIds: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoreData> | LegacyStoreData;
      if (parsed?.version === 2 && parsed.sessions && typeof parsed.sessions === "object" &&
          parsed.responseIds && typeof parsed.responseIds === "object") {
        return {
          version: 2,
          sessions: parsed.sessions as Record<string, PersistedSessionState>,
          responseIds: parsed.responseIds as Record<string, string>,
        };
      }
      if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object") {
        const sessions: Record<string, PersistedSessionState> = {};
        for (const [key, state] of Object.entries(parsed.sessions)) {
          if (!state || typeof state !== "object") continue;
          sessions[key] = {
            ...(state as Omit<PersistedSessionState, "restorable" | "nextPruneAttemptAt">),
            restorable: true,
            nextPruneAttemptAt: null,
          };
        }
        return { version: 2, sessions, responseIds: {} };
      }
    } catch {
      // Corrupt state is disposable. Never block proxy startup.
    }
    return { version: 2, sessions: {}, responseIds: {} };
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, this.path);
    } catch {
      // Continuity persistence is best effort; in-memory sessions still work.
    }
  }
}


function defaultPath(): string {
  return process.env.M365_SESSION_STATE_FILE || join(homedir(), ".config", "opencode-m365", "session-state.json");
}

