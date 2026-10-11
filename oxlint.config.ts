export default {
  ignorePatterns: [
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  // Enforced on code this fork OWNS: every path `.gitattributes` declares
  // `merge=ours`, plus every file the fork added. Files below track upstream —
  // they exist in `upstream/main` and are not declared owned — so they are
  // exempt: upstream does not satisfy these rules, and "fixing" upstream code
  // here would force a permanent merge divergence (see docs/upstream-manifest.json).
  // Regenerate with:
  //   git ls-files packages | grep -E '\.(ts|mjs)$' | while read -r f; do
  //     git cat-file -e "upstream/main:$f" 2>/dev/null &&
  //       ! grep -q "^$f merge=ours" .gitattributes && echo "$f"; done
  overrides: [
    {
      files: [
        "packages/core/src/agent.test.ts",
        "packages/core/src/auth.ts",
        "packages/core/src/copilot.ts",
        "packages/core/src/image.test.ts",
        "packages/core/src/image.ts",
        "packages/core/src/index.ts",
        "packages/core/src/log.test.ts",
        "packages/core/src/log.ts",
        "packages/core/src/model.ts",
        "packages/core/src/native-actions.test.ts",
        "packages/core/src/native-actions.ts",
        "packages/core/src/schemas.ts",
        "packages/openclaw-plugin/src/index.test.ts",
        "packages/openclaw-plugin/src/index.ts",
        "packages/openclaw-plugin/src/setup.ts",
        "packages/proxy-lib/src/index.test.ts",
        "packages/proxy-lib/src/index.ts",
        "packages/proxy-lib/src/schemas.test.ts",
        "packages/proxy-lib/src/schemas.ts",
        "packages/proxy-lib/src/streaming.test.ts",
        "packages/proxy/bin/m365-proxy.mjs",
        "packages/proxy/middleware/cors.ts",
        "packages/proxy/nitro.config.ts",
        "packages/proxy/plugins/auth.ts",
        "packages/proxy/routes/health.get.ts",
        "packages/proxy/routes/v1/chat/completions.post.ts",
        "packages/proxy/routes/v1/models.get.ts",
        "packages/proxy/server-pool.ts",
      ],
      rules: {
        // Upstream's code, not ours: the entire suite is off here, so a rule
        // that starts firing in upstream code cannot redden this repo's lint.
        "oxc/no-accumulating-spread": "off",
        "anti-slop/no-array-filter-map": "off",
        "anti-slop/no-reduce-accumulator-copy": "off",
        "anti-slop/no-chained-type-assertions": "off",
        "anti-slop/no-conditional-empty-object-spread": "off",
        "anti-slop/no-known-value-widening": "off",
        "anti-slop/no-module-mocking": "off",
        "anti-slop/no-object-parameters": "off",
        "anti-slop/no-reflect-apply": "off",
        "anti-slop/no-reflect-get": "off",
        "anti-slop/no-runtime-typeof": "off",
        "anti-slop/no-shape-in-symbol-names": "off",
        "anti-slop/no-unknown-parameters": "off",
        "anti-slop/no-unknown-returns": "off",
        "anti-slop/no-unknown-type-aliases": "off",
        "anti-slop/no-unsafe-dictionary-type": "off",
        "anti-slop/no-widen-then-assert": "off",
        "anti-slop/require-readable-spacing": "off",
        "anti-slop/require-safety-comment-for-type-assertion": "off",
      },
    },
  ],

  rules: {
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
}
