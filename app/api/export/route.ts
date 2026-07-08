import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import type { Company, RecheckResult } from "@/lib/types";

export const runtime = "nodejs";

function joinSources(sources: string[] | null | undefined): string {
  if (!sources || sources.length === 0) return "";
  return sources.join(" | ");
}

export async function GET() {
  const [{ data: companies, error: companiesError }, { data: results, error: resultsError }] =
    await Promise.all([
      supabase.from("companies").select("*"),
      supabase.from("recheck_results").select("*")
    ]);

  if (companiesError) {
    return NextResponse.json({ error: companiesError.message }, { status: 500 });
  }
  if (resultsError) {
    return NextResponse.json({ error: resultsError.message }, { status: 500 });
  }

  const resultsByCode = new Map<string, RecheckResult>(
    (results ?? []).map((r) => [r.code_firme, r as RecheckResult])
  );

  const rows = (companies as Company[]).map((c) => {
    const r = resultsByCode.get(c.code_firme);
    return {
      "Code Firme": c.code_firme,
      "Raison Sociale": c.raison_sociale,
      "RS-Abrg": c.rs_abrg ?? "",
      ADRESSE: c.adresse ?? "",
      VILLE: c.ville ?? "",
      REGION: c.region ?? "",

      // Original value, untouched.
      "Tranche CA millions DH (actuelle)": c.tranche_ca_actuelle ?? "",
      "ANNEE CA (actuelle)": c.annee_ca_actuelle ?? "",

      // Recheck output — before/after, never overwriting the original.
      "Tranche CA suggérée": r?.ca_bracket_suggested ?? "",
      "Statut CA": r?.ca_verdict ?? "Non traité",
      "CA valeur brute (MAD)": r?.ca_value_mad ?? "",
      "Année CA (source)": r?.ca_year ?? "",
      "SOURCE CA": joinSources(r?.ca_sources),
      "Confiance CA (%)": r?.ca_confidence ?? "",
      "Modèle utilisé (CA)": r?.ca_model_used ?? "",
      "Raisonnement CA": r?.ca_reasoning ?? "",

      "% CA EXPORT": r?.export_pct ?? "",
      "ANNEE CA EXPORT": r?.export_year ?? "",
      "SOURCE CA Export": joinSources(r?.export_sources),
      "Confiance Export (%)": r?.export_confidence ?? "",
      "Modèle utilisé (Export)": r?.export_model_used ?? "",
      "Raisonnement Export": r?.export_reasoning ?? "",
      "Statut Export": r ? (r.export_status === "not_found" ? "Donnée insuffisante" : "Trouvé") : "Non traité"
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "FCP Recheck CA & Export");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="FCP_CA_Export_Recheck_${new Date().toISOString().slice(0, 10)}.xlsx"`
    }
  });
}
