# pi-gui fork: archived reference

> **This folder is an archive, not this repo's documentation.**
>
> It records what the
> [`aaronmartin-traton/pi-gui-fork`](https://github.com/aaronmartin-traton/pi-gui-fork)
> checkout of [pi-gui](https://github.com/minghinmatthewlam/pi-gui) did, imported when its
> work was folded into this harness. **Relative links and paths inside these files resolve
> against that fork, not against this repo** — `apps/desktop/...`, `packages/...`,
> `examples/...` and `.agents/...` do not exist here. Read them as history.
>
> Still true in this repo:
>
> - The M365 proxy is pure TypeScript. The vendored Python package and bundled CPython are
>   gone; nothing here needs `pip`.
> - `PI_GUI_M365_PROXY_URL` pointed the desktop app at an external proxy such as this one on
>   `http://127.0.0.1:4141/v1`.
> - The `m365-copilot` provider lives in `~/.pi/agent/models.json`, which Pi-Bolt also reads,
>   so the provider entry carries over unchanged.
>
> Superseded here: the desktop app itself. This repo drives **[Pi-Bolt](../../README.md#web-console)**
> through `packages/harness` and `apps/web`; the Electron shell was not carried over.
>
> For current behavior read [`README.md`](../../README.md), [`CONTEXT.md`](../../CONTEXT.md),
> and [`AGENTS.md`](../../AGENTS.md) instead.

## What is in here

| File | What it recorded |
|---|---|
| [`FORK.md`](FORK.md) | Everything the fork added: the in-app M365 proxy, the PowerShell-first shell, OpenUI rich cards, and the coworker extensions. |
| [`architecture.md`](architecture.md) | The desktop app's renderer/preload/main split, window ownership, and extension-view isolation. |
| [`desktop-README.md`](desktop-README.md) | Desktop setup, test lanes, and packaging commands. |
| [`desktop-AGENTS.md`](desktop-AGENTS.md) | The rules the desktop app was built under. |
| [`AGENTS.md`](AGENTS.md) | Repo guidelines for the fork as a whole. |
| [`ci-baseline.md`](ci-baseline.md) | The baseline checks the fork ran in CI. |
| [`fork/`](fork) | Screenshots of the real Electron app: the rich answer card, M365 Copilot settings, and starter prompts. |
