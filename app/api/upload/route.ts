import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

// Canonical column names we look for. Matching is whitespace/case-insensitive
// (the real FCP file has a trailing space after "Raison Sociale", for example),
// so we normalize both the file's headers and these expected names before comparing.
const EXPECTED_COLUMNS = {
  codeFirme: "code firme",
  raisonSociale: "raison sociale",
  rsAbrg: "rs-abrg",
  adresse: "adresse",
  ville: "ville",
  region: "region",
  trancheCa: "tranche ca millions dh",
  anneeCa: "annee ca"
};

function normalizeHeader(h: unknown): string {
  return String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // strip accents so "Année" === "Annee"
}

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

    // Read as raw rows (array of arrays) rather than sheet_to_json's
    // object-keyed-by-header mode, so we control header matching ourselves
    // instead of depending on exact string equality with the file's headers.
    const raw: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

    if (raw.length === 0) {
      return NextResponse.json({ error: "Le fichier est vide ou illisible." }, { status: 400 });
    }

    const headerRow = raw[0];
    const normalizedHeaders = headerRow.map(normalizeHeader);

    const colIndex: Partial<Record<keyof typeof EXPECTED_COLUMNS, number>> = {};
    for (const [key, expected] of Object.entries(EXPECTED_COLUMNS) as [
      keyof typeof EXPECTED_COLUMNS,
      string
    ][]) {
      const idx = normalizedHeaders.findIndex((h) => h === expected);
      if (idx !== -1) colIndex[key] = idx;
    }

    if (colIndex.codeFirme === undefined || colIndex.raisonSociale === undefined) {
      return NextResponse.json(
        {
          error:
            "Colonnes attendues introuvables. Vérifie que le fichier a bien les colonnes 'Code Firme' et 'Raison Sociale' (l'espace ou la casse n'a pas d'importance)."
        },
        { status: 400 }
      );
    }

    const dataRows = raw.slice(1);
    const get = (row: any[], key: keyof typeof EXPECTED_COLUMNS): any => {
      const idx = colIndex[key];
      return idx === undefined ? null : row[idx];
    };

    const companies = dataRows
      .filter((row) => get(row, "codeFirme"))
      .map((row) => ({
        code_firme: String(get(row, "codeFirme")).trim(),
        raison_sociale: String(get(row, "raisonSociale") ?? "").trim(),
        rs_abrg: get(row, "rsAbrg") ? String(get(row, "rsAbrg")).trim() : null,
        adresse: get(row, "adresse") ? String(get(row, "adresse")).trim() : null,
        ville: get(row, "ville") ? String(get(row, "ville")).trim() : null,
        region: get(row, "region") ? String(get(row, "region")).trim() : null,
        tranche_ca_actuelle: get(row, "trancheCa") ? String(get(row, "trancheCa")).trim() : null,
        annee_ca_actuelle: get(row, "anneeCa") ? Number(get(row, "anneeCa")) : null
      }));

    if (companies.length === 0) {
      return NextResponse.json(
        { error: "Aucune ligne avec un 'Code Firme' valide n'a été trouvée sous l'en-tête." },
        { status: 400 }
      );
    }

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

