-- Controlled-production audience grants.
--
-- The table is intentionally server-owned. Merely having a valid Supabase
-- account does not imply access once PJSDAS_AUDIENCE_MODE=allowlist.

create table if not exists public.pjsdas_access_grants (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null check (role in ('owner', 'beta')),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  note text
);

create index if not exists pjsdas_access_grants_active_idx
  on public.pjsdas_access_grants (role, granted_at)
  where revoked_at is null;

alter table public.pjsdas_access_grants enable row level security;

revoke all on table public.pjsdas_access_grants from anon, authenticated;
grant select, insert, update, delete on table public.pjsdas_access_grants to service_role;

comment on table public.pjsdas_access_grants is
  'Controlled-production owner/beta allowlist. Server-owned; valid auth alone is insufficient when allowlist mode is active.';
