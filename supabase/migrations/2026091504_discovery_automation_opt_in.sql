-- Server-owned public-web discovery is explicit opt-in. Connecting Google or
-- configuring a Discovery Profile does not by itself authorize background
-- model/search processing.
--
-- The inner claim RPC was created by the previous migration and performs the
-- independent Vault-token validation. This migration removes direct anonymous
-- access to that broad internal claim and exposes only an opt-in-filtered
-- wrapper to the scheduler-facing PostgREST role.

alter table public.google_drive_connections
  add column if not exists discovery_automation_enabled boolean not null default false;

comment on column public.google_drive_connections.discovery_automation_enabled is
  'Explicit user opt-in for PJSDAS server-owned background public-web job discovery.';

create or replace function public.pjsdas_claim_enabled_discovery_automation_bindings(worker_token text)
returns table (
  user_id uuid,
  google_subject text,
  google_email text,
  refresh_token_ciphertext text,
  granted_scopes text[],
  discovery_last_checked_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    claimed.user_id,
    claimed.google_subject,
    claimed.google_email,
    claimed.refresh_token_ciphertext,
    claimed.granted_scopes,
    claimed.discovery_last_checked_at
  from public.pjsdas_claim_discovery_automation_bindings(worker_token) as claimed
  join public.google_drive_connections as connection
    on connection.user_id = claimed.user_id
  where connection.revoked_at is null
    and connection.discovery_automation_enabled is true
  order by connection.updated_at asc;
$$;

-- The broad claim remains an internal SECURITY DEFINER implementation detail.
revoke all on function public.pjsdas_claim_discovery_automation_bindings(text) from public;
revoke execute on function public.pjsdas_claim_discovery_automation_bindings(text) from anon;
revoke execute on function public.pjsdas_claim_discovery_automation_bindings(text) from authenticated;

revoke all on function public.pjsdas_claim_enabled_discovery_automation_bindings(text) from public;
revoke execute on function public.pjsdas_claim_enabled_discovery_automation_bindings(text) from authenticated;
grant execute on function public.pjsdas_claim_enabled_discovery_automation_bindings(text) to anon;
