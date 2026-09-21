-- UU06 source expansion is DISARMED for every existing binding.
-- No UPDATE enabling/granting any existing user; no scheduler/cost/credential change.
alter table public.google_drive_connections
  add column if not exists gmail_intake_consent_version text default null
  check (gmail_intake_consent_version is null or gmail_intake_consent_version = 'uu06-v1');

comment on column public.google_drive_connections.gmail_intake_consent_version is
  'Explicit first-party consent to UU06: 90-day archive-inclusive initial backfill and bounded recruiting location/meeting-link extraction. NULL preserves legacy 7-day INBOX behavior. Never inferred from OAuth scope, existing enabled state, cursor absence or deployment.';

-- Existing ownership/RLS governs the first-party settings update. Revoke the
-- expanded consent on disable, account/credential replacement, scope removal,
-- account revocation or terminal Google authorization failure.
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
  -- A revoked expanded grant must not leave archive message IDs/page tokens
  -- for the legacy worker. Committed history and recorded evidence survive.
  if tg_op = 'UPDATE' and old.gmail_intake_consent_version = 'uu06-v1'
    and new.gmail_intake_consent_version is distinct from 'uu06-v1' then
    new.gmail_sync_mode := null;
    new.gmail_page_token := null;
    new.gmail_pending_history_id := null;
    new.gmail_pending_message_ids := '{}'::text[];
  end if;
  return new;
end
$$;
revoke all on function public.pjsdas_guard_gmail_intake_consent() from public, anon, authenticated;
create trigger pjsdas_guard_gmail_intake_consent
before insert or update on public.google_drive_connections
for each row execute function public.pjsdas_guard_gmail_intake_consent();

create or replace function public.pjsdas_claim_gmail_automation_bindings_v3(worker_token text)
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
  gmail_intake_consent_version text
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
    c.gmail_intake_consent_version
  from public.google_drive_connections c
  where c.gmail_automation_enabled = true
    and c.revoked_at is null
  order by c.updated_at asc;
end
$$;

revoke all on function public.pjsdas_claim_gmail_automation_bindings_v3(text) from public, authenticated;
grant execute on function public.pjsdas_claim_gmail_automation_bindings_v3(text) to anon;

