-- PJSDAS server-owned background job-discovery infrastructure.
--
-- This migration is additive and intentionally does NOT schedule the production
-- worker. The cron is enabled only after the matching backend commit passes the
-- exact-backend deployment gate and production self-test.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

alter table public.google_drive_connections
  add column if not exists discovery_last_checked_at timestamptz,
  add column if not exists discovery_last_success_at timestamptz,
  add column if not exists discovery_last_error text;

comment on column public.google_drive_connections.discovery_last_checked_at is
  'Most recent attempted PJSDAS server-owned job-discovery check.';
comment on column public.google_drive_connections.discovery_last_success_at is
  'Most recent successful background job-discovery reconciliation.';
comment on column public.google_drive_connections.discovery_last_error is
  'Bounded latest discovery-worker error summary; never stores raw model output or fetched page bodies.';

do $$
begin
  if not exists (
    select 1 from vault.secrets where name = 'pjsdas_discovery_automation_worker_token'
  ) then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'pjsdas_discovery_automation_worker_token',
      'Bearer token used only by the Supabase scheduler to invoke the PJSDAS server-owned discovery worker.'
    );
  end if;
end
$$;

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
  order by c.updated_at asc;
end
$$;

revoke all on function public.pjsdas_claim_discovery_automation_bindings(text) from public;
grant execute on function public.pjsdas_claim_discovery_automation_bindings(text) to anon;

create or replace function public.pjsdas_update_discovery_automation_state(
  worker_token text,
  target_user_id uuid,
  checked_at timestamptz default null,
  success_at timestamptz default null,
  last_error text default null,
  set_last_error boolean default false
)
returns void
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

  update public.google_drive_connections
  set
    discovery_last_checked_at = coalesce(checked_at, discovery_last_checked_at),
    discovery_last_success_at = coalesce(success_at, discovery_last_success_at),
    discovery_last_error = case when set_last_error then last_error else discovery_last_error end,
    updated_at = coalesce(checked_at, now())
  where user_id = target_user_id
    and revoked_at is null;
end
$$;

revoke all on function public.pjsdas_update_discovery_automation_state(
  text, uuid, timestamptz, timestamptz, text, boolean
) from public;
grant execute on function public.pjsdas_update_discovery_automation_state(
  text, uuid, timestamptz, timestamptz, text, boolean
) to anon;
