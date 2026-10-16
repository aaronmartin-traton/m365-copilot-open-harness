import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      deps: {
        inline: ["zod"],
      },
    },
    setupFiles: ["./vitest.setup.ts"],
    // `adopt-proxy-improvements` is a separate git worktree of this repository
    // used for a migration experiment, and `npm-cache` is Bun's local cache.
    // Neither belongs to this workspace, and both would otherwise be scanned.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.bun/**",
      "**/.output/**",
      "npm-cache/**",
      "adopt-proxy-improvements/**",
      "**/adopt-proxy-improvements/**",
    ],
  },
});
