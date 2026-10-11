import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod/v4";

/**
 * One conversation's persisted continuity state, plus the schema that decodes
 * it from `session-state.json`. That file is external input — it survives
 * crashes, hand-edits and older proxy versions — so every field is validated
 * here before any caller reads it.
 */
const PersistedSessionStateSchema = z.object({
  sessionId: z.string(),
  conversationId: z.string(),
  turnCount: z.number(),
  sentMessageCount: z.number(),
  lastAccessedAt: z.number(),
  restorable: z.boolean(),
  nextPruneAttemptAt: z.number().nullable(),
});

export type PersistedSessionState = z.infer<typeof PersistedSessionStateSchema>;

/** Version-1 records predate the prune/restore flags. */
const LegacySessionStateSchema = PersistedSessionStateSchema.omit({
  restorable: true,
  nextPruneAttemptAt: true,
});

const StoreDataSchema = z.object({
  version: z.literal(2),
  sessions: z.record(z.string(), PersistedSessionStateSchema),
  responseIds: z.record(z.string(), z.string()),
});

const LegacyStoreDataSchema = z.object({
  version: z.literal(1),
  sessions: z.record(z.string(), LegacySessionStateSchema),
});

type StoreData = z.infer<typeof StoreDataSchema>;

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
      const raw: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      const current = StoreDataSchema.safeParse(raw);

      if (current.success) return current.data;

      const legacy = LegacyStoreDataSchema.safeParse(raw);

      if (legacy.success) {
        const sessions: Record<string, PersistedSessionState> = {};

        for (const [key, state] of Object.entries(legacy.data.sessions)) {
          sessions[key] = { ...state, restorable: true, nextPruneAttemptAt: null };
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

