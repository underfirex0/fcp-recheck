import { NextRequest } from "next/server";
import { createLimiter } from "@/lib/pipeline";
import { getRowsNeedingLinkResolution, resolveSourcesArray } from "@/lib/resolveLinks";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_CONCURRENCY = Number(process.env.LINK_RESOLVE_CONCURRENCY) || 10;

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
        const { rows, totalNeeding } = await getRowsNeedingLinkResolution(batchSize);

        if (rows.length === 0) {
          send({ type: "done", processed: 0, remaining: 0 });
          return; // `finally` below closes the controller
        }

        const limit = createLimiter(DEFAULT_CONCURRENCY);
        let processed = 0;

        const tasks = rows.map((row) =>
          limit(async () => {
            const [newCa, newExport] = await Promise.all([
              resolveSourcesArray(row.ca_sources),
              resolveSourcesArray(row.export_sources)
            ]);
            const { error } = await supabase
              .from("recheck_results")
              .update({ ca_sources: newCa, export_sources: newExport })
              .eq("code_firme", row.code_firme);
            if (error) throw new Error(error.message);
            processed++;
            send({ type: "company", code_firme: row.code_firme });
          }).catch((err: any) => {
            send({ type: "error", code_firme: row.code_firme, error: String(err?.message ?? err) });
          })
        );

        await Promise.all(tasks);

        const remaining = Math.max(0, totalNeeding - rows.length);
        send({ type: "done", processed, remaining });
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
