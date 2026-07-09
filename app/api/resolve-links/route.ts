import { NextRequest } from "next/server";
import { createLimiter } from "@/lib/pipeline";
import { getRowsNeedingLinkResolution, needsResolution, resolveSourcesArray } from "@/lib/resolveLinks";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_CONCURRENCY = Number(process.env.LINK_RESOLVE_CONCURRENCY) || 8;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const batchSize = Math.min(Math.max(Number(body?.batchSize) || 60, 1), 200);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      try {
        const { rows, totalNeeding, totalExhausted } = await getRowsNeedingLinkResolution(batchSize);

        if (rows.length === 0) {
          send({ type: "done", processed: 0, remaining: 0, exhausted: totalExhausted });
          return; // `finally` below closes the controller
        }

        const limit = createLimiter(DEFAULT_CONCURRENCY);
        let processed = 0;

        const tasks = rows.map((row) =>
          limit(async () => {
            const [ca, exp] = await Promise.all([
              resolveSourcesArray(row.ca_sources),
              resolveSourcesArray(row.export_sources)
            ]);

            const stillNeedsResolution = needsResolution(ca.sources) || needsResolution(exp.sources);
            const attempts = (row.link_resolve_attempts ?? 0) + (stillNeedsResolution ? 1 : 0);

            const { error } = await supabase
              .from("recheck_results")
              .update({ ca_sources: ca.sources, export_sources: exp.sources, link_resolve_attempts: attempts })
              .eq("code_firme", row.code_firme);
            if (error) throw new Error(error.message);

            processed++;
            send({
              type: "company",
              code_firme: row.code_firme,
              linksResolved: ca.resolvedCount + exp.resolvedCount,
              stillNeedsResolution
            });
          }).catch((err: any) => {
            send({ type: "error", code_firme: row.code_firme, error: String(err?.message ?? err) });
          })
        );

        await Promise.all(tasks);

        const remaining = Math.max(0, totalNeeding - rows.length);
        send({ type: "done", processed, remaining, exhausted: totalExhausted });
      } catch (err: any) {
        send({ type: "fatal", error: String(err?.message ?? err) });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
}
