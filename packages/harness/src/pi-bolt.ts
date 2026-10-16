import { existsSync } from "node:fs";
import path from "node:path";

export type PiBoltSource = "explicit" | "env" | "path" | "fallback" | "missing";

export interface PiBoltResolution {
  readonly command: string;
  readonly source: PiBoltSource;
}

const WINDOWS_EXTENSIONS: readonly string[] = [".exe", ".cmd", ".bat", ""];

const POSIX_EXTENSIONS: readonly string[] = [""];

function executableExtensions(): readonly string[] {
  if (process.platform !== "win32") return POSIX_EXTENSIONS;

  const configured = process.env.PATHEXT;

  if (!configured) return WINDOWS_EXTENSIONS;

  return configured.split(";").map((extension) => extension.toLowerCase());
}

function findOnPath(names: readonly string[]): string | null {
  const pathValue = process.env.PATH ?? "";
  const extensions = executableExtensions();

  for (const directory of pathValue.split(path.delimiter)) {
    if (directory.length === 0) continue;

    for (const name of names) {
      for (const extension of extensions) {
        const candidate = path.join(directory, name + extension);

        if (existsSync(candidate)) return candidate;
      }
    }
  }

  return null;
}

/**
 * Resolve the Pi-Bolt executable: an explicit path, then `PI_BOLT_BIN`, then
 * `pi-bolt` on PATH, then `pi`. Pi-Bolt is Pi compiled ahead of time and keeps
 * Pi's CLI, so `pi` drives the same RPC interface when Pi-Bolt is absent.
 */
export function resolvePiBoltBinary(explicit?: string): PiBoltResolution {
  if (explicit) return { command: explicit, source: "explicit" };

  const fromEnv = process.env.PI_BOLT_BIN;

  if (fromEnv) return { command: fromEnv, source: "env" };

  const piBolt = findOnPath(["pi-bolt"]);

  if (piBolt) return { command: piBolt, source: "path" };

  const pi = findOnPath(["pi"]);

  if (pi) return { command: pi, source: "fallback" };

  return { command: "pi-bolt", source: "missing" };
}
