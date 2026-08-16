-- Run this once in Supabase's SQL Editor. See README.md Stage 1 setup
-- steps for exactly where to paste this.

create table if not exists visitors (
  id uuid primary key default gen_random_uuid(),
  client_id text unique not null,
  free_used integer not null default 0,
  paid_credits integer not null default 0,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

-- Row Level Security is turned on with no policies added, which blocks
-- all access from the public/anon key by default. Our backend uses the
-- separate service_role key, which always bypasses RLS — so this table
-- stays fully private from anyone browsing the site directly.
alter table visitors enable row level security;
