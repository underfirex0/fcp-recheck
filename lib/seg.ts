/**
 * Deterministic "Tranche CA millions DH" bucketing logic.
 *
 * This table is a direct, literal transcription of Seg.xlsx (Plafond -> Tranche label).
 * The AI (Gemini) is NEVER responsible for deciding which bracket a company falls into.
 * Its only job is to find the raw CA figure in MAD. This table does the bucketing,
 * so results are deterministic, auditable, and can never "hallucinate" a bracket boundary.
 *
 * `plafond` = upper bound of the bracket, in raw MAD (not millions).
 * Brackets are evaluated in ascending order; the first plafond the value is <= to wins.
 */
export interface SegRow {
  plafond: number;
  label: string;
}

export const SEG_TABLE: SegRow[] = [
  { plafond: 5_000_000, label: "De 1 à 5" },
  { plafond: 10_000_000, label: "De 5 à 10" },
  { plafond: 20_000_000, label: "De 10 à 20" },
  { plafond: 50_000_000, label: "De 20 à 50" },
  { plafond: 100_000_000, label: "De 50 à 100" },
  { plafond: 150_000_000, label: "De 100 à 150" },
  { plafond: 200_000_000, label: "De 150 à 200" },
  { plafond: 250_000_000, label: "De 200 à 250" },
  { plafond: 300_000_000, label: "De 250 à 300" },
  { plafond: 350_000_000, label: "De 300 à 350" },
  { plafond: 400_000_000, label: "De 350 à 400" },
  { plafond: 450_000_000, label: "De 400 à 450" },
  { plafond: 500_000_000, label: "De 450 à 500" },
  { plafond: 550_000_000, label: "De 500 à 550" },
  { plafond: 600_000_000, label: "De 550 à 600" },
  { plafond: 650_000_000, label: "De 600 à 650" },
  { plafond: 700_000_000, label: "De 650 à 700" },
  { plafond: 750_000_000, label: "De 700 à 750" },
  { plafond: 800_000_000, label: "De 750 à 800" },
  { plafond: 850_000_000, label: "De 800 à 850" },
  { plafond: 900_000_000, label: "De 850 à 900" },
  { plafond: 950_000_000, label: "De 900 à 950" },
  { plafond: 1_000_000_000, label: "De 950 à 1000" },
  { plafond: 99_999_999_999, label: "Supérieur à 1000" }
];

/**
 * Given a raw CA value in MAD, return the matching "Tranche CA millions DH" label.
 * Returns null if the value is null/undefined/not a finite positive number.
 */
export function getBracket(valueMad: number | null | undefined): string | null {
  if (valueMad === null || valueMad === undefined) return null;
  if (!Number.isFinite(valueMad) || valueMad <= 0) return null;

  for (const row of SEG_TABLE) {
    if (valueMad <= row.plafond) return row.label;
  }
  // Should never happen since the last plafond is effectively infinite, but just in case:
  return SEG_TABLE[SEG_TABLE.length - 1].label;
}

/**
 * Normalizes a bracket label for comparison purposes (trims stray whitespace,
 * since the source file has at least one label with a trailing space:
 * "Supérieur à 1000 ").
 */
export function normalizeBracket(label: string | null | undefined): string {
  if (!label) return "";
  return label.trim().replace(/\s+/g, " ");
}

export function bracketsMatch(a: string | null, b: string | null): boolean {
  return normalizeBracket(a) === normalizeBracket(b);
}
