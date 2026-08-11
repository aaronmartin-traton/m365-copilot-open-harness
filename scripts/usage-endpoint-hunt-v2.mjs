// v2 of scripts/usage-endpoint-hunt.mjs — the same endpoint sweep, but with
// FULL browser headers (Origin / User-Agent / Accept-Language) instead of bare
// REST headers. F5 ("no REST token-usage endpoint") is low-confidence; the
// server may answer browser-like and curl-like requests differently.
// Read-only — GETs only. Run unsandboxed.
//
// Usage: M365_NO_INTERACTIVE=1 node scripts/usage-endpoint-hunt-v2.mjs
//
// Candidate list intentionally duplicated from v1: it is a frozen one-cycle
// research input, not maintained state. Keep it in sync with v1 until F5 lands.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTokenForScope, getToken, decodeJwt } from "../packages/core/dist/index.mjs";
import { buildBrowserHeaders, classifyResult, normalizeResult, errorResult, pickWinners } from "./_endpoint-hunt-v2-lib.mjs";

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "usage-endpoint-out", TS);
mkdirSync(OUT, { recursive: true });

const sydney = await getToken();
const claims = decodeJwt(sydney);
const tid = claims.tid;
const oid = claims.oid;

const pp = await getTokenForScope(["https://api.powerplatform.com/.default"]).catch(() => null);
const bap = await getTokenForScope(["https://api.bap.microsoft.com/.default"]).catch(() => null);

console.log(`[hunt] sydney=${!!sydney} pp=${!!pp} bap=${!!bap}`);
console.log(`[hunt] tid=${tid} oid=${oid}`);

// --- Discover the env URL via BAP (same logic as agent.ts).
let envUrl = null;
if (bap) {
  const er = await fetch(
    `https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/~default?api-version=2023-06-01`,
    { headers: { Authorization: `Bearer ${bap}` } },
  );
  const env = await er.json();
  const envId = env.name.replace(/^Default-/i, "").replace(/-/g, "").toLowerCase();
  const envCandidates = [
    `https://default${envId}.df.environment.api.powerplatform.com`,
    `https://default${envId.slice(0, -2)}.df.environment.api.powerplatform.com`,
  ];
  for (const c of envCandidates) {
    const p = await fetch(`${c}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`, { method: "HEAD", headers: { Authorization: `Bearer ${pp}` } }).catch(() => null);
    if (p) { envUrl = c; break; }
  }
}
console.log(`[hunt] envUrl=${envUrl}`);

// --- Endpoints to probe. Pair each with the most plausible token.
// Tags: `usage` = looks for token/message counts, `limits` = context-window
// type limits, `model` = available models/tones, `meta` = environment meta.
const candidates = [
  // Sydney (substrate.office.com) — the chat host. Try GET on the chat hub
  // base + plausible sibling REST paths.
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/me/usage", "usage"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/usage", "usage"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/me/license", "limits"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/me", "meta"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/quota", "limits"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/conversations", "meta"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/models", "model"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/UsageMetrics", "usage"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v2/me", "meta"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/limits", "limits"],
  ["sydney", "GET", "https://substrate.office.com/sydney/api/usage", "usage"],
  ["sydney", "GET", "https://substrate.office.com/sydney/m365copilot/usage", "usage"],
  ["sydney", "GET", "https://substrate.office.com/sydney/m365copilot/limits", "limits"],
  ["sydney", "GET", "https://substrate.office.com/sydney/m365copilot/tones", "model"],
  // Substrate sibling endpoints (some real ones live under /api/v1 too)
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/me/conversations", "meta"],
];

// PP candidates are appended unconditionally; when the pp token or envUrl
// discovery fails, the tokensByTag skip path below logs a `[skip]` so every
// candidate still gets a verdict (or an explicit "no token" note).
if (envUrl) {
  candidates.push(
    ["pp", "GET", `${envUrl}/analytics/api/conversations?api-version=2022-03-01-preview`, "usage"],
    ["pp", "GET", `${envUrl}/analytics/api/usage?api-version=2022-03-01-preview`, "usage"],
    ["pp", "GET", `${envUrl}/copilotstudio/analytics/api?api-version=2022-03-01-preview`, "usage"],
    ["pp", "GET", `${envUrl}/copilotstudio/usage/api?api-version=2022-03-01-preview`, "usage"],
    ["pp", "GET", `${envUrl}/copilotstudio/aiModels/api?api-version=2022-03-01-preview`, "model"],
    ["pp", "GET", `${envUrl}/copilotstudio/api/metering?api-version=2022-03-01-preview`, "usage"],
  );
}
if (!pp) {
  console.log("[skip] (no pp token) — 6 PP analytics/metadata endpoints omitted");
}
if (pp && !envUrl) {
  console.log("[skip] envUrl discovery failed — 6 PP endpoints not probed (no environment URL)");
}

if (bap) {
  candidates.push(
    ["bap", "GET", `https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/listConsumption?api-version=2023-06-01`, "usage"],
    ["bap", "GET", `https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/me?api-version=2023-06-01`, "meta"],
    ["bap", "GET", `https://api.bap.microsoft.com/providers/PowerPlatform.Governance/copilot/usage?api-version=2023-06-01`, "usage"],
  );
}

const tokensByTag = { sydney, pp, bap };
const results = [];

for (const [tag, method, url, kind] of candidates) {
  const tok = tokensByTag[tag];
  if (!tok) {
    console.log(`[skip] (no ${tag} token) ${url}`);
    continue;
  }
  try {
    const r = await fetch(url, { method, headers: buildBrowserHeaders(tok) });
    const ct = r.headers.get("content-type") ?? "";
    const body = await r.text().catch(() => "");
    const { interesting } = classifyResult(r.status);
    console.log(`[${tag}] ${method} ${r.status} ${url} ${interesting ? "  <- LOOK" : ""}`);
    results.push(normalizeResult({ tag, method, url, kind, status: r.status, contentType: ct, body }));
  } catch (e) {
    console.log(`[${tag}] ${method} ERR  ${url} (${e.message})`);
    results.push(errorResult({ tag, method, url, kind, error: e.message }));
  }
}

writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\n[done] ${results.length} endpoints probed. ${OUT}/results.json`);

// Highlight the 2xx/3xx successes
const winners = pickWinners(results);
console.log(`\n[winners] ${winners.length} 2xx/3xx`);
for (const w of winners) console.log(`  ${w.status} ${w.method} ${w.url}`);