import { GoogleGenAI } from "@google/genai";
import type { Company, GeminiExtraction } from "./types";

// Supports either Vertex AI (GCP project/credits) or the plain Gemini Developer
// API (AI Studio key). Toggle with GOOGLE_GENAI_USE_VERTEXAI=true/false.
//
// For Vertex AI on a serverless platform like Vercel, there's no persistent
// filesystem to point GOOGLE_APPLICATION_CREDENTIALS at, so instead we accept
// the *entire* service account JSON as a single environment variable
// (GOOGLE_APPLICATION_CREDENTIALS_JSON) and pass the parsed credentials
// directly to the underlying auth client — no file needed.
function getClient(): GoogleGenAI {
  const useVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI === "true";

  if (useVertex) {
    const rawCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!rawCreds) {
      throw new Error(
        "GOOGLE_GENAI_USE_VERTEXAI=true but GOOGLE_APPLICATION_CREDENTIALS_JSON is missing."
      );
    }

    let credentials: { client_email: string; private_key: string };
    try {
      credentials = JSON.parse(rawCreds);
    } catch {
      throw new Error(
        "GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON. Paste the entire " +
          "service account JSON file content as-is, on a single line."
      );
    }

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
// "confirmed" but with low confidence. "not_found" is NOT escalated — if Flash
// genuinely found nothing, Pro re-searching the same text won't invent a source.
const ESCALATION_CONFIDENCE_THRESHOLD = 60;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    ca: {
      type: "object",
      properties: {
        value_mad: { type: ["number", "null"] },
        year: { type: ["integer", "null"] },
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
        pct: { type: ["number", "null"] },
        year: { type: ["integer", "null"] },
        status: { type: "string", enum: ["confirmed", "conflicting", "not_found"] },
        confidence: { type: "integer" },
        sources: { type: "array", items: { type: "string" } },
        reasoning: { type: "string" }
      },
      required: ["pct", "year", "status", "confidence", "sources", "reasoning"]
    }
  },
  required: ["ca", "export"]
} as const;

function buildPrompt(
  company: Company,
  caContext: string,
  exportContext: string
): string {
  return `Tu es un analyste financier qui vérifie des données d'entreprises marocaines pour la Fédération des Industries Chimiques et Para-chimiques (FCP).

Entreprise : ${company.raison_sociale}${company.rs_abrg ? ` (${company.rs_abrg})` : ""}
Ville : ${company.ville ?? "inconnue"}
Région : ${company.region ?? "inconnue"}
Valeur actuellement enregistrée pour la tranche de chiffre d'affaires : "${company.tranche_ca_actuelle ?? "inconnue"}" (année ${company.annee_ca_actuelle ?? "inconnue"})

Voici des extraits de recherche web (peuvent être vides, partiels, ou contradictoires) :

--- Recherche Chiffre d'Affaires ---
${caContext}

--- Recherche Part Export ---
${exportContext}

Tâche : à partir UNIQUEMENT des extraits ci-dessus (ne complète jamais avec des connaissances générales non vérifiées), détermine :

1. "ca" : le chiffre d'affaires réel de l'entreprise en MAD (dirhams marocains, valeur brute, PAS en millions), l'année où ce chiffre est déclaré, et les sources.
   - Si des sources donnent des montants différents ou incohérents entre elles → status = "conflicting".
   - Si aucune source ne mentionne de chiffre d'affaires exploitable → status = "not_found", value_mad = null, confidence = 0. NE DEVINE JAMAIS un chiffre.
   - Si une source claire et cohérente donne un chiffre → status = "confirmed".
   - confidence : 0 à 100, ton estimation honnête de la fiabilité de cette donnée.

2. "export" : le pourcentage du chiffre d'affaires réalisé à l'export, l'année, les sources.
   - Mêmes règles de status/confidence que ci-dessus.

Réponds uniquement avec le JSON demandé, rien d'autre.`;
}

async function callGemini(
  model: string,
  prompt: string
): Promise<GeminiExtraction> {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA as any,
      temperature: 0.1
    }
  });

  const text = response.text;
  if (!text) throw new Error(`Empty response from Gemini model ${model}`);

  try {
    return JSON.parse(text) as GeminiExtraction;
  } catch (err) {
    throw new Error(
      `Failed to parse Gemini JSON from model ${model}: ${String(err)}\nRaw: ${text.slice(0, 500)}`
    );
  }
}

function needsEscalation(field: GeminiExtraction["ca"] | GeminiExtraction["export"]): boolean {
  if (field.status === "conflicting") return true;
  if (field.status === "confirmed" && field.confidence < ESCALATION_CONFIDENCE_THRESHOLD) {
    return true;
  }
  return false;
}

export interface ExtractionOutcome {
  result: GeminiExtraction;
  caModelUsed: "flash" | "pro";
  exportModelUsed: "flash" | "pro";
}

/**
 * Runs the Flash-first / Pro-escalation hybrid for one company.
 * Flash always runs first (cheap). Each field (ca / export) is escalated to
 * Pro *independently* — a company can end up with CA confirmed by Flash but
 * export re-checked by Pro, or vice versa.
 */
export async function extractCompanyData(
  company: Company,
  caContext: string,
  exportContext: string
): Promise<ExtractionOutcome> {
  const prompt = buildPrompt(company, caContext, exportContext);

  const flashResult = await callGemini(FLASH_MODEL, prompt);

  let caModelUsed: "flash" | "pro" = "flash";
  let exportModelUsed: "flash" | "pro" = "flash";
  let finalResult = flashResult;

  const caNeedsEscalation = needsEscalation(flashResult.ca);
  const exportNeedsEscalation = needsEscalation(flashResult.export);

  if (caNeedsEscalation || exportNeedsEscalation) {
    // Re-run the whole extraction on Pro (simpler and more robust than trying
    // to splice partial JSON responses together), but we only ADOPT the
    // specific field(s) that actually needed escalation — if Flash was already
    // confident about one field, we keep Flash's answer for it rather than
    // silently overwriting a good result with Pro's independent (and possibly
    // just-different) take.
    const proResult = await callGemini(PRO_MODEL, prompt);

    finalResult = {
      ca: caNeedsEscalation ? proResult.ca : flashResult.ca,
      export: exportNeedsEscalation ? proResult.export : flashResult.export
    };
    if (caNeedsEscalation) caModelUsed = "pro";
    if (exportNeedsEscalation) exportModelUsed = "pro";
  }

  return { result: finalResult, caModelUsed, exportModelUsed };
}
