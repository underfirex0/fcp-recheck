# Deployment guide — FCP Recheck CA & Export

Follow in this order: **Supabase → Tavily → Gemini/GCP → GitHub → Vercel**. Each step
tells you exactly what to click/run and which value to save for later.

Keep a scratch note open — you'll collect 6 values total:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TAVILY_API_KEY`, and either
(`GCP_PROJECT` + a service account key) or (`GEMINI_API_KEY`).

---

## 1. Supabase (database)

1. Go to **supabase.com** → sign in → **New project**.
2. Pick a name (e.g. `fcp-ca-recheck`), a region close to you (e.g. Europe/`eu-west-1`
   or `eu-central-1` — closer to Morocco than US regions), set a database password
   (save it, you likely won't need it again but keep it somewhere safe).
3. Wait ~2 min for provisioning.
4. Left sidebar → **SQL Editor** → **New query**. Paste the entire content of
   `supabase/schema.sql` from the project, click **Run**. You should see "Success. No
   rows returned."
5. Left sidebar → **Project Settings** → **API**.
   - Copy **Project URL** → this is `SUPABASE_URL`.
   - Copy the **`service_role`** key (NOT the `anon` key — service_role bypasses row
     security and is what the server-side code needs) → this is `SUPABASE_SERVICE_ROLE_KEY`.
   - ⚠️ The service_role key is a master key for your database. Never put it in
     client-side code or commit it to git — it only goes into Vercel's environment
     variables (server-side), never in the repo.

---

## 2. Tavily (search)

1. Go to **tavily.com** → sign up (free tier: 1,000 credits/month, no card required).
2. Dashboard → **API Keys** → copy the default key (starts with `tvly-`) →
   this is `TAVILY_API_KEY`.

---

## 3. Gemini (extraction) — choose ONE path

### Path A — plain Gemini API key (simplest, no GCP auth setup)
1. Go to **aistudio.google.com/apikey**.
2. **Create API key** → choose or create a GCP project (this can still be the project
   tied to your GCP credits — API-key billing draws from the same project's billing
   account).
3. Copy the key → this is `GEMINI_API_KEY`.
4. In `.env` later: `GOOGLE_GENAI_USE_VERTEXAI=false`.

This is the path to pick if you just want it working today. It still bills against
your GCP project if that project has your credits attached.

### Path B — Vertex AI (if you specifically want Vertex-style billing/quota)
1. Go to **console.cloud.google.com** → select (or create) your project with the credits.
2. Enable the API: search "Vertex AI API" → **Enable**.
3. Create a service account: **IAM & Admin → Service Accounts → Create Service Account**.
   - Name: `fcp-recheck-gemini`
   - Grant role: **Vertex AI User**
   - **Create key** → JSON → downloads a `.json` file. Keep it safe, it's a credential.
4. In Vercel (step 5 below), you'll add this as a secret file or paste its contents into
   an environment variable and point `GOOGLE_APPLICATION_CREDENTIALS` at it — this is
   the fiddly part of Vertex AI on serverless platforms. If this feels like overkill,
   Path A is genuinely fine and simpler; come back to Vertex later if you need it.
5. In `.env` later: `GOOGLE_GENAI_USE_VERTEXAI=true`, `GCP_PROJECT=your-project-id`,
   `GCP_LOCATION=us-central1`.

**Recommendation: start with Path A.** Switch to Path B only if you hit a concrete reason
to (e.g. org policy requiring Vertex, or needing Vertex-specific quota/data-residency
controls) — it's a 2-line env change later (`lib/gemini.ts` already supports both).

---

## 4. GitHub (get the code into a repo)

On your machine, with the unzipped `fcp-ca-recheck` folder:

```bash
cd fcp-ca-recheck
git init
git add .
git commit -m "Initial commit: FCP CA & export recheck app"
```

Then on **github.com**: **New repository** → name it `fcp-ca-recheck` → **Private**
(recommended, since this touches business data) → **Create repository** (don't
initialize with a README, you already have one).

Push it, using the commands GitHub shows you on the empty-repo page (they'll look like):

```bash
git remote add origin https://github.com/YOUR_USERNAME/fcp-ca-recheck.git
git branch -M main
git push -u origin main
```

`.env.local` (if you created one to test locally) is not committed — make sure a
`.gitignore` excludes it. Add one if it's missing:

```bash
echo -e "node_modules\n.next\n.env*.local" > .gitignore
git add .gitignore && git commit -m "Add gitignore"
git push
```

---

## 5. Vercel (deploy)

1. Go to **vercel.com** → sign in (GitHub login is easiest) → **Add New… → Project**.
2. Import the `fcp-ca-recheck` GitHub repo you just pushed.
3. Framework preset should auto-detect **Next.js** — leave build settings default.
4. Before clicking Deploy, open **Environment Variables** and add:

   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | from step 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | from step 1 |
   | `TAVILY_API_KEY` | from step 2 |
   | `GOOGLE_GENAI_USE_VERTEXAI` | `false` (Path A) or `true` (Path B) |
   | `GEMINI_API_KEY` | from step 3, Path A only |
   | `GCP_PROJECT` / `GCP_LOCATION` | Path B only |

5. Click **Deploy**. Wait ~1-2 min.
6. Open the deployed URL — you should see the "FCP — Recheck CA & Export" dashboard.

---

## 6. First real test (do this before running all 584)

1. On the deployed site, upload `FCP_-_Global_à_compléter.xlsx`. You should see
   "584 entreprises chargées."
2. Click **Lancer le traitement**, then immediately click **Arrêter après le lot en
   cours** — this lets exactly one batch (10 companies) run and stop, so you can sanity
   check real output before committing to the full run.
3. Check the results table: are sources showing up? Do the suggested brackets look
   plausible? Any errors listed?
4. If it looks right, click **Lancer le traitement** again — it resumes automatically
   from where it left off, and will keep going until all 584 are done (leave the tab
   open; this can take a while depending on batch pacing).
5. When done, click **Exporter en Excel**.

---

## Costs you'll actually see land on each account

- **Supabase**: $0 (free tier easily covers this).
- **Vercel**: $0 (Hobby plan is fine for a low-traffic internal tool).
- **Tavily**: a few dollars, charged against your Tavily account (1,000 free
  credits/month covers a large chunk of the ~1,168 searches needed).
- **Gemini**: a few dollars, charged against whichever GCP project holds your credits
  (Path A) or your Vertex AI billing (Path B).
