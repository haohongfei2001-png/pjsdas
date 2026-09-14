-- Server-owned public-web discovery is explicit opt-in. Connecting Google or
-- configuring a Discovery Profile does not by itself authorize background
-- model/search processing.

alter table public.google_drive_connections
  add column if not exists discovery_automation_enabled boolean not null default false;

comment on column public.google_drive_connections.discovery_automation_enabled is
  'Explicit user opt-in for PJSDAS server-owned background public-web job discovery.';

create or replace function public.pjsdas_claim_discovery_automation_bindings(worker_token text)
returns table (
  user_id uuid,
  google_subject text,
  google_email text,
  refresh_token_ciphertext text,
  granted_scopes text[],
  discovery_last_checked_at timestamptz
)
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
begin
  if worker_token is null or not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'pjsdas_discovery_automation_worker_token'
      and decrypted_secret = worker_token
  ) then
    raise exception 'Invalid PJSDAS discovery automation worker token.' using errcode = '42501';
  end if;

  return query
  select
    c.user_id,
    c.google_subject,
    c.google_email,
    c.refresh_token_ciphertext,
    c.granted_scopes,
    c.discovery_last_checked_at
  from public.google_drive_connections c
  where c.revoked_at is null
    and c.discovery_automation_enabled is true
  order by c.updated_at asc;
end
$$;

revoke all on function public.pjsdas_claim_discovery_automation_bindings(text) from public;
revoke execute on function public.pjsdas_claim_discovery_automation_bindings(text) from authenticated;
grant execute on function public.pjsdas_claim_discovery_automation_bindings(text) to anon;
