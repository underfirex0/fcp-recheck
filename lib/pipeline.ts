import { supabase } from "./supabase";
import { tavilySearch, formatResultsForPrompt } from "./tavily";
import { extractCompanyData } from "./gemini";
import { getBracket, bracketsMatch } from "./seg";
import type { Company, RecheckResult, Verdict } from "./types";

function buildCaQuery(c: Company): string {
  const parts = [c.raison_sociale, c.ville, "chiffre d'affaires MAD"];
  if (c.annee_ca_actuelle) parts.push(String(c.annee_ca_actuelle));
  return parts.filter(Boolean).join(" ");
}

function buildExportQuery(c: Company): string {
  return [c.raison_sociale, "chiffre d'affaires export pourcentage"]
    .filter(Boolean)
    .join(" ");
}

function computeVerdict(
  caStatus: string,
  bracketCurrent: string | null,
  bracketSuggested: string | null
): Verdict {
  if (caStatus === "not_found") return "Donnée insuffisante";
  if (bracketSuggested && bracketsMatch(bracketCurrent, bracketSuggested)) {
    return "Confirmé";
  }
  // Covers both "conflicting" and "confirmed but different bracket".
  return "À corriger";
}

/**
 * Processes exactly one company end-to-end: 2 Tavily searches, one Gemini
 * extraction call (with automatic Pro escalation where needed), deterministic
 * bracket lookup, and verdict computation. Does NOT write to Supabase —
 * callers are responsible for persisting the result (keeps this testable).
 */
export async function processCompany(company: Company): Promise<RecheckResult> {
  const [caResults, exportResults] = await Promise.all([
    tavilySearch(buildCaQuery(company)),
    tavilySearch(buildExportQuery(company))
  ]);

  const caContext = formatResultsForPrompt("Chiffre d'Affaires", caResults);
  const exportContext = formatResultsForPrompt("Part Export", exportResults);

  const { result, caModelUsed, exportModelUsed } = await extractCompanyData(
    company,
    caContext,
    exportContext
  );

  const bracketSuggested = getBracket(result.ca.value_mad);
  const verdict = computeVerdict(
    result.ca.status,
    company.tranche_ca_actuelle,
    bracketSuggested
  );

  return {
    code_firme: company.code_firme,
    ca_value_mad: result.ca.value_mad,
    ca_year: result.ca.year,
    ca_status: result.ca.status,
    ca_confidence: result.ca.confidence,
    ca_sources: result.ca.sources,
    ca_reasoning: result.ca.reasoning,
    ca_bracket_current: company.tranche_ca_actuelle,
    ca_bracket_suggested: bracketSuggested,
    ca_verdict: verdict,
    ca_model_used: caModelUsed,

    export_pct: result.export.pct,
    export_year: result.export.year,
    export_status: result.export.status,
    export_confidence: result.export.confidence,
    export_sources: result.export.sources,
    export_reasoning: result.export.reasoning,
    export_model_used: exportModelUsed,

    processed_at: new Date().toISOString()
  };
}

/**
 * Fetches up to `limit` companies that don't yet have a recheck_results row,
 * processes them one by one (small sequential delay-free loop — Tavily/Gemini
 * calls for different companies are independent), and upserts each result as
 * soon as it's ready so a crash mid-batch doesn't lose completed work.
 *
 * Returns per-company success/failure so the UI can show partial progress.
 */
export async function processBatch(limit: number) {
  // PostgREST doesn't support "NOT IN (subquery)" through the JS query builder,
  // and the dataset here is small (a few hundred rows), so we just diff two
  // plain selects in memory rather than reaching for an RPC/view.
  const [{ data: allCompanies, error: companiesError }, { data: doneRows, error: doneError }] =
    await Promise.all([
      supabase.from("companies").select("*"),
      supabase.from("recheck_results").select("code_firme")
    ]);

  if (companiesError) throw new Error(`Failed to fetch companies: ${companiesError.message}`);
  if (doneError) throw new Error(`Failed to fetch recheck_results: ${doneError.message}`);

  const doneSet = new Set((doneRows ?? []).map((r) => r.code_firme));
  const pending = (allCompanies ?? []).filter((c) => !doneSet.has(c.code_firme));
  const companies = pending.slice(0, limit);

  if (companies.length === 0) {
    return { processed: 0, failed: [] as { code_firme: string; error: string }[], remaining: 0 };
  }


  const failed: { code_firme: string; error: string }[] = [];
  let processed = 0;

  // Small concurrency (3 at a time) — enough to not be painfully slow over
  // 584 companies, gentle enough to avoid tripping Tavily/Gemini rate limits.
  const CONCURRENCY = 3;
  for (let i = 0; i < companies.length; i += CONCURRENCY) {
    const chunk = companies.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (company) => {
        try {
          const result = await processCompany(company as Company);
          const { error: upsertError } = await supabase
            .from("recheck_results")
            .upsert(result, { onConflict: "code_firme" });
          if (upsertError) throw new Error(upsertError.message);
          processed++;
        } catch (err: any) {
          failed.push({ code_firme: company.code_firme, error: String(err?.message ?? err) });
        }
      })
    );
  }

  const remaining = Math.max(0, pending.length - companies.length);

  return { processed, failed, remaining };
}
