"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Verdict = "Confirmé" | "À corriger" | "Estimé" | "Donnée insuffisante";

interface CompanyRow {
  code_firme: string;
  raison_sociale: string;
  ville: string | null;
  tranche_ca_actuelle: string | null;
  annee_ca_actuelle: number | null;
}

interface ResultRow {
  ca_bracket_suggested: string | null;
  ca_verdict: Verdict;
  ca_year: number | null;
  ca_confidence: number;
  ca_layer: string | null;
  ca_model_used: string | null;
  ca_sources: string[];
  ca_reasoning: string;

  export_value_mad: number | null;
  export_value_derived: boolean;
  export_pct: number | null;
  export_year: number | null;
  export_verdict: Verdict;
  export_confidence: number;
  export_layer: string | null;
  export_model_used: string | null;
  export_sources: string[];
  export_reasoning: string;
}

interface Row {
  company: CompanyRow;
  result: ResultRow | null;
}

const FILTERS: { label: string; verdict: Verdict | "Tous" | "Non traité" }[] = [
  { label: "Tous", verdict: "Tous" },
  { label: "Confirmé", verdict: "Confirmé" },
  { label: "À corriger", verdict: "À corriger" },
  { label: "Estimé", verdict: "Estimé" },
  { label: "Donnée insuffisante", verdict: "Donnée insuffisante" },
  { label: "Non traité", verdict: "Non traité" }
];

function verdictBadgeClass(verdict: Verdict | "Non traité"): string {
  switch (verdict) {
    case "Confirmé":
      return "badge badge-confirme";
    case "À corriger":
      return "badge badge-corriger";
    case "Estimé":
      return "badge badge-estime";
    case "Donnée insuffisante":
      return "badge badge-insuffisante";
    default:
      return "badge badge-neutral";
  }
}

function formatMad(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("fr-FR").format(value) + " MAD";
}

