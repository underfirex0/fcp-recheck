import { supabase } from "./supabase";

const VERTEX_REDIRECT_PATTERN = /vertexaisearch\.cloud\.google\.com\/grounding-api-redirect/;

// A company stops being retried after this many resolution passes, regardless
// of whether links were fixed — this is the hard safety net against an
// infinite loop, independent of whatever the underlying failure cause is.
const MAX_ATTEMPTS = 3;

// A real browser User-Agent. Google's grounding-redirect endpoint appears to
// respond differently (often just echoing the same URL back with a 200
// instead of actually redirecting) to bare server-to-server requests with no
// User-Agent — this was very likely the actual cause of links that never
// resolved no matter how many times they were retried.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

export function isVertexRedirect(url: string): boolean {
  return VERTEX_REDIRECT_PATTERN.test(url);
}

export function needsResolution(sources: string[] | null | undefined): boolean {
  return !!sources && sources.some(isVertexRedirect);
}

/**
 * Follows an HTTP redirect chain to its final destination URL. Tries HEAD
 * first (cheap, no body download); falls back to GET if the server rejects
 * HEAD (405) or doesn't actually redirect on HEAD. A per-request timeout
 * keeps one slow/hanging target from blocking the whole batch.
 *
 * Returns `null` (not the original URL) when resolution genuinely didn't
 * work — i.e. the "resolved" URL came back identical to what was requested,
 * meaning no real redirect happened. Callers must NOT silently treat that as
 * success; it's what previously caused links to loop forever.
 */
export async function resolveRedirectUrl(url: string, timeoutMs = 10000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, { method: "HEAD", redirect: "follow", headers: BROWSER_HEADERS, signal: controller.signal });
      if (res.status === 405 || res.url === url) {
        res = await fetch(url, { method: "GET", redirect: "follow", headers: BROWSER_HEADERS, signal: controller.signal });
      }
    } catch {
      res = await fetch(url, { method: "GET", redirect: "follow", headers: BROWSER_HEADERS, signal: controller.signal });
    }
    if (!res.url || res.url === url || isVertexRedirect(res.url)) {
      return null; // no genuine redirect happened — a real failure, not a success
    }
    return res.url;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves only the entries that are actually Vertex redirect links.
 * Returns the updated array plus how many entries were ACTUALLY changed
 * (for accurate progress reporting — previously this was conflated with
 * "companies checked", which inflated the displayed count).
 */
export async function resolveSourcesArray(
  sources: string[] | null | undefined
): Promise<{ sources: string[]; resolvedCount: number }> {
  if (!sources || sources.length === 0) return { sources: sources ?? [], resolvedCount: 0 };

  let resolvedCount = 0;
  const result = await Promise.all(
    sources.map(async (s) => {
      if (!isVertexRedirect(s)) return s;
      const resolved = await resolveRedirectUrl(s);
      if (resolved) {
        resolvedCount++;
        return resolved;
      }
      return s; // genuine failure — leave the original link, don't fabricate a change
    })
  );
  return { sources: result, resolvedCount };
}

export interface LinkRow {
  code_firme: string;
  ca_sources: string[] | null;
  export_sources: string[] | null;
  link_resolve_attempts: number | null;
}

/**
 * Rows that still have at least one unresolved Vertex redirect link AND
 * haven't already exhausted their retry budget, capped at `limit`.
 */
export async function getRowsNeedingLinkResolution(
  limit: number
): Promise<{ rows: LinkRow[]; totalNeeding: number; totalExhausted: number }> {
  const { data, error } = await supabase
    .from("recheck_results")
    .select("code_firme, ca_sources, export_sources, link_resolve_attempts");

  if (error) throw new Error(`Failed to fetch recheck_results: ${error.message}`);

  const candidates = ((data ?? []) as LinkRow[]).filter(
    (r) => needsResolution(r.ca_sources) || needsResolution(r.export_sources)
  );

  const needing = candidates.filter((r) => (r.link_resolve_attempts ?? 0) < MAX_ATTEMPTS);
  const totalExhausted = candidates.length - needing.length;

  return { rows: needing.slice(0, limit), totalNeeding: needing.length, totalExhausted };
}
