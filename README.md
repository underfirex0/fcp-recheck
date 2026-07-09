# FCP — Recheck CA & Export

A standalone mini-app that rechecks the "Tranche CA millions DH" bracket and fills in
**CA Export**, **% CA Export** (with year and sources for both) for the FCP member
companies — aiming for 100% field completion via a 4-layer research pipeline, never
leaving a field silently blank.

## The 4-layer pipeline (per company)

1. **Gemini + native Google Search grounding** (`lib/gemini.ts: groundedSearch`). Asks
   both the CA and export questions directly in plain language; Gemini runs its own
   Google Search queries internally and answers with citations. This replaced an
   earlier Tavily-only design because grounding's recall is meaningfully better —
   confirmed on real companies (e.g. Tavily missed OCP's export share entirely, a
   figure that's genuinely easy to find).
2. **Structured extraction** (`extractFromGroundedAnswer`). Gemini Flash turns the
   grounded answer into strict JSON (value, year, status, confidence, sources) for
   both the CA and export field groups. Each field group escalates to Gemini Pro
   independently if Flash itself flags it as `conflicting`, or `confirmed` with
   confidence below 60%.
3. **Tavily fallback** (`lib/pipeline.ts: resolveCa` / `resolveExport`). Only triggered
   per-field, per-company, when step 1+2 came back `not_found`. A different search
   engine/index gets a genuinely independent second attempt, not a redundant one.
4. **Reasoned estimation** (`estimateCa` / `estimateExport`). Only reached when layers
   1–3 all found nothing. Gemini Pro produces a clearly-labeled **estimate** using
   indirect context — the company's previously declared CA bracket, its city/region,
   and its likely sector — with confidence hard-capped at 40 so an estimate can never
   outrank a genuinely sourced figure. This is never silently blended with real data:
   every stored value has a `layer` (`grounding` / `tavily` / `estimated`) and a
   `verdict` (`Confirmé` / `À corriger` / `Estimé` / `Donnée insuffisante`) so a
   reviewer always knows exactly how a number was obtained.

**Bracket bucketing stays deterministic, plain code** (`lib/seg.ts`), using the exact
Seg.xlsx thresholds — Gemini (at any layer) only ever produces a raw MAD figure, never
decides which bracket it falls into.

**CA Export derivation**: if the estimation layer only produces a % (no raw amount),
the raw "CA Export" MAD figure is computed as `CA × %` in code and flagged
`export_value_derived: true` — clearly distinguished from a directly sourced amount.

## Setup

1. Create a Supabase project, run `supabase/schema.sql` in its SQL editor.
2. Copy `.env.example` to `.env.local`, fill in Supabase, Tavily (single key or
   `TAVILY_API_KEYS` comma-separated for multi-key rotation across free-tier accounts),
   and Gemini (Vertex AI with `GOOGLE_APPLICATION_CREDENTIALS_JSON`, or a plain AI
   Studio key).
3. `npm install`, `npm run dev`.

## Cost expectations (584 companies) — estimate, not measured

| Layer | Volume estimate | Cost |
|---|---|---|
| Grounding (Layer 1), 1 call/company | 584 | $0 if within free 5,000/month grounded-prompt quota; ~$8 otherwise |
| Flash extraction (base) | 584 | ~$1 |
| Pro escalation on ambiguous cases (~25%) | ~150 | ~$1.5 |
| Tavily fallback (Layer 3, only for misses, ~15% of fields) | ~175 | ~$0–1.50 |
| Extra extraction on Tavily results | ~175 | ~$0.30 |
| Pro estimation (Layer 4, only for true misses, ~5%) | ~60 | ~$0.20 |
| **Total, realistic range** | | **~$5–10 most likely, up to ~$22 if grounding quota is already used up elsewhere on the GCP project** |

These percentages are best estimates based on limited real testing (10 companies), not
a guarantee — the true escalation/fallback rates across all 584 will only be known
after a full run.

## Design notes

- **Resumability**: `processBatch` diffs `companies` against `recheck_results` in
  memory and only processes what's missing — safe to stop/restart at any time.
- **Multi-key Tavily rotation**: set `TAVILY_API_KEYS` (comma-separated) to spread
  usage across several free-tier accounts; the app automatically moves to the next key
  on Tavily's "out of credits" response (HTTP 432).
- **Auditability**: every row keeps the raw figure, year, sources, confidence, model,
  and which layer produced it — so a human reviewer can always see *why* and *how* a
  value was obtained, not just what it is.
- **Not tested against live Tavily/Gemini calls** in the sandbox this was built in (no
  network access to those APIs from there) — the code is type-checked and build-clean,
  but a real run against live keys is the first true end-to-end test. Test a small
  batch (10 companies) before running all 584.
