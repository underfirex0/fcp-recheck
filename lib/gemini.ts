import { GoogleGenAI } from "@google/genai";
import type {
  CaExtraction,
  Company,
  EstimationResult,
  ExportExtraction,
  GeminiExtraction,
  GroundedAnswer,
  RawStatus
} from "./types";

// Supports either Vertex AI (GCP project/credits) or the plain Gemini Developer
// API (AI Studio key). Toggle with GOOGLE_GENAI_USE_VERTEXAI=true/false.
//
// For Vertex AI on a serverless platform like Vercel, there's no persistent
// filesystem to point GOOGLE_APPLICATION_CREDENTIALS at, so instead we accept
// the *entire* service account JSON as a single environment variable
// (GOOGLE_APPLICATION_CREDENTIALS_JSON) and pass the parsed credentials
// directly to the underlying auth client — no file needed.
function parseServiceAccountJson(raw: string): { client_email: string; private_key: string } {
  let cleaned = raw.trim();

  // Strip accidental markdown code fences (```json ... ``` or ``` ... ```).
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  // Strip a single layer of wrapping quotes, in case the whole blob got pasted
  // as a quoted string (e.g. '"{...}"').
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1);
  }

  // Normalize "smart quotes" back to plain ASCII quotes — a very common
  // corruption when JSON is copy-pasted through a rich-text editor.
  cleaned = cleaned
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");

  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("missing client_email or private_key field");
    }
    return parsed;
  } catch (err) {
    const start = cleaned.slice(0, 40);
    const end = cleaned.slice(-25);
    throw new Error(
      `GOOGLE_APPLICATION_CREDENTIALS_JSON could not be parsed as valid service ` +
        `account JSON (${String(err instanceof Error ? err.message : err)}). ` +
        `It should be the ENTIRE downloaded JSON file content, starting with '{' and ` +
        `ending with '}'. Value received starts with: "${start}..." and ends with: ` +
        `"...${end}".`
    );
  }
}

function getClient(): GoogleGenAI {
  const useVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI === "true";

  if (useVertex) {
    const rawCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!rawCreds) {
      throw new Error(
        "GOOGLE_GENAI_USE_VERTEXAI=true but GOOGLE_APPLICATION_CREDENTIALS_JSON is missing."
      );
    }
    const credentials = parseServiceAccountJson(rawCreds);
    return new GoogleGenAI({
      vertexai: true,
      project: process.env.GCP_PROJECT,
      location: process.env.GCP_LOCATION || "us-central1",
      googleAuthOptions: { credentials }
    });
  }

  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

const FLASH_MODEL = process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash";
const PRO_MODEL = process.env.GEMINI_PRO_MODEL || "gemini-2.5-pro";

// Escalate a field to Pro if Flash itself says it's conflicting, OR if it says
// "confirmed" but with low confidence.
const ESCALATION_CONFIDENCE_THRESHOLD = 60;
// Cap on any Layer-4 estimation's confidence — an estimate should never be
// allowed to look as trustworthy as a real, sourced figure.
const ESTIMATION_CONFIDENCE_CAP = 40;

function companyLabel(c: Company): string {
  return `${c.raison_sociale}${c.rs_abrg ? ` (${c.rs_abrg})` : ""} — ${c.ville ?? "ville inconnue"}, ${c.region ?? "région inconnue"}`;
}

// ---------------------------------------------------------------------------
// Layer 1: Gemini + native Google Search grounding.
// ---------------------------------------------------------------------------

/**
 * Asks both the CA and export questions directly, letting Gemini run its own
 * Google Search queries internally (grounding). Returns the plain-text answer
 * plus a best-effort list of source URLs pulled from the grounding metadata.
 *
 * Grounding and forced JSON schema output can't be combined in the same call,
 * so this deliberately returns free text — a separate extraction call (Layer 3)
 * structures it afterwards.
 */
