-- Run this once in your Supabase SQL editor before using the redesigned
-- link resolver. Safe to run on your existing live table — just adds one
-- column, doesn't touch any existing data.

alter table recheck_results
  add column if not exists link_resolve_attempts int not null default 0;
