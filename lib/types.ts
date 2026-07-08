export type FieldStatus = "confirmed" | "conflicting" | "not_found";
export type Verdict = "Confirmé" | "À corriger" | "Donnée insuffisante";
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

/** The exact JSON shape we force Gemini to return for one company. */
export interface GeminiExtraction {
  ca: {
    value_mad: number | null;
    year: number | null;
    status: FieldStatus;
    confidence: number; // 0-100
    sources: string[];
    reasoning: string;
  };
  export: {
    pct: number | null;
    year: number | null;
    status: FieldStatus;
    confidence: number; // 0-100
    sources: string[];
    reasoning: string;
  };
}

export interface RecheckResult {
  code_firme: string;

  ca_value_mad: number | null;
  ca_year: number | null;
  ca_status: FieldStatus;
  ca_confidence: number;
  ca_sources: string[];
  ca_reasoning: string;
  ca_bracket_current: string | null;
  ca_bracket_suggested: string | null;
  ca_verdict: Verdict;
  ca_model_used: ModelUsed;

  export_pct: number | null;
  export_year: number | null;
  export_status: FieldStatus;
  export_confidence: number;
  export_sources: string[];
  export_reasoning: string;
  export_model_used: ModelUsed;

  processed_at: string;
}
