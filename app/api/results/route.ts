import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";

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

  const resultsByCode = new Map((results ?? []).map((r) => [r.code_firme, r]));

  const rows = (companies ?? []).map((c) => ({
    company: c,
    result: resultsByCode.get(c.code_firme) ?? null
  }));

  const total = companies?.length ?? 0;
  const done = results?.length ?? 0;

  return NextResponse.json({ rows, total, done });
}