export async function groundedSearch(company: Company): Promise<GroundedAnswer> {
  const ai = getClient();
  const prompt = `Tu fais une recherche factuelle sur une entreprise marocaine pour un audit de la Fédération des Industries Chimiques et Para-chimiques (FCP).

Entreprise : ${companyLabel(company)}
Valeur actuellement enregistrée pour la tranche de chiffre d'affaires : "${company.tranche_ca_actuelle ?? "inconnue"}" (année ${company.annee_ca_actuelle ?? "inconnue"})

Réponds, avec tes sources, aux questions suivantes :
1. Quel est le chiffre d'affaires (CA) réel de cette entreprise, en dirhams marocains (MAD) ? Pour quelle année ce chiffre est-il déclaré ? Quelle est la source ?
2. Quel est le chiffre d'affaires réalisé à l'export par cette entreprise (montant en MAD), et/ou quel pourcentage de son CA total est réalisé à l'export ? Pour quelle année ? Quelle est la source ?

Sois précis sur les montants et les années. Si tu ne trouves pas une information, dis-le clairement plutôt que de deviner.`;

  const response = await ai.models.generateContent({
    model: FLASH_MODEL,
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
      temperature: 0.1
    }
  });

  const text = response.text ?? "";

  // Grounding metadata shape can vary slightly between SDK versions — pull
  // source URLs defensively and never let a shape mismatch crash the pipeline.
  let sources: string[] = [];
  try {
    const candidate = (response as any).candidates?.[0];
    const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
    sources = chunks
      .map((c: any) => c?.web?.uri || c?.web?.title)
      .filter((s: any): s is string => typeof s === "string" && s.length > 0);
  } catch {
    sources = [];
  }

  return { text, sources };
}

// ---------------------------------------------------------------------------
// Layer 3: structured extraction (Flash first, Pro on escalation).
// ---------------------------------------------------------------------------

const FULL_SCHEMA = {
  type: "object",
  properties: {
    ca: {
      type: "object",
      properties: {
        value_mad: { type: "number", nullable: true },
        year: { type: "integer", nullable: true },
        status: { type: "string", enum: ["confirmed", "conflicting", "not_found"] },
        confidence: { type: "integer" },
        sources: { type: "array", items: { type: "string" } },
        reasoning: { type: "string" }
      },
      required: ["value_mad", "year", "status", "confidence", "sources", "reasoning"]
    },
    export: {
      type: "object",
      properties: {
        value_mad: { type: "number", nullable: true },
        pct: { type: "number", nullable: true },
        year: { type: "integer", nullable: true },
        status: { type: "string", enum: ["confirmed", "conflicting", "not_found"] },
        confidence: { type: "integer" },
        sources: { type: "array", items: { type: "string" } },
        reasoning: { type: "string" }
      },
      required: ["value_mad", "pct", "year", "status", "confidence", "sources", "reasoning"]
    }
  },
  required: ["ca", "export"]
} as const;

async function callGeminiJson(model: string, prompt: string, schema: object): Promise<any> {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: schema as any,
      temperature: 0.1
    }
  });

  const text = response.text;
  if (!text) throw new Error(`Empty response from Gemini model ${model}`);

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse Gemini JSON from model ${model}: ${String(err)}\nRaw: ${text.slice(0, 500)}`
    );
  }
}

function buildExtractionPrompt(company: Company, groundedText: string, sources: string[]): string {
  return `Voici une réponse de recherche (avec ses sources) concernant l'entreprise ${companyLabel(company)} :

--- Réponse de recherche ---
${groundedText}

--- Sources citées ---
${sources.length > 0 ? sources.join("\n") : "(aucune source explicite retournée)"}

Tâche : structure cette réponse en JSON selon le schéma demandé.
- "ca" : chiffre d'affaires en MAD (valeur brute, PAS en millions), année, statut, confiance, sources, raisonnement.
- "export" : chiffre d'affaires export en MAD (si mentionné), pourcentage export (si mentionné), année, statut, confiance, sources, raisonnement.

