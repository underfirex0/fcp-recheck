import type { TavilyResult } from "./types";

const TAVILY_API_URL = "https://api.tavily.com/search";

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
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("Missing TAVILY_API_KEY environment variable.");

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

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tavily search failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];

  return results.map((r: any) => ({
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    // Tavily's basic-depth "content" field is already a cleaned snippet.
    // We cap it defensively so one giant page can't blow up the Gemini prompt.
    content: String(r.content ?? "").slice(0, 1500)
  }));
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