export default function Home() {
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);

  const [processing, setProcessing] = useState(false);
  const [processedCount, setProcessedCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [errors, setErrors] = useState<{ code_firme: string; error: string }[]>([]);
  const stopRef = useRef(false);

  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState<Verdict | "Tous" | "Non traité">("Tous");
  const [loadingResults, setLoadingResults] = useState(false);

  const refreshResults = useCallback(async () => {
    setLoadingResults(true);
    try {
      const res = await fetch("/api/results");
      const data = await res.json();
      if (data.rows) {
        setRows(data.rows);
        setTotal(data.total ?? 0);
        setProcessedCount(data.done ?? 0);
      }
    } finally {
      setLoadingResults(false);
    }
  }, []);

  useEffect(() => {
    refreshResults();
  }, [refreshResults]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadMessage(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Échec de l'upload.");
      setUploadMessage(`${data.inserted} entreprises chargées.`);
      await refreshResults();
    } catch (err: any) {
      setUploadMessage(`Erreur: ${err.message}`);
    } finally {
      setUploading(false);
    }
  }

  async function runProcessing() {
    setProcessing(true);
    stopRef.current = false;
    setErrors([]);
    try {
      while (!stopRef.current) {
        const res = await fetch("/api/process-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchSize: 10 })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Erreur pendant le traitement.");

        if (data.failed?.length) {
          setErrors((prev) => [...prev, ...data.failed]);
        }
        await refreshResults();

        if (data.processed === 0 && data.remaining === 0) break;
        if (data.processed === 0 && data.failed?.length === 0) break; // safety: avoid infinite loop
      }
    } catch (err: any) {
      setErrors((prev) => [...prev, { code_firme: "—", error: err.message }]);
    } finally {
      setProcessing(false);
    }
  }

  function stopProcessing() {
    stopRef.current = true;
  }

  const filteredRows = rows.filter((r) => {
    if (filter === "Tous") return true;
    if (filter === "Non traité") return r.result === null;
    return r.result?.ca_verdict === filter || r.result?.export_verdict === filter;
  });

  const progressPct = total > 0 ? Math.round((processedCount / total) * 100) : 0;

  return (
    <main className="container">
      <h1>FCP — Recheck CA & Export</h1>
      <p className="subtitle">
        Vérification du chiffre d'affaires (tranche), du CA export et de la part export pour chaque
        entreprise membre — recherche via Gemini (Google Search), secours Tavily, puis estimation
        raisonnée si aucune source n'est trouvée.
      </p>

      <div className="panel">
        <h2>1. Charger le fichier</h2>
        <div className="row">
          <input type="file" accept=".xlsx" onChange={handleUpload} disabled={uploading} />
          {uploading && <span>Chargement…</span>}
        </div>
        {uploadMessage && <p className="subtitle" style={{ marginTop: 8, marginBottom: 0 }}>{uploadMessage}</p>}
      </div>

      <div className="panel">
        <h2>2. Lancer / reprendre le traitement</h2>
        <div className="row">
          <button onClick={runProcessing} disabled={processing || total === 0}>
            {processing ? "Traitement en cours…" : "Lancer le traitement"}
          </button>
          {processing && (
            <button className="secondary" onClick={stopProcessing}>
              Arrêter après le lot en cours
            </button>
          )}
          <span className="subtitle" style={{ margin: 0 }}>
            {processedCount} / {total} traitées
          </span>
        </div>
        <div className="progress-bar-track">
          <div className="progress-bar-fill" style={{ width: `${progressPct}%` }} />
        </div>
        {errors.length > 0 && (
          <div className="error-text">
            {errors.length} erreur(s) — le traitement peut être relancé, seules les entreprises non
            traitées seront reprises.
            <ul>
              {errors.slice(0, 5).map((e, i) => (
                <li key={i}>
                  {e.code_firme}: {e.error}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>3. Résultats</h2>
          <div className="row">
            <button className="secondary" onClick={refreshResults} disabled={loadingResults}>
              Rafraîchir
            </button>
            <a href="/api/export">
              <button>Exporter en Excel</button>
            </a>
          </div>
        </div>

        <div className="filters" style={{ marginTop: 14 }}>
          {FILTERS.map((f) => (
            <button
              key={f.label}
              className={filter === f.verdict ? "active" : ""}
              onClick={() => setFilter(f.verdict)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ overflowX: "auto", maxHeight: 650, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Entreprise</th>
                <th>Ville</th>
                <th>Tranche CA (avant / après)</th>
                <th>Année CA</th>
                <th>Statut CA</th>
                <th>Niveau CA</th>
                <th>CA Export</th>
                <th>% Export</th>
                <th>Année Export</th>
                <th>Statut Export</th>
                <th>Niveau Export</th>
                <th>Sources</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(({ company, result }) => (
                <tr key={company.code_firme}>
                  <td>
                    <strong>{company.raison_sociale}</strong>
                    <div className="subtitle" style={{ margin: 0 }}>{company.code_firme}</div>
                  </td>
                  <td>{company.ville}</td>
                  <td>
                    <div className="diff-old">{company.tranche_ca_actuelle}</div>
                    <div className="diff-new">{result?.ca_bracket_suggested ?? "—"}</div>
                  </td>
                  <td>{result?.ca_year ?? "—"}</td>
                  <td>
                    <span className={verdictBadgeClass(result?.ca_verdict ?? ("Non traité" as const))}>
                      {result?.ca_verdict ?? "Non traité"}
                    </span>
                    <div className="subtitle" style={{ margin: 0 }}>
                      {result ? `${result.ca_confidence}% conf.` : ""}
                    </div>
                  </td>
                  <td>{result?.ca_layer ?? "—"}</td>
                  <td>
                    {formatMad(result?.export_value_mad)}
                    {result?.export_value_derived && (
                      <div className="subtitle" style={{ margin: 0 }}>(calculé)</div>
                    )}
                  </td>
                  <td>{result?.export_pct != null ? `${result.export_pct}%` : "—"}</td>
                  <td>{result?.export_year ?? "—"}</td>
                  <td>
                    <span className={verdictBadgeClass(result?.export_verdict ?? ("Non traité" as const))}>
                      {result?.export_verdict ?? "Non traité"}
                    </span>
                    <div className="subtitle" style={{ margin: 0 }}>
                      {result ? `${result.export_confidence}% conf.` : ""}
                    </div>
                  </td>
                  <td>{result?.export_layer ?? "—"}</td>
                  <td className="sources">
                    {result?.ca_sources?.slice(0, 1).map((s, i) => (
                      <div key={`ca-${i}`}>CA: {s}</div>
                    ))}
                    {result?.export_sources?.slice(0, 1).map((s, i) => (
                      <div key={`exp-${i}`}>Export: {s}</div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
