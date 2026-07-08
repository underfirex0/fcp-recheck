-- Run this once in the Supabase SQL editor for your new project.

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

  -- Chiffre d'affaires recheck
  ca_value_mad numeric,               -- raw CA figure found, in MAD (not millions)
  ca_year int,
  ca_status text not null,            -- 'confirmed' | 'conflicting' | 'not_found'
  ca_confidence int not null default 0,
  ca_sources jsonb not null default '[]',
  ca_reasoning text,
  ca_bracket_current text,            -- snapshot of the value that was in the file at recheck time
  ca_bracket_suggested text,          -- computed via Seg.xlsx logic, NOT by the AI
  ca_verdict text not null,           -- 'Confirmé' | 'À corriger' | 'Donnée insuffisante'
  ca_model_used text,                 -- 'flash' | 'pro'

  -- % CA Export (net new field)
  export_pct numeric,
  export_year int,
  export_status text not null,
  export_confidence int not null default 0,
  export_sources jsonb not null default '[]',
  export_reasoning text,
  export_model_used text,

  reviewed boolean not null default false,
  processed_at timestamptz not null default now()
);

create index if not exists idx_recheck_verdict on recheck_results (ca_verdict);
