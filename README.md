# M365 Copilot Proxy

A reverse-engineered, **OpenAI-compatible proxy** for Microsoft 365 Copilot, so
OpenAI-compatible coding agents (pi, Codex, the bench) can use M365 as a model
backend.

- Protocol source of truth: [`docs/m365-copilot-api.md`](docs/m365-copilot-api.md)
- Vocabulary and decisions: [`CONTEXT.md`](CONTEXT.md)
- Agent guidance: [`AGENTS.md`](AGENTS.md)

## Backends

`PROVIDER` selects the backend:

| `PROVIDER` | Backend | Notes |
|---|---|---|
| `m365` (default) | M365 Copilot SignalR/WebSocket | the original backend |
| `chatgpt-web` | ChatGPT Web, driven in a real browser | opt-in; headed only (Cloudflare blocks headless); ToS-constrained |

Adding a backend means implementing `ModelProvider`
(`packages/core/src/provider.ts`) — do not fork the translation layer.

## Development

```sh
bun install
bun run build        # tsdown, all packages
bun run test:unit    # build + vitest
bun run typecheck    # tsc --noEmit per package
```

See [`AGENTS.md`](AGENTS.md) for the gotchas (fenced shell-routing, throttle vs
`Disengaged`, lean toolsets) and the ticket workflow.
