# FCP — Recheck CA & Export

A standalone mini-app that rechecks the "Tranche CA millions DH" bracket and fills in the
missing "% CA EXPORT" field for the 584 FCP member companies, with sources and a
confidence score for every value.

## How it works

1. **Upload** `FCP_-_Global_à_compléter.xlsx` on the homepage. This loads all companies
   into the `companies` table (their current CA bracket and year are kept as a snapshot —
   never overwritten).
2. **Run the processing.** The UI calls `/api/process-batch` in a loop (10 companies per
   call) until every company has been processed. This avoids serverless timeout issues —
   each individual API call is small and fast; the *browser* drives the loop, not a
   single long-running job. You can stop and resume at any time; already-processed
   companies are skipped automatically.
3. For each company, the pipeline:
   - Runs 2 Tavily searches (one for CA, one for export %).
   - Sends both result sets to **Gemini 2.5 Flash** in a single call, forcing structured
     JSON output with a value, year, sources, status (`confirmed` / `conflicting` /
     `not_found`), and a confidence score for each of the two fields.
   - **Escalates to Gemini 2.5 Pro** — per field, independently — only when Flash itself
     flagged that field as `conflicting`, or `confirmed` with confidence below 60%.
     `not_found` is never escalated (if there's genuinely nothing online, re-running a
     bigger model on the same empty context won't invent a source).
   - Computes the suggested bracket **in plain code** (`lib/seg.ts`), using the exact
     Seg.xlsx thresholds — Gemini never decides the bracket itself, only the raw MAD figure.
   - Compares the suggested bracket to the original one and produces a verdict:
     `Confirmé`, `À corriger`, or `Donnée insuffisante`.
4. **Review** the results table in the UI (filterable by verdict), then **Export to
   Excel** — this produces a new file with the original columns preserved plus the
   before/after bracket, the export %, sources, confidence, and which model was used
   for each field.

## Setup

1. Create a new Supabase project, then run `supabase/schema.sql` in its SQL editor.
2. Copy `.env.example` to `.env.local` and fill in:
   - Supabase URL + service role key
   - Tavily API key
   - Gemini: either Vertex AI (uses your GCP credits — needs Application Default
     Credentials, see comments in `.env.example`) or a plain Gemini API key from AI Studio.
3. `npm install`
4. `npm run dev` — open `http://localhost:3000`

To deploy: push to GitHub, import into Vercel, set the same environment variables there.
If using Vertex AI on Vercel, you'll need to set up GCP service account credentials
(Workload Identity Federation or a downloaded key mounted as a secret) — this is the one
part of Vertex AI auth that doesn't "just work" the way an API key does; the plain Gemini
API key (Option B in `.env.example`) is the simpler path if you want zero extra auth setup,
at the cost of not drawing directly on your GCP credits.

## Cost expectations (584 companies)

- **Tavily**: ~1,168 basic searches (2 per company) ≈ $9–19 depending on plan/PAYG rate.
- **Gemini**: Flash-first + Pro-escalation hybrid, ≈ $2.50–5 total even with generous
  escalation rates — comfortably under a $10 ceiling.
- **Supabase / Vercel**: free tier is enough for this dataset size (few hundred rows,
  one-off batch job).

## Design notes / things worth knowing

- **Rate limiting**: batches process 3 companies concurrently (`CONCURRENCY` in
  `lib/pipeline.ts`). If you hit Tavily or Gemini rate limits, lower this.
- **Resumability**: `processBatch` diffs `companies` against `recheck_results` in memory
  and only processes what's missing — safe to stop/restart/retry at any time.
- **Auditability**: every row keeps the raw CA figure, year, sources, confidence, model
  used, and the AI's reasoning text — so a human reviewer can always see *why* a bracket
  changed, not just that it did.
- **Not tested against live Tavily/Gemini calls** in this sandbox (no network access to
  those APIs from where this was built) — the code is complete and type-consistent, but
  your first real run against live keys is the first real end-to-end test. Worth doing a
  small test (`batchSize: 3`) before kicking off the full 584.
