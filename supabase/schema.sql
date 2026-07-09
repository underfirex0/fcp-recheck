-- Run this once in the Supabase SQL editor for your new project.
-- If you already have the old tables from before the 4-layer pipeline rebuild,
-- drop and recreate recheck_results (companies can stay as-is):
--   drop table if exists recheck_results;
-- then run this file.

create table if not exists companies (
  code_firme text primary key,
  raison_sociale text not null,
  rs_abrg text,
  adresse text,
  ville text,
  region text,
  tranche_ca_actuelle text,   -- original "Tranche CA millions DH" from the source file
  annee_ca_actuelle int,      -- original "ANNEE CA" from the source file
  created_at timestamptz default now()
);

create table if not exists recheck_results (
  code_firme text primary key references companies(code_firme) on delete cascade,

  -- Chiffre d'affaires
  ca_value_mad numeric,               -- raw CA figure, in MAD (not millions)
  ca_year int,
  ca_status text not null,            -- 'confirmed' | 'estimated' | 'not_found'
  ca_confidence int not null default 0,
  ca_sources jsonb not null default '[]',
  ca_reasoning text,
  ca_layer text,                      -- 'grounding' | 'tavily' | 'estimated' | null
  ca_bracket_current text,            -- snapshot of the value that was in the file at recheck time
  ca_bracket_suggested text,          -- computed via Seg.xlsx logic, NOT by the AI
  ca_verdict text not null,           -- 'Confirmé' | 'À corriger' | 'Estimé' | 'Donnée insuffisante'
  ca_model_used text,                 -- 'flash' | 'pro'

  -- CA Export (raw amount) + % CA Export
  export_value_mad numeric,
  export_value_derived boolean not null default false, -- true if computed from ca * pct, not found directly
  export_pct numeric,
  export_year int,
  export_status text not null,        -- 'confirmed' | 'estimated' | 'not_found'
  export_confidence int not null default 0,
  export_sources jsonb not null default '[]',
  export_reasoning text,
  export_layer text,                  -- 'grounding' | 'tavily' | 'estimated' | null
  export_verdict text not null,       -- 'Confirmé' | 'Estimé' | 'Donnée insuffisante'
  export_model_used text,             -- 'flash' | 'pro'

  reviewed boolean not null default false,
  processed_at timestamptz not null default now()
);

create index if not exists idx_recheck_ca_verdict on recheck_results (ca_verdict);
create index if not exists idx_recheck_export_verdict on recheck_results (export_verdict);