Règles strictes :
- Si la réponse de recherche ne contient PAS d'information exploitable pour un champ → status = "not_found", les valeurs numériques = null, confidence = 0. NE DEVINE JAMAIS.
- Si tu trouves uniquement une FOURCHETTE (ex: "entre 100M et 500M MAD", "supérieur à 1 milliard") plutôt qu'un chiffre exact → calcule et utilise le POINT MÉDIAN de la fourchette comme value_mad (pour "supérieur à X", utilise X × 1.5 comme estimation raisonnable), garde status = "confirmed", et baisse ta confidence pour refléter cette imprécision (max ~50). NE LAISSE JAMAIS value_mad à null si status n'est pas "not_found" — c'est une incohérence qui bloque tout le traitement en aval.
- Si la réponse mentionne des chiffres incohérents entre eux → status = "conflicting".
- Sinon → status = "confirmed", avec une confidence honnête (0-100) reflétant la fiabilité de la réponse de recherche.
- N'invente jamais une source qui n'apparaît pas dans le texte ci-dessus.`;
}

export async function extractFromGroundedAnswer(
  company: Company,
  grounded: GroundedAnswer
): Promise<{ result: GeminiExtraction; caModelUsed: "flash" | "pro"; exportModelUsed: "flash" | "pro" }> {
  const prompt = buildExtractionPrompt(company, grounded.text, grounded.sources);

  const flashResult = (await callGeminiJson(FLASH_MODEL, prompt, FULL_SCHEMA)) as GeminiExtraction;

  let caModelUsed: "flash" | "pro" = "flash";
  let exportModelUsed: "flash" | "pro" = "flash";
  let finalResult = flashResult;

  const needsEscalation = (status: RawStatus, confidence: number) =>
    status === "conflicting" || (status === "confirmed" && confidence < ESCALATION_CONFIDENCE_THRESHOLD);

  const caEscalate = needsEscalation(flashResult.ca.status, flashResult.ca.confidence);
  const exportEscalate = needsEscalation(flashResult.export.status, flashResult.export.confidence);

  if (caEscalate || exportEscalate) {
    const proResult = (await callGeminiJson(PRO_MODEL, prompt, FULL_SCHEMA)) as GeminiExtraction;
    finalResult = {
      ca: caEscalate ? proResult.ca : flashResult.ca,
      export: exportEscalate ? proResult.export : flashResult.export
    };
    if (caEscalate) caModelUsed = "pro";
    if (exportEscalate) exportModelUsed = "pro";
  }

  return { result: finalResult, caModelUsed, exportModelUsed };
}

// ---------------------------------------------------------------------------
// Layer 2 support: re-extract a single field group from Tavily fallback text.
// ---------------------------------------------------------------------------

const CA_ONLY_SCHEMA = {
  type: "object",
  properties: {
    value_mad: { type: "number", nullable: true },
    year: { type: "integer", nullable: true },
    status: { type: "string", enum: ["confirmed", "conflicting", "not_found"] },
    confidence: { type: "integer" },
    sources: { type: "array", items: { type: "string" } },
    reasoning: { type: "string" }
  },
  required: ["value_mad", "year", "status", "confidence", "sources", "reasoning"]
} as const;

const EXPORT_ONLY_SCHEMA = {
  type: "object",
  properties: {
    value_mad: { type: "number", nullable: true },
    pct: { type: "number", nullable: true },
    year: { type: "integer", nullable: true },
    status: { type: "string", enum: ["confirmed", "conflicting", "not_found"] },
    confidence: { type: "integer" },
    sources: { type: "array", items: { type: "string" } },
    reasoning: { type: "string" }
  },
  required: ["value_mad", "pct", "year", "status", "confidence", "sources", "reasoning"]
} as const;

export async function extractCaFromText(company: Company, contextText: string): Promise<CaExtraction> {
  const prompt = `Extrais le chiffre d'affaires de ${companyLabel(company)} à partir de ce texte de recherche :\n\n${contextText}\n\nSi le texte ne contient pas de chiffre exploitable, status = "not_found", value_mad = null, confidence = 0. Si tu trouves seulement une fourchette, utilise le point médian comme value_mad, status = "confirmed", confidence réduite (max ~50). Ne laisse jamais value_mad à null si status n'est pas "not_found". Ne devine jamais un chiffre à partir de rien.`;
  return (await callGeminiJson(FLASH_MODEL, prompt, CA_ONLY_SCHEMA)) as CaExtraction;
}

export async function extractExportFromText(
  company: Company,
  contextText: string
): Promise<ExportExtraction> {
  const prompt = `Extrais le chiffre d'affaires export et/ou le pourcentage export de ${companyLabel(company)} à partir de ce texte de recherche :\n\n${contextText}\n\nSi le texte ne contient pas d'information exploitable, status = "not_found", value_mad et pct = null, confidence = 0. Si tu trouves seulement une fourchette, utilise le point médian, status = "confirmed", confidence réduite (max ~50). Ne laisse jamais les deux valeurs à null si status n'est pas "not_found". Ne devine jamais.`;
  return (await callGeminiJson(FLASH_MODEL, prompt, EXPORT_ONLY_SCHEMA)) as ExportExtraction;
}

