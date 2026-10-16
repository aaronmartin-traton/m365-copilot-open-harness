import { existsSync } from "node:fs";
import path from "node:path";

export type PiBoltSource = "explicit" | "env" | "path" | "missing";

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

function findExecutable(name: string): string | null {
  const pathValue = process.env.PATH ?? "";
  const extensions = executableExtensions();

  for (const directory of pathValue.split(path.delimiter)) {
    if (directory.length === 0) continue;

    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);

      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * Resolve the Pi-Bolt executable: an explicit path, then `PI_BOLT_BIN`, then
 * `pi-bolt` on PATH. Pi-Bolt is the only agent this harness drives, and the
 * repository installs it, so a missing binary is reported rather than papered
 * over with a different one.
 */
export function resolvePiBoltBinary(explicit?: string): PiBoltResolution {
  if (explicit) return { command: explicit, source: "explicit" };

  const fromEnv = process.env.PI_BOLT_BIN;

  if (fromEnv) return { command: fromEnv, source: "env" };

  const piBolt = findExecutable("pi-bolt");

  if (piBolt) return { command: piBolt, source: "path" };

  return { command: "pi-bolt", source: "missing" };
}
