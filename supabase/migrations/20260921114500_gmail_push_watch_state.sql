-- UU06: Gmail Pub/Sub push/watch state. Additive and dormant until the
-- matching backend environment and Google Cloud topic/subscription are configured.
-- No Gmail scope expansion, mailbox opt-in, paid resource, or external recruiting action.
alter table public.google_drive_connections
  add column if not exists gmail_watch_history_id text,
  add column if not exists gmail_watch_expires_at timestamptz,
  add column if not exists gmail_watch_last_renewed_at timestamptz,
  add column if not exists gmail_watch_last_error text;

comment on column public.google_drive_connections.gmail_watch_history_id is
  'Latest Gmail users.watch historyId. Operational watch metadata only; not the authoritative ingestion cursor.';
comment on column public.google_drive_connections.gmail_watch_expires_at is
  'Gmail users.watch expiration. Renewal is independent of history consumption.';
comment on column public.google_drive_connections.gmail_watch_last_error is
  'Bounded watch-registration error code only; never raw provider text or message content.';

-- Reuse the existing explicit-consent guard and also erase push/watch metadata when
-- the expanded consent, Gmail permission, binding or account is no longer valid.
create or replace function public.pjsdas_guard_gmail_intake_consent()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.revoked_at is not null
    or not coalesce(new.gmail_automation_enabled, false)
    or not ('https://www.googleapis.com/auth/gmail.readonly' = any(coalesce(new.granted_scopes, '{}'::text[])))
    or (tg_op = 'UPDATE' and (new.google_subject is distinct from old.google_subject
      or new.refresh_token_ciphertext is distinct from old.refresh_token_ciphertext))
    or coalesce(new.gmail_last_error, '') ~ '^(GOOGLE_AUTH_EXPIRED|GOOGLE_GMAIL_FORBIDDEN|GOOGLE_GMAIL_SCOPE_MISSING|GOOGLE_ACCOUNT_MISMATCH|GOOGLE_REFRESH_FAILED):'
  then
    new.gmail_intake_consent_version := null;
  end if;

  if tg_op = 'UPDATE' and old.gmail_intake_consent_version = 'uu06-v1'
    and new.gmail_intake_consent_version is distinct from 'uu06-v1' then
    new.gmail_sync_mode := null;
    new.gmail_page_token := null;
    new.gmail_pending_history_id := null;
    new.gmail_pending_message_ids := '{}'::text[];
  end if;

  if new.gmail_intake_consent_version is distinct from 'uu06-v1' then
    new.gmail_watch_history_id := null;
    new.gmail_watch_expires_at := null;
    new.gmail_watch_last_renewed_at := null;
    new.gmail_watch_last_error := null;
  end if;
  return new;
end
$$;

-- v4 extends the scheduler read contract with operational watch metadata.
-- v3 remains available for already-deployed workers during rolling deployment.
create or replace function public.pjsdas_claim_gmail_automation_bindings_v4(worker_token text)
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
  gmail_pending_message_ids text[],
  gmail_intake_consent_version text,
  gmail_watch_history_id text,
  gmail_watch_expires_at timestamptz,
  gmail_watch_last_renewed_at timestamptz,
  gmail_watch_last_error text
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
    c.gmail_pending_message_ids,
    c.gmail_intake_consent_version,
    c.gmail_watch_history_id,
    c.gmail_watch_expires_at,
    c.gmail_watch_last_renewed_at,
    c.gmail_watch_last_error
  from public.google_drive_connections c
  where c.gmail_automation_enabled = true
    and c.revoked_at is null
  order by c.updated_at asc;
end
$$;

revoke all on function public.pjsdas_claim_gmail_automation_bindings_v4(text)
  from public, authenticated;
grant execute on function public.pjsdas_claim_gmail_automation_bindings_v4(text)
  to anon;

