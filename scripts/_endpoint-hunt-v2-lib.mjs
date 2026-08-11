// Pure helpers for usage-endpoint-hunt-v2.mjs. No I/O, no M365 imports.
//
// Browser header literals harvested from the WS probes (scripts/_probe-chat.mjs,
// frame-dump-probe.mjs, variants-bisect.mjs): Origin https://m365.cloud.microsoft
// + Firefox 148.0 UA. Accept-Language is a browser-default literal for the
// repo's en-gb locale.

export function buildBrowserHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    Origin: "https://m365.cloud.microsoft",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0",
    "Accept-Language": "en-GB,en;q=0.9",
  };
}

// v1 parity: a response is "interesting" when it is 2xx, or a 4xx/5xx that is
// NOT 404/401/403 (those are the generic not-found / unauthenticated walls —
// their presence says nothing about the endpoint). 3xx is neither ok nor
// interesting for the live log, but pickWinners still surfaces it.
export function classifyResult(status) {
  const ok = status >= 200 && status < 300;
  const interesting = ok || (status >= 400 && status !== 404 && status !== 401 && status !== 403);
  return { ok, interesting };
}

// v1 parity: winners are the 2xx/3xx rows (falsy status rows are skipped).
export function pickWinners(results) {
  return results.filter((r) => r.status && r.status >= 200 && r.status < 400);
}

// v1 parity: record the envelope + first 800 characters of the body.
export function normalizeResult({ tag, method, url, kind, status, contentType, body = "" }) {
  return { tag, method, url, kind, status, contentType, body: body.slice(0, 800) };
}

// v1 parity: a failed fetch becomes a row with the error message, no status/body.
export function errorResult({ tag, method, url, kind, error }) {
  return { tag, method, url, kind, error };
}
