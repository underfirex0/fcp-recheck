import { supabase } from "./supabase";
import { tavilySearch, formatResultsForPrompt } from "./tavily";
import {
  estimateCa,
  estimateExport,
  extractCaFromText,
  extractExportFromText,
  extractFromGroundedAnswer,
  groundedSearch
} from "./gemini";
import { getBracket, bracketsMatch } from "./seg";
import type {
  CaExtraction,
  Company,
  ExportExtraction,
  FinalStatus,
  ModelUsed,
  RecheckResult,
  SourceLayer,
  Verdict
} from "./types";

function buildCaQuery(c: Company): string {
  const parts = [c.raison_sociale, c.ville, "chiffre d'affaires MAD"];
  if (c.annee_ca_actuelle) parts.push(String(c.annee_ca_actuelle));
  return parts.filter(Boolean).join(" ");
}

function buildExportQuery(c: Company): string {
  return [c.raison_sociale, "chiffre d'affaires export pourcentage"].filter(Boolean).join(" ");
}

function computeCaVerdict(
  status: FinalStatus,
  bracketCurrent: string | null,
  bracketSuggested: string | null
): Verdict {
  if (status === "not_found") return "Donnée insuffisante";
  if (status === "estimated") return "Estimé";
  if (bracketSuggested && bracketsMatch(bracketCurrent, bracketSuggested)) return "Confirmé";
  return "À corriger";
}

function computeExportVerdict(status: FinalStatus): Verdict {
  if (status === "not_found") return "Donnée insuffisante";
  if (status === "estimated") return "Estimé";
  return "Confirmé";
}

interface CaOutcome {
  value_mad: number | null;
  year: number | null;
  status: FinalStatus;
  confidence: number;
  sources: string[];
  reasoning: string;
  layer: SourceLayer;
  model: ModelUsed;
}

interface ExportOutcome {
  value_mad: number | null;
  value_derived: boolean;
  pct: number | null;
  year: number | null;
  status: FinalStatus;
  confidence: number;
  sources: string[];
  reasoning: string;
  layer: SourceLayer;
  model: ModelUsed;
}

/**
 * Runs the full 4-layer resolution for the CA field:
 *   1. Whatever came out of the grounded-search extraction (already done by caller)
 *   2. Tavily fallback search + re-extraction, if step 1 was not_found
 *   3. Pro reasoned estimation, if step 2 also came up empty
 */
async function resolveCa(
  company: Company,
  fromGrounding: CaExtraction,
  groundingModel: "flash" | "pro"
): Promise<CaOutcome> {
  if (fromGrounding.status !== "not_found") {
    return {
      value_mad: fromGrounding.value_mad,
      year: fromGrounding.year,
      status: "confirmed",
      confidence: fromGrounding.confidence,
      sources: fromGrounding.sources,
      reasoning: fromGrounding.reasoning,
      layer: "grounding",
      model: groundingModel
    };
  }

  // Layer 2: Tavily fallback.
  try {
    const results = await tavilySearch(buildCaQuery(company));
    const context = formatResultsForPrompt("Chiffre d'Affaires (Tavily, recherche de secours)", results);
    const tavilyExtraction = await extractCaFromText(company, context);
    if (tavilyExtraction.status !== "not_found") {
      return {
        value_mad: tavilyExtraction.value_mad,
        year: tavilyExtraction.year,
        status: "confirmed",
        confidence: tavilyExtraction.confidence,
        sources: tavilyExtraction.sources,
        reasoning: tavilyExtraction.reasoning,
        layer: "tavily",
        model: "flash"
      };
    }
  } catch {
    // Tavily fallback failing (e.g. all keys exhausted) shouldn't crash the
    // whole company — just fall through to estimation.
  }

  // Layer 4: reasoned estimation.
  const estimate = await estimateCa(company);
  return {
    value_mad: estimate.value_mad,
    year: null,
    status: estimate.value_mad !== null ? "estimated" : "not_found",
    confidence: estimate.confidence,
    sources: [],
    reasoning: estimate.reasoning,
    layer: estimate.value_mad !== null ? "estimated" : null,
    model: "pro"
  };
}

