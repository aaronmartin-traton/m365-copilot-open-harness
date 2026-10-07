# anti-slop (vendored)

Vendored Oxlint JS plugin, copied into this repository by the
`install-anti-slop` skill. Read-only copy of the skill's bundled asset —
update through the skill, never by hand-editing files under this directory.

## Source

- Origin: the `install-anti-slop` skill's bundled plugin
  (`scripts/install.mjs` payload).
- Source commit: **unknown** — the skill ships the plugin as bundled assets
  without an embedded revision. Recorded as unknown rather than guessed.
  Re-running the installer against a newer skill release is how this is
  refreshed.
- License of the vendored readability rule:
  `vendor/eslint-stylistic/LICENSE` (travels with the copy).

## Installed paths

| Path | What |
|---|---|
| `index.ts` | Plugin entry point; registered as the `anti-slop` jsPlugin. |
| `rules/*.ts` | Individual rules. |
| `shared/*.ts` | Scope/type-resolution helpers shared by the rules. |
| `vendor/eslint-stylistic/` | Vendored readability-rule dependency + its LICENSE. |
| `effect/` | Opt-in Effect rules. **Not enabled** — see below. |

## Configuration

Registered in the repository-root `oxlint.config.ts` along with the 19 generic
rules and the `oxc/no-accumulating-spread` companion.

## Intentional deviations

- **Effect plugin not enabled.** It requires a direct `effect` dependency in a
  package manifest, or an explicit request. `effect` is not a dependency here,
  so `effect/` is present but unregistered.
- **Rule severity kept at `error` throughout.** No rule is downgraded, disabled,
  or suppressed to make the suite pass. Where a finding could not be resolved
  without weakening the code, it is left as a reported finding instead.

## Known outstanding findings

Enabling the plugin surfaced findings in pre-existing code that are outside the
scope of the change that installed it. They are **not** suppressed. Counts by
rule, from `bunx oxlint packages`:

- `no-runtime-typeof` — the M365 frame decoders branch on `typeof` against
  `unknown` payloads. The correct fix is schema-deriving those payload types at
  the frame boundary, which touches the protocol layer.
- `no-unsafe-dictionary-type` / `no-known-value-widening` — open
  `Record<string, …>` shapes in the frame schemas and prompt templates.
- `no-unknown-parameters` / `no-unknown-returns` — same root cause.
- `require-safety-comment-for-type-assertion` — undocumented `as` casts in the
  stream/state plumbing.
- `no-module-mocking` — four test files substitute `ModelSession` via
  `vi.mock`; they now satisfy the `ModelProvider` contract but still mock the
  module rather than injecting a provider.
- `no-conditional-empty-object-spread` — optional-field spreads in the response
  renderers.

The readability rule (`require-readable-spacing`) was applied with lint
autofix and is clean.
