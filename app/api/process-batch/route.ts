import { NextRequest, NextResponse } from "next/server";
import { processBatch } from "@/lib/pipeline";

export const runtime = "nodejs";
// Each company can now involve several sequential network calls (grounding
// search, extraction, possible Pro escalation, possible Tavily fallback,
// possible Pro estimation) — worst case ~40-50s per company. 300s is Vercel's
// Fluid Compute ceiling (available on Hobby too, but must be within your
// plan's actual function duration limit — check Vercel project settings if
// this still times out).
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    // Capped lower than before (was up to 25) — the 4-layer pipeline is much
    // slower per company than the old single-Tavily-call design, so smaller
    // batches are needed to reliably finish within the function time limit.
    const batchSize = Math.min(Math.max(Number(body?.batchSize) || 4, 1), 8);

    const outcome = await processBatch(batchSize);
    return NextResponse.json(outcome);
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}
