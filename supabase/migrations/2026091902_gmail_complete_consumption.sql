-- Persist Gmail source-consumption continuation so PJSDAS never advances the
-- durable history watermark past unprocessed pages or message ids.

alter table public.google_drive_connections
  add column if not exists gmail_sync_mode text,
  add column if not exists gmail_page_token text,
  add column if not exists gmail_pending_history_id text,
  add column if not exists gmail_pending_message_ids text[] not null default '{}';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'google_drive_connections_gmail_sync_mode_check'
  ) then
    alter table public.google_drive_connections
      add constraint google_drive_connections_gmail_sync_mode_check
      check (gmail_sync_mode is null or gmail_sync_mode in ('history', 'fallback'));
  end if;
end
$$;

comment on column public.google_drive_connections.gmail_sync_mode is
  'Current incomplete Gmail consumption mode. Null means there is no persisted partial batch.';
comment on column public.google_drive_connections.gmail_page_token is
  'Opaque Gmail page token for the next unconsumed source page. Never treated as a completed watermark.';
comment on column public.google_drive_connections.gmail_pending_history_id is
  'History watermark captured for the in-progress complete-consumption interval. Promoted to gmail_history_id only after all pages and pending ids are committed.';
comment on column public.google_drive_connections.gmail_pending_message_ids is
  'Source message ids already discovered but not yet committed to PJSDAS. Drained before fetching another page.';

create or replace function public.pjsdas_claim_gmail_automation_bindings_v2(worker_token text)
returns table (
  user_id uuid,
  google_subject text,
  google_email text,
  refresh_token_ciphertext text,
  granted_scopes text[],
  gmail_history_id text,
  gmail_last_checked_at timestamptz,
  gmail_sync_mode text,
  gmail_page_token text,
  gmail_pending_history_id text,
  gmail_pending_message_ids text[]
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
    c.gmail_last_checked_at,
    c.gmail_sync_mode,
    c.gmail_page_token,
    c.gmail_pending_history_id,
    c.gmail_pending_message_ids
  from public.google_drive_connections c
  where c.gmail_automation_enabled = true
    and c.revoked_at is null
  order by c.updated_at asc;
end
$$;

revoke all on function public.pjsdas_claim_gmail_automation_bindings_v2(text) from public;
grant execute on function public.pjsdas_claim_gmail_automation_bindings_v2(text) to anon;

create or replace function public.pjsdas_update_gmail_automation_state_v2(
  worker_token text,
  target_user_id uuid,
  next_history_id text default null,
  next_sync_mode text default null,
  next_page_token text default null,
  next_pending_history_id text default null,
  next_pending_message_ids text[] default null,
  checked_at timestamptz default null,
  success_at timestamptz default null,
  last_error text default null,
  set_history_id boolean default false,
  set_continuation boolean default false,
  clear_continuation boolean default false,
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

  if set_continuation and next_sync_mode not in ('history', 'fallback') then
    raise exception 'Invalid Gmail continuation mode.' using errcode = '22023';
  end if;

  update public.google_drive_connections
  set
    gmail_history_id = case when set_history_id then next_history_id else gmail_history_id end,
    gmail_sync_mode = case
      when clear_continuation then null
      when set_continuation then next_sync_mode
      else gmail_sync_mode
    end,
    gmail_page_token = case
      when clear_continuation then null
      when set_continuation then next_page_token
      else gmail_page_token
    end,
    gmail_pending_history_id = case
      when clear_continuation then null
      when set_continuation then next_pending_history_id
      else gmail_pending_history_id
    end,
    gmail_pending_message_ids = case
      when clear_continuation then '{}'::text[]
      when set_continuation then coalesce(next_pending_message_ids, '{}'::text[])
      else gmail_pending_message_ids
    end,
    gmail_last_checked_at = coalesce(checked_at, gmail_last_checked_at),
    gmail_last_success_at = coalesce(success_at, gmail_last_success_at),
    gmail_last_error = case when set_last_error then last_error else gmail_last_error end,
    updated_at = coalesce(checked_at, now())
  where user_id = target_user_id
    and revoked_at is null;
end
$$;

revoke all on function public.pjsdas_update_gmail_automation_state_v2(
  text, uuid, text, text, text, text, text[], timestamptz, timestamptz, text, boolean, boolean, boolean, boolean
) from public;
grant execute on function public.pjsdas_update_gmail_automation_state_v2(
  text, uuid, text, text, text, text, text[], timestamptz, timestamptz, text, boolean, boolean, boolean, boolean
) to anon;
