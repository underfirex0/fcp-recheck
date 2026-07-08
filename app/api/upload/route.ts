import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

// Expected column order in the FCP xlsx, matching FCP_-_Global_à_compléter.xlsx:
// Code Firme | Raison Sociale | RS-Abrg | ADRESSE | VILLE | REGION |
// Tranche CA millions DH | ANNEE CA | SOURCE CA | % CA EXPORT | ANNEE CA EXPORT | SOURCE CA Export
const COL = {
  codeFirme: "Code Firme",
  raisonSociale: "Raison Sociale",
  rsAbrg: "RS-Abrg",
  adresse: "ADRESSE",
  ville: "VILLE",
  region: "REGION",
  trancheCa: "Tranche CA millions DH",
  anneeCa: "ANNEE CA"
};

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json({ error: "Aucun fichier reçu (champ 'file')." }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, { defval: null });

    if (rows.length === 0) {
      return NextResponse.json({ error: "Le fichier est vide ou illisible." }, { status: 400 });
    }

    const firstRow = rows[0];
    if (!(COL.codeFirme in firstRow) || !(COL.raisonSociale in firstRow)) {
      return NextResponse.json(
        {
          error:
            "Colonnes attendues introuvables. Vérifie que le fichier a bien les colonnes 'Code Firme' et 'Raison Sociale' en première ligne."
        },
        { status: 400 }
      );
    }

    const companies = rows
      .filter((r) => r[COL.codeFirme])
      .map((r) => ({
        code_firme: String(r[COL.codeFirme]).trim(),
        raison_sociale: String(r[COL.raisonSociale] ?? "").trim(),
        rs_abrg: r[COL.rsAbrg] ? String(r[COL.rsAbrg]).trim() : null,
        adresse: r[COL.adresse] ? String(r[COL.adresse]).trim() : null,
        ville: r[COL.ville] ? String(r[COL.ville]).trim() : null,
        region: r[COL.region] ? String(r[COL.region]).trim() : null,
        tranche_ca_actuelle: r[COL.trancheCa] ? String(r[COL.trancheCa]).trim() : null,
        annee_ca_actuelle: r[COL.anneeCa] ? Number(r[COL.anneeCa]) : null
      }));

    // Upsert in chunks to stay well under any request size limits.
    const CHUNK = 200;
    for (let i = 0; i < companies.length; i += CHUNK) {
      const chunk = companies.slice(i, i + CHUNK);
      const { error } = await supabase.from("companies").upsert(chunk, { onConflict: "code_firme" });
      if (error) {
        return NextResponse.json(
          { error: `Échec de l'insertion en base: ${error.message}` },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ inserted: companies.length });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}