async function resolveExport(
  company: Company,
  fromGrounding: ExportExtraction,
  groundingModel: "flash" | "pro",
  resolvedCaValueMad: number | null
): Promise<ExportOutcome> {
  if (fromGrounding.status !== "not_found") {
    return {
      value_mad: fromGrounding.value_mad,
      value_derived: false,
      pct: fromGrounding.pct,
      year: fromGrounding.year,
      status: "confirmed",
      confidence: fromGrounding.confidence,
      sources: fromGrounding.sources,
      reasoning: fromGrounding.reasoning,
      layer: "grounding",
      model: groundingModel
    };
  }

  // Layer 2: Tavily fallback.
  try {
    const results = await tavilySearch(buildExportQuery(company));
    const context = formatResultsForPrompt("Part Export (Tavily, recherche de secours)", results);
    const tavilyExtraction = await extractExportFromText(company, context);
    if (tavilyExtraction.status !== "not_found") {
      return {
        value_mad: tavilyExtraction.value_mad,
        value_derived: false,
        pct: tavilyExtraction.pct,
        year: tavilyExtraction.year,
        status: "confirmed",
        confidence: tavilyExtraction.confidence,
        sources: tavilyExtraction.sources,
        reasoning: tavilyExtraction.reasoning,
        layer: "tavily",
        model: "flash"
      };
    }
  } catch {
    // fall through to estimation
  }

  // Layer 4: reasoned estimation.
  const estimate = await estimateExport(company);
  const hasEstimate = estimate.value_mad !== null || estimate.pct !== null;

  // If the estimate only gave a %, derive the raw amount from the resolved CA
  // (confirmed or itself estimated) rather than leaving it blank — clearly
  // marked as derived, not sourced.
  let valueMad = estimate.value_mad;
  let derived = false;
  if (valueMad === null && estimate.pct !== null && resolvedCaValueMad !== null) {
    valueMad = Math.round((resolvedCaValueMad * estimate.pct) / 100);
    derived = true;
  }

  return {
    value_mad: valueMad,
    value_derived: derived,
    pct: estimate.pct,
    year: null,
    status: hasEstimate ? "estimated" : "not_found",
    confidence: estimate.confidence,
    sources: [],
    reasoning: estimate.reasoning,
    layer: hasEstimate ? "estimated" : null,
    model: "pro"
  };
}

/**
 * Processes exactly one company end-to-end through the full 4-layer pipeline.
 * Does NOT write to Supabase — callers persist the result.
 */
export async function processCompany(company: Company): Promise<RecheckResult> {
  const grounded = await groundedSearch(company);
  const { result, caModelUsed, exportModelUsed } = await extractFromGroundedAnswer(company, grounded);

  const caOutcome = await resolveCa(company, result.ca, caModelUsed);
  const exportOutcome = await resolveExport(company, result.export, exportModelUsed, caOutcome.value_mad);

  const bracketSuggested = getBracket(caOutcome.value_mad);
  const caVerdict = computeCaVerdict(caOutcome.status, company.tranche_ca_actuelle, bracketSuggested);
  const exportVerdict = computeExportVerdict(exportOutcome.status);

  return {
    code_firme: company.code_firme,

    ca_value_mad: caOutcome.value_mad,
    ca_year: caOutcome.year,
    ca_status: caOutcome.status,
    ca_confidence: caOutcome.confidence,
    ca_sources: caOutcome.sources,
    ca_reasoning: caOutcome.reasoning,
    ca_layer: caOutcome.layer,
    ca_bracket_current: company.tranche_ca_actuelle,
    ca_bracket_suggested: bracketSuggested,
    ca_verdict: caVerdict,
    ca_model_used: caOutcome.model,

    export_value_mad: exportOutcome.value_mad,
    export_value_derived: exportOutcome.value_derived,
    export_pct: exportOutcome.pct,
    export_year: exportOutcome.year,
    export_status: exportOutcome.status,
    export_confidence: exportOutcome.confidence,
    export_sources: exportOutcome.sources,
    export_reasoning: exportOutcome.reasoning,
    export_layer: exportOutcome.layer,
    export_verdict: exportVerdict,
    export_model_used: exportOutcome.model,

    processed_at: new Date().toISOString()
  };
}

/**
 * Fetches up to `limit` companies that don't yet have a recheck_results row,
 * processes them with limited concurrency, and upserts each result as soon as
 * it's ready so a crash mid-batch doesn't lose completed work.
 */
export async function processBatch(limit: number) {
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

  // Small concurrency — gentle enough to avoid tripping Gemini/Tavily rate limits.
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
