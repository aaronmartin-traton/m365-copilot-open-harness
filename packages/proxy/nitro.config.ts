// Nitro server config for the M365 Copilot proxy.
// Routes live under routes/, the startup auth lives in plugins/, CORS in middleware/.
export default defineNitroConfig({
  compatibilityDate: "2025-01-01",
  preset: "node-server",
  externals: {
    // Nitro's node-externals plugin copies each external into
    // .output/server/node_modules/<pkg>/ and rewrites its package.json.
    // Keep copied files writable for that rewrite.
    chmod: true,
  },
});
