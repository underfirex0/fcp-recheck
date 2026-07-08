import { NextRequest, NextResponse } from "next/server";
import { processBatch } from "@/lib/pipeline";

export const runtime = "nodejs";
// Keep batches small enough that this comfortably finishes within typical
// serverless function limits. If you're on Vercel Hobby (10s) you MUST keep
// batchSize small (3-5). On Pro/Fluid compute, 10-20 works fine.
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const batchSize = Math.min(Math.max(Number(body?.batchSize) || 10, 1), 25);

    const outcome = await processBatch(batchSize);
    return NextResponse.json(outcome);
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}
