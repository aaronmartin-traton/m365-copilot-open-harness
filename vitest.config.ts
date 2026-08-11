import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      deps: {
        inline: ["zod"],
      },
    },
    setupFiles: ["./vitest.setup.ts"],
  },
});