// ---------------------------------------------------------------------------
// Layer 4: reasoned estimation — only used when Layers 1+2 both found nothing.
// ---------------------------------------------------------------------------

const ESTIMATION_SCHEMA = {
  type: "object",
  properties: {
    value_mad: { type: "number", nullable: true },
    pct: { type: "number", nullable: true },
    confidence: { type: "integer" },
    reasoning: { type: "string" }
  },
  required: ["value_mad", "pct", "confidence", "reasoning"]
} as const;

/**
 * Produces a clearly-labeled ESTIMATE (never a "found" figure) using only
 * indirect context: the company's existing declared bracket, its city/region,
 * and general sector knowledge inferred from its name/activity. Confidence is
 * hard-capped so an estimate can never outrank a genuinely sourced figure.
 */
export async function estimateCa(company: Company): Promise<EstimationResult> {
  const prompt = `Aucune source web exploitable n'a été trouvée pour le chiffre d'affaires de ${companyLabel(company)}.

Contexte disponible :
- Tranche CA précédemment déclarée : "${company.tranche_ca_actuelle ?? "inconnue"}" (année ${company.annee_ca_actuelle ?? "inconnue"})
- Ville/région : ${company.ville ?? "?"} / ${company.region ?? "?"}
- Nom de l'entreprise (peut indiquer le secteur) : ${company.raison_sociale}

Tâche : propose une ESTIMATION raisonnée du chiffre d'affaires actuel en MAD, en te basant sur la tranche déjà connue (le point de départ le plus fiable), le secteur probable, et toute connaissance générale du marché marocain. Explique clairement, dans "reasoning", sur quoi se base ton estimation — précise que ce n'est PAS une donnée sourcée.
Plafonne ta confiance à un maximum de ${ESTIMATION_CONFIDENCE_CAP} (une estimation ne doit jamais paraître aussi fiable qu'une donnée trouvée).`;

  const raw = (await callGeminiJson(PRO_MODEL, prompt, ESTIMATION_SCHEMA)) as EstimationResult;
  return { ...raw, confidence: Math.min(raw.confidence, ESTIMATION_CONFIDENCE_CAP) };
}

export async function estimateExport(company: Company): Promise<EstimationResult> {
  const prompt = `Aucune source web exploitable n'a été trouvée pour la part export de ${companyLabel(company)}.

Contexte disponible :
- Ville/région : ${company.ville ?? "?"} / ${company.region ?? "?"}
- Nom de l'entreprise (peut indiquer le secteur) : ${company.raison_sociale}
- Tranche CA connue : "${company.tranche_ca_actuelle ?? "inconnue"}"

Tâche : propose une ESTIMATION raisonnée du pourcentage de CA réalisé à l'export (et, si possible, le montant en MAD), en te basant sur le secteur probable de cette entreprise (les industries chimiques/para-chimiques marocaines exportent très inégalement selon le sous-secteur) et toute connaissance générale disponible. Explique clairement dans "reasoning" sur quoi se base ton estimation — précise que ce n'est PAS une donnée sourcée.
Plafonne ta confiance à un maximum de ${ESTIMATION_CONFIDENCE_CAP}.`;

  const raw = (await callGeminiJson(PRO_MODEL, prompt, ESTIMATION_SCHEMA)) as EstimationResult;
  return { ...raw, confidence: Math.min(raw.confidence, ESTIMATION_CONFIDENCE_CAP) };
}
