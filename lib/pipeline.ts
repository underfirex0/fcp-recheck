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
 * A field extraction is only usable as a final answer if it actually contains
 * a number — a range-based source (e.g. "entre 100M et 500M MAD") sometimes
 * makes Gemini report status "confirmed" or "conflicting" with real confidence
 * but a null value, since it genuinely can't collapse a range into one exact
 * figure. That must NOT be treated as resolved: it needs to fall through to
 * Tavily/estimation like a real not_found, or it silently dead-ends with a
 * verdict of "needs correction" but no actual suggested number to correct to.
 */
function isUsableCa(e: CaExtraction): boolean {
  return e.status !== "not_found" && e.value_mad !== null;
}
function isUsableExport(e: ExportExtraction): boolean {
  return e.status !== "not_found" && (e.value_mad !== null || e.pct !== null);
}

/**
 * Resolves the CA field through layers 2 (Tavily fallback) and 4 (estimation),
 * given whatever layer 1 (grounding) + extraction already produced.
 */
async function resolveCa(
  company: Company,
  fromGrounding: CaExtraction,
  groundingModel: "flash" | "pro"
): Promise<CaOutcome> {
  if (isUsableCa(fromGrounding)) {
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

  try {
    const results = await tavilySearch(buildCaQuery(company));
    const context = formatResultsForPrompt("Chiffre d'Affaires (Tavily, recherche de secours)", results);
    const tavilyExtraction = await extractCaFromText(company, context);
    if (isUsableCa(tavilyExtraction)) {
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
    // Tavily fallback failing shouldn't crash the whole company — fall through.
  }

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

/**
 * Resolves the Export field group the same way. Deliberately does NOT depend
 * on the CA outcome — that dependency (deriving a raw export amount from
 * CA × %) is applied centrally in processCompany AFTER both fields resolve,
 * so CA and Export can run fully in parallel instead of one waiting on the
 * other.
 */
async function resolveExport(
  company: Company,
  fromGrounding: ExportExtraction,
  groundingModel: "flash" | "pro"
): Promise<ExportOutcome> {
  if (isUsableExport(fromGrounding)) {
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

  try {
    const results = await tavilySearch(buildExportQuery(company));
    const context = formatResultsForPrompt("Part Export (Tavily, recherche de secours)", results);
    const tavilyExtraction = await extractExportFromText(company, context);
    if (isUsableExport(tavilyExtraction)) {
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

  const estimate = await estimateExport(company);
  const hasEstimate = estimate.value_mad !== null || estimate.pct !== null;
  return {
    value_mad: estimate.value_mad,
    value_derived: false, // derivation, if any, is applied centrally afterwards
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
 * CA and Export are resolved IN PARALLEL — they only share the initial
 * grounded search + extraction call, after which their fallback/estimation
 * chains are fully independent. This roughly halves per-company latency
 * versus resolving them one after another.
 * Does NOT write to Supabase — callers persist the result.
 */
export async function processCompany(company: Company): Promise<RecheckResult> {
  const grounded = await groundedSearch(company);
  const { result, caModelUsed, exportModelUsed } = await extractFromGroundedAnswer(company, grounded);

  const [caOutcome, exportOutcomeRaw] = await Promise.all([
    resolveCa(company, result.ca, caModelUsed),
    resolveExport(company, result.export, exportModelUsed)
  ]);

  // Central derivation: if we have a % but no raw export amount, and we do
  // have a resolved CA value (from any layer), compute the amount in code —
  // applies regardless of which layer produced the % (grounding, Tavily, or
  // estimation), improving field completion without any extra API calls.
  let exportOutcome = exportOutcomeRaw;
  if (
    exportOutcome.value_mad === null &&
    exportOutcome.pct !== null &&
    caOutcome.value_mad !== null
  ) {
    exportOutcome = {
      ...exportOutcome,
      value_mad: Math.round((caOutcome.value_mad * exportOutcome.pct) / 100),
      value_derived: true
    };
  }

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
 * Simple concurrency-limiting semaphore. Unlike chunked Promise.all (the old
 * design), each task reports as soon as IT individually finishes, regardless
 * of the others in flight — this is what makes true live, per-company
 * streaming possible instead of "wait for the whole wave."
 */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

/** Companies that don't yet have a recheck_results row, capped at `limit`. */
export async function getPendingCompanies(
  limit: number
): Promise<{ companies: Company[]; totalPending: number }> {
  const [{ data: allCompanies, error: companiesError }, { data: doneRows, error: doneError }] =
    await Promise.all([
      supabase.from("companies").select("*"),
      supabase.from("recheck_results").select("code_firme")
    ]);

  if (companiesError) throw new Error(`Failed to fetch companies: ${companiesError.message}`);
  if (doneError) throw new Error(`Failed to fetch recheck_results: ${doneError.message}`);

  const doneSet = new Set((doneRows ?? []).map((r) => r.code_firme));
  const pending = (allCompanies ?? []).filter((c) => !doneSet.has(c.code_firme)) as Company[];

  return { companies: pending.slice(0, limit), totalPending: pending.length };
}
