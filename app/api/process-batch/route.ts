import { NextRequest } from "next/server";
import { createLimiter, getPendingCompanies, processCompany } from "@/lib/pipeline";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
// Each company can involve several sequential network calls per field group,
// but CA and Export now run in parallel — still, 300s is Vercel's Fluid
// Compute ceiling, used here as a safety margin rather than an expectation
// that every fetched company will necessarily finish (whatever doesn't finish
// in time simply isn't in this response; resuming picks it up next call).
export const maxDuration = 300;

const DEFAULT_CONCURRENCY = Number(process.env.PIPELINE_CONCURRENCY) || 10;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const batchSize = Math.min(Math.max(Number(body?.batchSize) || 20, 1), 60);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      try {
        const { companies, totalPending } = await getPendingCompanies(batchSize);

        if (companies.length === 0) {
          send({ type: "done", processed: 0, remaining: 0 });
          return; // `finally` below closes the controller — don't close it twice
        }

        const limit = createLimiter(DEFAULT_CONCURRENCY);
        let processed = 0;

        const tasks = companies.map((company) =>
          limit(() => processCompany(company))
            .then(async (result) => {
              const { error } = await supabase
                .from("recheck_results")
                .upsert(result, { onConflict: "code_firme" });
              if (error) throw new Error(error.message);
              processed++;
              send({ type: "company", company, result });
            })
            .catch((err: any) => {
              send({ code_firme: company.code_firme, error: String(err?.message ?? err), type: "error" });
            })
        );

        await Promise.all(tasks);

        const remaining = Math.max(0, totalPending - companies.length);
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
