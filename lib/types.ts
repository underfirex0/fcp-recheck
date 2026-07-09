/** Raw status from a single extraction pass (before fallback/estimation logic runs). */
export type RawStatus = "confirmed" | "conflicting" | "not_found";

/** Final, stored status after the full 4-layer pipeline has run for a field group. */
export type FinalStatus = "confirmed" | "estimated" | "not_found";

/** Which layer actually produced the final value for a field group. */
export type SourceLayer = "grounding" | "tavily" | "estimated" | null;

export type Verdict = "Confirmé" | "À corriger" | "Estimé" | "Donnée insuffisante";
export type ModelUsed = "flash" | "pro" | null;

export interface Company {
  code_firme: string;
  raison_sociale: string;
  rs_abrg: string | null;
  adresse: string | null;
  ville: string | null;
  region: string | null;
  tranche_ca_actuelle: string | null;
  annee_ca_actuelle: number | null;
}

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

export interface GroundedAnswer {
  text: string;
  sources: string[]; // resolved best-effort from grounding citations
}

/** One field group's raw extraction result, before fallback/estimation is applied. */
export interface CaExtraction {
  value_mad: number | null;
  year: number | null;
  status: RawStatus;
  confidence: number; // 0-100
  sources: string[];
  reasoning: string;
}

export interface ExportExtraction {
  value_mad: number | null; // "CA Export" raw amount, in MAD
  pct: number | null; // "% CA Export"
  year: number | null;
  status: RawStatus;
  confidence: number; // 0-100
  sources: string[];
  reasoning: string;
}

/** The exact JSON shape we force Gemini to return when extracting from grounded/Tavily text. */
export interface GeminiExtraction {
  ca: CaExtraction;
  export: ExportExtraction;
}

/** Output of the estimation layer (Layer 4) — used only when real search truly found nothing. */
export interface EstimationResult {
  value_mad: number | null;
  pct: number | null; // only used for the export estimation call
  confidence: number; // deliberately capped low (see lib/gemini.ts)
  reasoning: string;
}

export interface RecheckResult {
  code_firme: string;

  // --- Chiffre d'affaires ---
  ca_value_mad: number | null;
  ca_year: number | null;
  ca_status: FinalStatus;
  ca_confidence: number;
  ca_sources: string[];
  ca_reasoning: string;
  ca_layer: SourceLayer;
  ca_bracket_current: string | null;
  ca_bracket_suggested: string | null;
  ca_verdict: Verdict;
  ca_model_used: ModelUsed;

  // --- CA Export (raw amount) + % CA Export ---
  export_value_mad: number | null;
  export_value_derived: boolean; // true if computed from ca_value_mad * pct rather than found directly
  export_pct: number | null;
  export_year: number | null;
  export_status: FinalStatus;
  export_confidence: number;
  export_sources: string[];
  export_reasoning: string;
  export_layer: SourceLayer;
  export_verdict: Verdict;
  export_model_used: ModelUsed;

  processed_at: string;
}
