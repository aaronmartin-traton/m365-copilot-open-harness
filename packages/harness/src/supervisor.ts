import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { resolvePiBoltBinary } from "./pi-bolt.js";
import {
  JsonlReader,
  rpcResponseSchema,
  rpcSettledSchema,
  rpcTextDeltaSchema,
  type RpcLine,
} from "./rpc.js";

/**
 * Drives one Pi-Bolt process over its RPC interface: commands go to stdin,
 * responses and session events come from stdout. Pi-Bolt is Pi compiled ahead
 * of time, so the argv and the protocol are Pi's; `--mode rpc --no-session`
 * keeps the process alive for the whole browser session.
 */

export type SupervisorEvent =
  | { readonly kind: "started"; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: "text"; readonly delta: string }
  | { readonly kind: "settled" }
  | {
      readonly kind: "response";
      readonly id: string | null;
      readonly command: string;
      readonly success: boolean;
      readonly error: string | null;
    }
  | { readonly kind: "record"; readonly record: RpcLine }
  | { readonly kind: "malformed"; readonly line: string }
  | { readonly kind: "stderr"; readonly line: string }
  | { readonly kind: "exit"; readonly code: number | null }
  | { readonly kind: "spawn-error"; readonly message: string };

export type SupervisorEventListener = (event: SupervisorEvent) => void;

export interface SupervisorOptions {
  readonly command?: string;
  readonly commandArgs?: readonly string[];
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly sessionDir?: string;
  readonly extraArgs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly defaultTimeoutMs?: number;
}

/** How the supervisor was launched: the executable and its resolved argv. */
export interface SupervisorLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

interface RpcCommand {
  readonly id: string;
  readonly type: string;
  readonly message?: string;
}

const DEFAULT_TURN_TIMEOUT_MS = 120_000;

const SHUTDOWN_GRACE_MS = 5_000;

export class PiBoltSupervisor {
  readonly #options: SupervisorOptions;
  readonly #listeners = new Set<SupervisorEventListener>();
  readonly #reader: JsonlReader;
  readonly #settleWaiters = new Set<() => void>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #exit: Promise<number | null> | null = null;
  #stderrBuffer = "";
  #promptCounter = 0;

  constructor(options: SupervisorOptions = {}) {
    this.#options = options;
    this.#reader = new JsonlReader({
      onRecord: (record) => {
        this.#route(record);
      },
      onMalformed: (line) => {
        this.#emit({ kind: "malformed", line });
      },
    });
  }

  get running(): boolean {
    return this.#child !== null;
  }

  onEvent(listener: SupervisorEventListener): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  start(): SupervisorLaunch {
    if (this.#child) throw new Error("The Pi-Bolt supervisor is already running.");

    const resolution = resolvePiBoltBinary(this.#options.command);

    if (resolution.source === "missing") {
      throw new Error("Pi-Bolt was not found. Install it, or point PI_BOLT_BIN at its executable.");
    }

    const flags: string[] = ["--mode", "rpc", "--no-session"];

    if (this.#options.provider) flags.push("--provider", this.#options.provider);

    if (this.#options.model) flags.push("--model", this.#options.model);

    if (this.#options.sessionDir) flags.push("--session-dir", this.#options.sessionDir);

    if (this.#options.extraArgs) flags.push(...this.#options.extraArgs);

    const args = [...(this.#options.commandArgs ?? []), ...flags];

    const child = spawn(resolution.command, args, {
      cwd: this.#options.cwd,
      env: this.#options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.#child = child;
    this.#exit = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => {
        resolve(code);
      });
    });

    child.stdout.on("data", (chunk: Buffer) => {
      this.#reader.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.#drainStderr(chunk);
    });
    child.on("error", (error) => {
      this.#emit({ kind: "spawn-error", message: error.message });
    });
    child.on("exit", (code) => {
      this.#reader.flush();
      this.#stderrBuffer = "";
      this.#child = null;
      this.#emit({ kind: "exit", code });
      this.#resolveSettled();
    });

    this.#emit({ kind: "started", command: resolution.command, args });

    return { command: resolution.command, args };
  }

  /** Send a prompt and return the correlation id of the command. */
  prompt(message: string, id?: string): string {
    this.#promptCounter += 1;

    const commandId = id ?? `prompt-${this.#promptCounter}`;

    this.#write({ id: commandId, type: "prompt", message });

    return commandId;
  }

  abort(id = "abort"): void {
    this.#write({ id, type: "abort" });
  }

  /**
   * Resolve once Pi reports `agent_settled`, meaning no retry, compaction or
   * follow-up work will continue on its own. Subscribe before prompting: a
   * fast reply can settle while the prompt response is still in flight.
   */
  waitForSettled(timeoutMs = this.#options.defaultTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settleWaiters.delete(waiter);
        reject(new Error(`Pi-Bolt did not settle within ${timeoutMs}ms.`));
      }, timeoutMs);

      const waiter: () => void = () => {
        clearTimeout(timer);
        this.#settleWaiters.delete(waiter);
        resolve();
      };

      this.#settleWaiters.add(waiter);
    });
  }

  /** Close stdin for an orderly shutdown, forcing a kill if Pi does not exit. */
  async stop(): Promise<void> {
    const child = this.#child;

    if (!child) return;

    const exited = this.#exit ?? Promise.resolve(null);

    const forcedKill = setTimeout(() => {
      child.kill("SIGKILL");
    }, SHUTDOWN_GRACE_MS);

    child.stdin.end();
    await exited;
    clearTimeout(forcedKill);
  }

  async runTurn(message: string, timeoutMs?: number): Promise<string> {
    const deltas: string[] = [];

    const unsubscribe = this.onEvent((event) => {
      if (event.kind === "text") deltas.push(event.delta);
    });

    try {
      this.start();

      const settled = this.waitForSettled(timeoutMs);

      this.prompt(message);
      await settled;
    } finally {
      unsubscribe();
      await this.stop();
    }

    return deltas.join("");
  }

  #write(command: RpcCommand): void {
    const child = this.#child;

    if (!child) throw new Error("The Pi-Bolt supervisor is not running.");

    child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  #route(record: RpcLine): void {
    const delta = rpcTextDeltaSchema.safeParse(record);

    if (delta.success) {
      this.#emit({ kind: "text", delta: delta.data.assistantMessageEvent.delta });

      return;
    }

    const settled = rpcSettledSchema.safeParse(record);

    if (settled.success) {
      this.#emit({ kind: "settled" });
      this.#resolveSettled();

      return;
    }

    const response = rpcResponseSchema.safeParse(record);

    if (response.success) {
      this.#emit({
        kind: "response",
        id: response.data.id ?? null,
        command: response.data.command,
        success: response.data.success,
        error: response.data.error ?? null,
      });

      return;
    }

    this.#emit({ kind: "record", record });
  }

  #drainStderr(chunk: Buffer): void {
    this.#stderrBuffer += chunk.toString("utf8");

    for (
      let boundary = this.#stderrBuffer.indexOf("\n");
      boundary !== -1;
      boundary = this.#stderrBuffer.indexOf("\n")
    ) {
      const line = this.#stderrBuffer.slice(0, boundary).trimEnd();

      this.#stderrBuffer = this.#stderrBuffer.slice(boundary + 1);

      if (line.length > 0) this.#emit({ kind: "stderr", line });
    }
  }

  #resolveSettled(): void {
    const waiters = [...this.#settleWaiters];

    this.#settleWaiters.clear();

    for (const waiter of waiters) {
      waiter();
    }
  }

  #emit(event: SupervisorEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