create or replace function public.pjsdas_update_gmail_watch_state(
  worker_token text,
  target_user_id uuid,
  watch_history_id text default null,
  watch_expires_at timestamptz default null,
  renewed_at timestamptz default null,
  last_error text default null,
  set_watch boolean default false,
  clear_watch boolean default false,
  set_last_error boolean default false
)
returns void
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  safe_error text;
begin
  if worker_token is null or not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'pjsdas_gmail_automation_worker_token'
      and decrypted_secret = worker_token
  ) then
    raise exception 'Invalid PJSDAS automation worker token.' using errcode = '42501';
  end if;
  if set_watch and clear_watch then
    raise exception 'Conflicting Gmail watch update.' using errcode = '22023';
  end if;
  if set_watch and (
    watch_history_id is null or watch_history_id !~ '^[0-9]{1,32}$'
    or watch_expires_at is null or watch_expires_at <= clock_timestamp()
    or renewed_at is null
  ) then
    raise exception 'Invalid Gmail watch metadata.' using errcode = '22023';
  end if;
  safe_error := case
    when last_error in (
      'GMAIL_PUSH_UNAVAILABLE',
      'GMAIL_PUSH_FORBIDDEN',
      'GMAIL_PUSH_REGISTRATION_FAILED',
      'GMAIL_PUSH_RESPONSE_INVALID',
      'GOOGLE_AUTH_EXPIRED',
      'GOOGLE_DRIVE_UNAVAILABLE'
    ) then last_error
    else 'GMAIL_PUSH_REGISTRATION_FAILED'
  end;

  update public.google_drive_connections
  set
    gmail_watch_history_id = case
      when clear_watch then null
      when set_watch then watch_history_id
      else gmail_watch_history_id
    end,
    gmail_watch_expires_at = case
      when clear_watch then null
      when set_watch then watch_expires_at
      else gmail_watch_expires_at
    end,
    gmail_watch_last_renewed_at = case
      when clear_watch then null
      when set_watch then renewed_at
      else gmail_watch_last_renewed_at
    end,
    gmail_watch_last_error = case
      when clear_watch then null
      when set_last_error then case when last_error is null then null else safe_error end
      else gmail_watch_last_error
    end
  where user_id = target_user_id
    and gmail_automation_enabled = true
    and revoked_at is null
    and gmail_intake_consent_version = 'uu06-v1';
end
$$;

revoke all on function public.pjsdas_update_gmail_watch_state(
  text, uuid, text, timestamptz, timestamptz, text, boolean, boolean, boolean
) from public, authenticated;
grant execute on function public.pjsdas_update_gmail_watch_state(
  text, uuid, text, timestamptz, timestamptz, text, boolean, boolean, boolean
) to anon;

-- The authenticated Pub/Sub endpoint calls this with the existing server service-role
-- credential. It cannot read mail or mutate workspace truth. It only enqueues the
-- already-certified Gmail worker for exactly one eligible explicit-consent binding.
create or replace function public.pjsdas_enqueue_gmail_push_worker(
  target_email text,
  notified_history_id text
)
returns boolean
language plpgsql
security definer
set search_path = public, vault, net, pg_temp
as $$
declare
  candidate_ids uuid[];
  target_user_id uuid;
  backend_origin text;
  worker_token text;
begin
  if target_email is null or length(target_email) > 320
    or notified_history_id is null or notified_history_id !~ '^[0-9]{1,32}$' then
    return false;
  end if;

  select array_agg(c.user_id order by c.user_id)
  into candidate_ids
  from public.google_drive_connections c
  where lower(c.google_email) = lower(target_email)
    and c.gmail_automation_enabled = true
    and c.revoked_at is null
    and c.gmail_intake_consent_version = 'uu06-v1';

  if coalesce(cardinality(candidate_ids), 0) <> 1 then
    return false;
  end if;
  target_user_id := candidate_ids[1];

  select decrypted_secret into backend_origin
  from vault.decrypted_secrets
  where name = 'pjsdas_automation_backend_origin'
  limit 1;
  select decrypted_secret into worker_token
  from vault.decrypted_secrets
  where name = 'pjsdas_gmail_automation_worker_token'
  limit 1;

  if backend_origin is null or backend_origin !~ '^https://'
    or worker_token is null or length(worker_token) < 32 then
    raise exception 'PJSDAS Gmail push worker routing is not configured.' using errcode = '55000';
  end if;

  perform net.http_post(
    url := rtrim(backend_origin, '/') || '/api/automation-gmail?userId=' || target_user_id::text,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || worker_token
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  return true;
end
$$;

revoke all on function public.pjsdas_enqueue_gmail_push_worker(text, text)
  from public, anon, authenticated;
grant execute on function public.pjsdas_enqueue_gmail_push_worker(text, text)
  to service_role;
