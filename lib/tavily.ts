import type { TavilyResult } from "./types";

const TAVILY_API_URL = "https://api.tavily.com/search";

/**
 * Supports one OR several Tavily API keys.
 *
 * Set TAVILY_API_KEYS as a comma-separated list (e.g. "tvly-aaa,tvly-bbb,tvly-ccc")
 * to spread usage across multiple free-tier accounts (1,000 credits each). The
 * app automatically moves to the next key when the current one:
 *   - returns HTTP 432 (Tavily's "insufficient credits" response), or
 *   - keeps returning HTTP 429 (rate limited) after a short retry.
 *
 * Falls back to the single TAVILY_API_KEY variable if TAVILY_API_KEYS isn't set,
 * so existing single-key setups keep working unchanged.
 *
 * Rotation state is kept in module scope (resets on a fresh serverless cold
 * start). That's fine here: a stale/exhausted key just costs one wasted 432
 * response (no credits are consumed on a rejected request) before the code
 * self-corrects and moves to the next key — no manual intervention needed.
 */
function getKeyPool(): string[] {
  const multi = process.env.TAVILY_API_KEYS;
  if (multi && multi.trim().length > 0) {
    return multi
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
  }
  const single = process.env.TAVILY_API_KEY;
  if (single) return [single];
  throw new Error("Missing TAVILY_API_KEYS (or TAVILY_API_KEY) environment variable.");
}

let currentKeyIndex = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a single Tavily "basic" search and returns a trimmed list of results.
 * Basic depth = 1 credit per call. We deliberately do NOT default to "advanced"
 * (2 credits) to keep the search bill minimal — see the cost discussion in the
 * project README.
 */
export async function tavilySearch(
  query: string,
  maxResults = 5
): Promise<TavilyResult[]> {
  const keys = getKeyPool();
  let lastError: Error | null = null;

  // Try each key in the pool, starting from wherever we currently are.
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const keyIndex = (currentKeyIndex + attempt) % keys.length;
    const apiKey = keys[keyIndex];

    for (let rateLimitRetry = 0; rateLimitRetry < 2; rateLimitRetry++) {
      const res = await fetch(TAVILY_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: "basic",
          max_results: maxResults,
          include_answer: false,
          include_raw_content: false
        })
      });

      if (res.ok) {
        currentKeyIndex = keyIndex; // stick with this key for subsequent calls
        const data = await res.json();
        const results = Array.isArray(data.results) ? data.results : [];
        return results.map((r: any) => ({
          title: String(r.title ?? ""),
          url: String(r.url ?? ""),
          content: String(r.content ?? "").slice(0, 1500)
        }));
      }

      if (res.status === 432) {
        // This key's credits are exhausted — move on to the next key entirely,
        // no point retrying it.
        lastError = new Error(`Tavily key #${keyIndex + 1} out of credits (432).`);
        break; // breaks the rate-limit retry loop, falls through to next key
      }

      if (res.status === 429) {
        // Rate limited — short backoff, then retry the SAME key once before
        // giving up on it for this call.
        const retryAfter = Number(res.headers.get("retry-after")) || 2;
        lastError = new Error(`Tavily key #${keyIndex + 1} rate limited (429).`);
        await sleep(Math.min(retryAfter, 5) * 1000);
        continue;
      }

      // Any other error (400/401/500/etc.) — not a credit/rate issue, no point
      // rotating keys for it. Fail fast with the real error message.
      const text = await res.text().catch(() => "");
      throw new Error(`Tavily search failed (${res.status}): ${text}`);
    }
  }

  throw new Error(
    `All Tavily keys exhausted or rate-limited. Last error: ${lastError?.message ?? "unknown"}`
  );
}

/** Formats a list of Tavily results into plain text suitable for a prompt. */
export function formatResultsForPrompt(
  label: string,
  results: TavilyResult[]
): string {
  if (results.length === 0) {
    return `[${label}] Aucun résultat de recherche trouvé.`;
  }
  return (
    `[${label}]\n` +
    results
      .map(
        (r, i) =>
          `(${i + 1}) ${r.title}\nURL: ${r.url}\nExtrait: ${r.content}`
      )
      .join("\n\n")
  );
}

