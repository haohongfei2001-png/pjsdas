-- PJSDAS background Gmail automation infrastructure.
--
-- This migration is intentionally additive. It does NOT schedule the production
-- worker. The scheduler is enabled only after the matching backend commit has
-- passed production self-test, so a database migration cannot race a missing
-- deployment endpoint.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

alter table public.google_drive_connections
  add column if not exists gmail_automation_enabled boolean not null default false,
  add column if not exists gmail_history_id text,
  add column if not exists gmail_last_checked_at timestamptz,
  add column if not exists gmail_last_success_at timestamptz,
  add column if not exists gmail_last_error text;

create index if not exists google_drive_connections_gmail_automation_enabled_idx
  on public.google_drive_connections (gmail_automation_enabled)
  where gmail_automation_enabled = true and revoked_at is null;

comment on column public.google_drive_connections.gmail_automation_enabled is
  'Whether PJSDAS may run background Gmail recruiting-email ingestion for this user.';
comment on column public.google_drive_connections.gmail_history_id is
  'Last successfully committed Gmail history cursor. Advanced only after PJSDAS workspace ingestion succeeds.';
comment on column public.google_drive_connections.gmail_last_checked_at is
  'Most recent attempted Gmail automation check.';
comment on column public.google_drive_connections.gmail_last_success_at is
  'Most recent successful Gmail automation check and workspace reconciliation.';
comment on column public.google_drive_connections.gmail_last_error is
  'Bounded latest Gmail automation error summary; never stores raw email content.';

do $$
begin
  if not exists (
    select 1 from vault.secrets where name = 'pjsdas_gmail_automation_worker_token'
  ) then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'pjsdas_gmail_automation_worker_token',
      'Bearer token used only by the Supabase scheduler to invoke the PJSDAS Gmail automation worker.'
    );
  end if;
end
$$;

create or replace function public.pjsdas_claim_gmail_automation_bindings(worker_token text)
returns table (
  user_id uuid,
  google_subject text,
  google_email text,
  refresh_token_ciphertext text,
  granted_scopes text[],
  gmail_history_id text,
  gmail_last_checked_at timestamptz
)
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
begin
  if worker_token is null or not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'pjsdas_gmail_automation_worker_token'
      and decrypted_secret = worker_token
  ) then
    raise exception 'Invalid PJSDAS automation worker token.' using errcode = '42501';
  end if;

  return query
  select
    c.user_id,
    c.google_subject,
    c.google_email,
    c.refresh_token_ciphertext,
    c.granted_scopes,
    c.gmail_history_id,
    c.gmail_last_checked_at
  from public.google_drive_connections c
  where c.gmail_automation_enabled = true
    and c.revoked_at is null
  order by c.updated_at asc;
end
$$;

revoke all on function public.pjsdas_claim_gmail_automation_bindings(text) from public;
grant execute on function public.pjsdas_claim_gmail_automation_bindings(text) to anon;

create or replace function public.pjsdas_update_gmail_automation_state(
  worker_token text,
  target_user_id uuid,
  next_history_id text default null,
  checked_at timestamptz default null,
  success_at timestamptz default null,
  last_error text default null,
  set_history_id boolean default false,
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
    where name = 'pjsdas_gmail_automation_worker_token'
      and decrypted_secret = worker_token
  ) then
    raise exception 'Invalid PJSDAS automation worker token.' using errcode = '42501';
  end if;

  update public.google_drive_connections
  set
    gmail_history_id = case when set_history_id then next_history_id else gmail_history_id end,
    gmail_last_checked_at = coalesce(checked_at, gmail_last_checked_at),
    gmail_last_success_at = coalesce(success_at, gmail_last_success_at),
    gmail_last_error = case when set_last_error then last_error else gmail_last_error end,
    updated_at = coalesce(checked_at, now())
  where user_id = target_user_id
    and revoked_at is null;
end
$$;

revoke all on function public.pjsdas_update_gmail_automation_state(
  text, uuid, text, timestamptz, timestamptz, text, boolean, boolean
) from public;
grant execute on function public.pjsdas_update_gmail_automation_state(
  text, uuid, text, timestamptz, timestamptz, text, boolean, boolean
) to anon;
