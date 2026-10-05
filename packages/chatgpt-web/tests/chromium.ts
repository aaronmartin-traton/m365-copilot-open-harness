/**
 * Locating a Chromium for the browser tests.
 *
 * Playwright pins the browser revision it expects, and a host's cache may hold
 * a different one — then `chromium.launch()` fails with "Executable doesn't
 * exist" even though a perfectly good Chromium is installed. The app already
 * has an escape hatch for this (`CHROMIUM_PATH`, used by the M365 login); these
 * tests use the same one, then fall back to scanning the cache, so a developer
 * does not have to hand-set an env var to run the suite.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE = join(homedir(), ".cache", "ms-playwright");

/** Relative paths a Playwright chromium build uses, across platforms. */
const BINARIES = [
  ["chrome-linux64", "chrome"],
  ["chrome-linux", "chrome"],
  ["chrome-win", "chrome.exe"],
  ["chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
  ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
];

/**
 * An explicit Chromium to launch, or undefined to let Playwright choose its
 * own. Prefers `CHROMIUM_PATH`, then the newest cached revision.
 */
export function chromiumExecutable(): string | undefined {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }

  if (!existsSync(CACHE)) return undefined;

  const revisions = readdirSync(CACHE)
    .filter((name) => name.startsWith("chromium-"))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));

  for (const revision of revisions) {
    for (const segments of BINARIES) {
      const candidate = join(CACHE, revision, ...segments);

      if (existsSync(candidate)) return candidate;
    }
  }

  return undefined;
}
