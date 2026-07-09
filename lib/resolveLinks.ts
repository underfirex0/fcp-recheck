import { supabase } from "./supabase";

const VERTEX_REDIRECT_PATTERN = /vertexaisearch\.cloud\.google\.com\/grounding-api-redirect/;

export function isVertexRedirect(url: string): boolean {
  return VERTEX_REDIRECT_PATTERN.test(url);
}

export function needsResolution(sources: string[] | null | undefined): boolean {
  return !!sources && sources.some(isVertexRedirect);
}

/**
 * Follows an HTTP redirect chain to its final destination URL. Tries HEAD
 * first (cheap, no body download); falls back to GET if the server rejects
 * HEAD (405, common on some sites). A per-request timeout keeps one slow or
 * hanging redirect target from blocking the whole batch.
 */
export async function resolveRedirectUrl(url: string, timeoutMs = 10000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
      if (res.status === 405) {
        res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
      }
    } catch {
      res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    }
    return res.url || url;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves only the entries that are actually Vertex redirect links; leaves everything else untouched. */
export async function resolveSourcesArray(sources: string[] | null | undefined): Promise<string[]> {
  if (!sources || sources.length === 0) return sources ?? [];
  return Promise.all(
    sources.map(async (s) => {
      if (!isVertexRedirect(s)) return s;
      try {
        return await resolveRedirectUrl(s);
      } catch {
        return s; // leave the original redirect link if resolution fails/times out
      }
    })
  );
}

export interface LinkRow {
  code_firme: string;
  ca_sources: string[] | null;
  export_sources: string[] | null;
}

/** Rows that still have at least one unresolved Vertex redirect link, capped at `limit`. */
export async function getRowsNeedingLinkResolution(
  limit: number
): Promise<{ rows: LinkRow[]; totalNeeding: number }> {
  const { data, error } = await supabase
    .from("recheck_results")
    .select("code_firme, ca_sources, export_sources");

  if (error) throw new Error(`Failed to fetch recheck_results: ${error.message}`);

  const needing = ((data ?? []) as LinkRow[]).filter(
    (r) => needsResolution(r.ca_sources) || needsResolution(r.export_sources)
  );

  return { rows: needing.slice(0, limit), totalNeeding: needing.length };
}
