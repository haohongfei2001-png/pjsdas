-- Google refresh lifecycle, no schedules, credentials, opt-in or OAuth settings.
-- Credential mutation is restricted to the existing trusted backend service_role.
-- The gateway validates source-worker authority before calling this RPC. No worker
-- token alone can write credentials, no new table grant is added, and missing
-- existing service-role SELECT/UPDATE privileges fail closed under SECURITY INVOKER.
-- Remove any previously provisioned same-signature anonymous/definer variant.
drop function if exists public.pjsdas_update_google_refresh_state(text,uuid,text,text,boolean,uuid);
create function public.pjsdas_update_google_refresh_state(
  source_kind text, target_user_id uuid, expected_subject text, expected_ciphertext text,
  next_ciphertext text default null, reconnect_required boolean default false, execution_token uuid default null
)
returns boolean language plpgsql security invoker
set search_path = public, pg_temp as $$
declare
  gmail_worker boolean;
  discovery_worker boolean;
  changed integer;
  binding public.google_drive_connections%rowtype;
  owned_lease public.gmail_automation_execution_state%rowtype;
  rotated_at timestamptz;
begin
  if current_user <> 'service_role' then
    raise exception 'Trusted backend authorization required.' using errcode='42501';
  end if;
  if source_kind is null or source_kind not in ('gmail','discovery') then
    raise exception 'Invalid refresh source.' using errcode='22023';
  end if;
  gmail_worker = source_kind='gmail';
  discovery_worker = source_kind='discovery';
  if expected_subject is null or expected_subject='' or expected_ciphertext is null or expected_ciphertext='' or reconnect_required is null
    or (next_ciphertext is not null and (next_ciphertext !~ '^v1\.' or length(next_ciphertext)>16384))
    or (next_ciphertext is null and not reconnect_required)
    or (next_ciphertext is not null and reconnect_required) then
    raise exception 'Invalid refresh state transition.' using errcode='22023';
  end if;
  select * into binding from public.google_drive_connections where user_id=target_user_id for update;
  if not found or binding.revoked_at is not null or binding.google_subject is distinct from expected_subject or binding.refresh_token_ciphertext is distinct from expected_ciphertext
    or not ((gmail_worker and binding.gmail_automation_enabled) or (discovery_worker and binding.discovery_automation_enabled)) then return false; end if;
  if coalesce(binding.gmail_last_error,'') ~ '^GOOGLE_AUTH_EXPIRED($|[:[:space:]\[])'
    or coalesce(binding.discovery_last_error,'') ~ '^GOOGLE_AUTH_EXPIRED($|[:[:space:]\[])' then return false; end if;
  if execution_token is not null then
    select * into owned_lease from public.gmail_automation_execution_state where user_id=target_user_id for update;
    if not gmail_worker or owned_lease.lease_token is distinct from execution_token
      or owned_lease.lease_expires_at is null or owned_lease.lease_expires_at<=clock_timestamp()
      or owned_lease.binding_updated_at is distinct from binding.updated_at then return false; end if;
  end if;
  rotated_at=clock_timestamp();
  update public.google_drive_connections c set
    refresh_token_ciphertext=coalesce(next_ciphertext,c.refresh_token_ciphertext),
    gmail_last_error=case when reconnect_required then 'GOOGLE_AUTH_EXPIRED: Reconnect Google to resume.' else c.gmail_last_error end,
    discovery_last_error=case when reconnect_required then 'GOOGLE_AUTH_EXPIRED: Reconnect Google to resume.' else c.discovery_last_error end,
    gmail_last_checked_at=case when reconnect_required and gmail_worker then clock_timestamp() else c.gmail_last_checked_at end,
    discovery_last_checked_at=case when reconnect_required and discovery_worker then clock_timestamp() else c.discovery_last_checked_at end,
    updated_at=rotated_at
  where c.user_id=target_user_id and c.revoked_at is null
    and c.google_subject=expected_subject and c.refresh_token_ciphertext=expected_ciphertext
    and ((gmail_worker and c.gmail_automation_enabled) or (discovery_worker and c.discovery_automation_enabled));
  get diagnostics changed=row_count;
  -- The existing trigger invalidates every other execution. Restore only the
  -- proven owner after its own rotation, with the same expiry (no lease extension).
  if changed=1 and next_ciphertext is not null and execution_token is not null then
    update public.gmail_automation_execution_state set lease_token=owned_lease.lease_token,
      lease_expires_at=owned_lease.lease_expires_at,binding_updated_at=rotated_at where user_id=target_user_id;
  end if;
  return changed=1;
end $$;
revoke all on function public.pjsdas_update_google_refresh_state(text,uuid,text,text,text,boolean,uuid) from public,anon,authenticated;
grant execute on function public.pjsdas_update_google_refresh_state(text,uuid,text,text,text,boolean,uuid) to service_role;

-- App intake consent is distinct from renewable provider credentials. Retain it
-- on same-subject rotation/reconnect and invalid_grant, which is gated above.
-- Explicit disable, revoke, missing Gmail scope, subject change or consent removal
-- still clears expanded-consent continuation exactly as before.
create or replace function public.pjsdas_guard_gmail_intake_consent()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.revoked_at is not null
    or not coalesce(new.gmail_automation_enabled, false)
    or not ('https://www.googleapis.com/auth/gmail.readonly' = any(coalesce(new.granted_scopes, '{}'::text[])))
    or (tg_op = 'UPDATE' and new.google_subject is distinct from old.google_subject)
    or coalesce(new.gmail_last_error, '') ~ '^(GOOGLE_GMAIL_SCOPE_MISSING|GOOGLE_ACCOUNT_MISMATCH)($|[:[:space:]\[])'
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

-- A different Google subject is a different mailbox. Reset only that case,
-- atomically with the binding change. Same-subject reconnect/rotation preserves
-- history, pending pages and the last durable success. Existing AFTER trigger
-- invalidates leases; it remains unchanged.
create function public.pjsdas_reset_changed_google_subject()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.google_subject is distinct from old.google_subject then
    new.gmail_history_id=null;
    new.gmail_sync_mode=null;
    new.gmail_page_token=null;
    new.gmail_pending_history_id=null;
    new.gmail_pending_message_ids='{}'::text[];
    new.gmail_last_checked_at=null;
    new.gmail_last_success_at=null;
    new.gmail_last_error=null;
    new.gmail_watch_history_id=null;
    new.gmail_watch_expires_at=null;
    new.gmail_watch_last_renewed_at=null;
    new.gmail_watch_last_error=null;
    new.gmail_automation_enabled=false;
    new.gmail_intake_consent_version=null;
  end if;
  return new;
end $$;
revoke all on function public.pjsdas_reset_changed_google_subject() from public,anon,authenticated;
create trigger pjsdas_reset_changed_google_subject before update of google_subject
on public.google_drive_connections for each row execute function public.pjsdas_reset_changed_google_subject();

-- Definitive revocation pauses attempts until explicit relink clears the marker.
create or replace function public.pjsdas_claim_gmail_automation_bindings_v5(worker_token text)
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
  gmail_watch_last_error text,
  gmail_reconciliation_requested_at timestamptz,
  gmail_reconciliation_state jsonb
)
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
begin
  if worker_token is null or not exists (
    select 1
    from vault.decrypted_secrets
    where name='pjsdas_gmail_automation_worker_token'
      and decrypted_secret=worker_token
  ) then
    raise exception 'Invalid PJSDAS automation worker token.' using errcode='42501';
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
    c.gmail_watch_last_error,
    s.gmail_reconciliation_requested_at,
    s.gmail_reconciliation_state
  from public.google_drive_connections c
  left join public.gmail_automation_execution_state s using(user_id)
  where c.gmail_automation_enabled=true
    and c.revoked_at is null
    and coalesce(c.gmail_last_error, '') !~ '^GOOGLE_AUTH_EXPIRED($|[:[:space:]\[])'
  order by c.updated_at asc;
end
$$;

revoke all on function public.pjsdas_claim_gmail_automation_bindings_v5(text)
  from public, authenticated;
grant execute on function public.pjsdas_claim_gmail_automation_bindings_v5(text)
  to anon;

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
    and coalesce(connection.discovery_last_error, '') !~ '^GOOGLE_AUTH_EXPIRED($|[:[:space:]\[])'
  order by connection.updated_at asc;
$$;


-- Same-subject credential rotation/reconnect retains independent catch-up.
create or replace function public.pjsdas_invalidate_gmail_execution()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  execution_invalidated boolean;
  reconciliation_invalidated boolean;
begin
  execution_invalidated := row(
    new.gmail_automation_enabled,
    new.revoked_at,
    new.google_subject,
    new.refresh_token_ciphertext,
    array(select distinct scope from unnest(new.granted_scopes) scope order by scope),
    new.gmail_intake_consent_version,
    new.gmail_history_id,
    new.gmail_sync_mode,
    new.gmail_page_token,
    new.gmail_pending_history_id,
    new.gmail_pending_message_ids
  ) is distinct from row(
    old.gmail_automation_enabled,
    old.revoked_at,
    old.google_subject,
    old.refresh_token_ciphertext,
    array(select distinct scope from unnest(old.granted_scopes) scope order by scope),
    old.gmail_intake_consent_version,
    old.gmail_history_id,
    old.gmail_sync_mode,
    old.gmail_page_token,
    old.gmail_pending_history_id,
    old.gmail_pending_message_ids
  );

  reconciliation_invalidated := row(
    new.revoked_at,
    new.google_subject,
    array(select distinct scope from unnest(new.granted_scopes) scope order by scope),
    new.gmail_intake_consent_version
  ) is distinct from row(
    old.revoked_at,
    old.google_subject,
    array(select distinct scope from unnest(old.granted_scopes) scope order by scope),
    old.gmail_intake_consent_version
  );

  if execution_invalidated then
    update public.gmail_automation_execution_state
    set
      lease_token=null,
      lease_expires_at=null,
      gmail_reconciliation_requested_at=case
        when reconciliation_invalidated then null
        else gmail_reconciliation_requested_at
      end,
      gmail_reconciliation_state=case
        when reconciliation_invalidated then null
        else gmail_reconciliation_state
      end
    where user_id=new.user_id;
  end if;
  return new;
end
$$;

-- Preserve bounded diagnostics for transient/configuration failures; these must
-- never be presented as revoked user consent. Existing finalization is unchanged.
create or replace function public.pjsdas_finish_gmail_execution(
  worker_token text,
  target_user_id uuid,
  execution_token uuid,
  state_patch jsonb,
  metrics jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  binding public.google_drive_connections%rowtype;
  lease public.gmail_automation_execution_state%rowtype;
  complete boolean;
  run_mode text;
  error_code text;
  provider_operation text;
  provider_status integer;
  provider_reason text;
  failure_scope text;
  record_gap_count integer;
  duration_ms bigint;
  safe_metrics jsonb;
begin
  if worker_token is null or not exists(
    select 1
    from vault.decrypted_secrets
    where name='pjsdas_gmail_automation_worker_token'
      and decrypted_secret=worker_token
  ) then
    raise exception 'Invalid PJSDAS automation worker token.' using errcode='42501';
  end if;
  if execution_token is null then return false; end if;

  select * into binding
  from public.google_drive_connections
  where user_id=target_user_id
  for update;

  select * into lease
  from public.gmail_automation_execution_state
  where user_id=target_user_id
  for update;

  if lease.lease_token is distinct from execution_token
    or lease.lease_expires_at is null
    or lease.lease_expires_at<=clock_timestamp()
    or lease.binding_updated_at is distinct from binding.updated_at
    or not binding.gmail_automation_enabled
    or binding.revoked_at is not null
  then
    return false;
  end if;

  complete := metrics->>'status'='completed';
  run_mode := case
    when metrics->>'mode' in ('history','initial_backfill','history_recovery')
      then metrics->>'mode'
    else 'unknown'
  end;

  error_code := case
    when metrics->>'errorCode' in (
      'BUDGET_EXHAUSTED',
      'LEASE_LOST',
      'GOOGLE_AUTH_EXPIRED',
      'GOOGLE_AUTH_CONFIG_INVALID',
      'GOOGLE_ACCESS_REJECTED',
      'GOOGLE_DRIVE_UNAVAILABLE',
      'GOOGLE_CONNECTION_CHANGED',
      'GOOGLE_REFRESH_STORAGE_REQUIRED',
      'GOOGLE_GMAIL_API_DISABLED',
      'GOOGLE_GMAIL_FORBIDDEN',
      'GOOGLE_GMAIL_SCOPE_MISSING',
      'GOOGLE_ACCOUNT_MISMATCH',
      'GOOGLE_REFRESH_FAILED',
      'GMAIL_REQUEST_FAILED',
      'GMAIL_RESPONSE_INVALID',
      'GMAIL_UNAVAILABLE',
      'WORKSPACE_CONFLICT',
      'AUTH_UNAVAILABLE'
    ) then metrics->>'errorCode'
    else 'AUTOMATION_FAILED'
  end;

  provider_operation := case
    when metrics->>'providerOperation' in ('profile','history','list','message_fetch','unknown')
      then metrics->>'providerOperation'
    else null
  end;

  provider_status := case
    when coalesce(metrics->>'providerStatus','') ~ '^[1-5][0-9][0-9]$'
      then (metrics->>'providerStatus')::integer
    else null
  end;

  provider_reason := case
    when coalesce(metrics->>'providerReason','') ~ '^[A-Za-z0-9_.-]{1,80}$'
      then metrics->>'providerReason'
    else null
  end;

  failure_scope := case
    when metrics->>'failureScope' in ('run','record')
      then metrics->>'failureScope'
    else null
  end;

  record_gap_count := case
    when coalesce(metrics->>'recordGapCount','') ~ '^[0-9]{1,3}$'
      then least(100,greatest(0,(metrics->>'recordGapCount')::integer))
    else 0
  end;

  duration_ms := greatest(
    0,
    (extract(epoch from(clock_timestamp()-lease.started_at))*1000)::bigint
  );

  safe_metrics := jsonb_build_object(
    'status', case when complete then 'completed' else 'error' end,
    'mode', run_mode,
    'durationMs', duration_ms,
    'errorCode', case when complete then null else error_code end,
    'providerOperation', case when complete then null else provider_operation end,
    'providerStatus', case when complete then null else provider_status end,
    'providerReason', case when complete then null else provider_reason end,
    'failureScope', case when complete then null else failure_scope end,
    'recordGapCount', record_gap_count,
    'receivedCount', least(100,greatest(0,coalesce((metrics->>'receivedCount')::integer,0))),
    'accountedCount', least(100,greatest(0,coalesce((metrics->>'accountedCount')::integer,0))),
    'unresolvedCount', least(100,greatest(0,coalesce((metrics->>'unresolvedCount')::integer,0)))
  );

  if complete and run_mode='history' then
    safe_metrics := safe_metrics || jsonb_build_object(
      'historyLag',
      jsonb_build_object(
        'count',least(100,greatest(0,coalesce((metrics#>>'{historyLag,count}')::integer,0))),
        'sumMs',least(3153600000000,greatest(0,coalesce((metrics#>>'{historyLag,sumMs}')::bigint,0))),
        'maxMs',least(31536000000,greatest(0,coalesce((metrics#>>'{historyLag,maxMs}')::bigint,0))),
        'under2m',least(100,greatest(0,coalesce((metrics#>>'{historyLag,under2m}')::integer,0))),
        'under15m',least(100,greatest(0,coalesce((metrics#>>'{historyLag,under15m}')::integer,0))),
        'over15m',least(100,greatest(0,coalesce((metrics#>>'{historyLag,over15m}')::integer,0)))
      )
    );
  end if;

  if complete
    and state_patch ? 'continuation'
    and jsonb_typeof(state_patch->'continuation')='object'
    and state_patch#>>'{continuation,mode}' not in ('history','fallback')
  then
    raise exception 'Invalid continuation.' using errcode='22023';
  end if;

  update public.google_drive_connections
  set
    gmail_history_id=case
      when complete and state_patch ? 'historyId'
        then state_patch->>'historyId'
      else gmail_history_id
    end,
    gmail_sync_mode=case
      when complete and state_patch ? 'continuation'
        then state_patch#>>'{continuation,mode}'
      else gmail_sync_mode
    end,
    gmail_page_token=case
      when complete and state_patch ? 'continuation'
        then state_patch#>>'{continuation,pageToken}'
      else gmail_page_token
    end,
    gmail_pending_history_id=case
      when complete and state_patch ? 'continuation'
        then state_patch#>>'{continuation,pendingHistoryId}'
      else gmail_pending_history_id
    end,
    gmail_pending_message_ids=case
      when complete and state_patch ? 'continuation'
        then coalesce(
          array(select jsonb_array_elements_text(state_patch#>'{continuation,pendingMessageIds}')),
          '{}'::text[]
        )
      else gmail_pending_message_ids
    end,
    gmail_last_checked_at=lease.started_at,
    gmail_last_success_at=case
      when complete and state_patch ? 'successAt'
        then clock_timestamp()
      else gmail_last_success_at
    end,
    gmail_last_error=case
      when complete then null
      else left(
        error_code
        || coalesce(' [' || provider_operation || ']', '')
        || coalesce(' HTTP ' || provider_status::text, '')
        || coalesce(' ' || provider_reason, ''),
        240
      )
    end,
    updated_at=clock_timestamp()
  where user_id=target_user_id;

  update public.gmail_automation_execution_state
  set
    lease_token=null,
    lease_expires_at=null,
    completed_at=clock_timestamp(),
    completed_runs=completed_runs+case when complete then 1 else 0 end,
    failed_runs=failed_runs+case when complete then 0 else 1 end,
    last_metrics=safe_metrics
  where user_id=target_user_id;

  return true;
end
$$;
create or replace function public.pjsdas_finish_gmail_reconciliation(
  worker_token text,
  target_user_id uuid,
  execution_token uuid,
  state_patch jsonb,
  metrics jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  binding public.google_drive_connections%rowtype;
  lease public.gmail_automation_execution_state%rowtype;
  complete boolean;
  cycle_complete boolean;
  error_code text;
  provider_operation text;
  provider_status integer;
  provider_reason text;
  failure_scope text;
  record_gap_count integer;
  duration_ms bigint;
  safe_metrics jsonb;
  next_state jsonb;
begin
  if worker_token is null or not exists(
    select 1
    from vault.decrypted_secrets
    where name='pjsdas_gmail_automation_worker_token'
      and decrypted_secret=worker_token
  ) then
    raise exception 'Invalid PJSDAS automation worker token.' using errcode='42501';
  end if;
  if execution_token is null then return false; end if;

  select * into binding
  from public.google_drive_connections
  where user_id=target_user_id
  for update;

  select * into lease
  from public.gmail_automation_execution_state
  where user_id=target_user_id
  for update;

  if lease.lease_token is distinct from execution_token
    or lease.lease_expires_at is null
    or lease.lease_expires_at<=clock_timestamp()
    or lease.binding_updated_at is distinct from binding.updated_at
    or not binding.gmail_automation_enabled
    or binding.revoked_at is not null
  then
    return false;
  end if;

  complete := metrics->>'status'='completed';
  cycle_complete := complete
    and coalesce((state_patch->>'cycleComplete')::boolean,false);

  error_code := case
    when metrics->>'errorCode' in (
      'BUDGET_EXHAUSTED',
      'LEASE_LOST',
      'GOOGLE_AUTH_EXPIRED',
      'GOOGLE_AUTH_CONFIG_INVALID',
      'GOOGLE_ACCESS_REJECTED',
      'GOOGLE_DRIVE_UNAVAILABLE',
      'GOOGLE_CONNECTION_CHANGED',
      'GOOGLE_REFRESH_STORAGE_REQUIRED',
      'GOOGLE_GMAIL_API_DISABLED',
      'GOOGLE_GMAIL_FORBIDDEN',
      'GOOGLE_GMAIL_SCOPE_MISSING',
      'GOOGLE_ACCOUNT_MISMATCH',
      'GOOGLE_REFRESH_FAILED',
      'GMAIL_REQUEST_FAILED',
      'GMAIL_RESPONSE_INVALID',
      'GMAIL_UNAVAILABLE',
      'GMAIL_RECONCILIATION_LIMIT_EXCEEDED',
      'GMAIL_RECONCILIATION_STATE_INVALID',
      'GMAIL_RECONCILIATION_CONSENT_REQUIRED',
      'GMAIL_RECONCILIATION_NOT_REQUESTED',
      'WORKSPACE_CONFLICT',
      'AUTH_UNAVAILABLE'
    ) then metrics->>'errorCode'
    else 'AUTOMATION_FAILED'
  end;

  provider_operation := case
    when metrics->>'providerOperation' in ('profile','history','list','message_fetch','unknown')
      then metrics->>'providerOperation'
    else null
  end;
  provider_status := case
    when coalesce(metrics->>'providerStatus','') ~ '^[1-5][0-9][0-9]$'
      then (metrics->>'providerStatus')::integer
    else null
  end;
  provider_reason := case
    when coalesce(metrics->>'providerReason','') ~ '^[A-Za-z0-9_.-]{1,80}$'
      then metrics->>'providerReason'
    else null
  end;
  failure_scope := case
    when metrics->>'failureScope' in ('run','record')
      then metrics->>'failureScope'
    else null
  end;
  record_gap_count := case
    when coalesce(metrics->>'recordGapCount','') ~ '^[0-9]{1,3}$'
      then least(100,greatest(0,(metrics->>'recordGapCount')::integer))
    else 0
  end;
  duration_ms := greatest(
    0,
    (extract(epoch from(clock_timestamp()-lease.started_at))*1000)::bigint
  );

  safe_metrics := jsonb_build_object(
    'status',case when complete then 'completed' else 'error' end,
    'mode','reconciliation',
    'durationMs',duration_ms,
    'errorCode',case when complete then null else error_code end,
    'providerOperation',case when complete then null else provider_operation end,
    'providerStatus',case when complete then null else provider_status end,
    'providerReason',case when complete then null else provider_reason end,
    'failureScope',case when complete then null else failure_scope end,
    'recordGapCount',record_gap_count,
    'receivedCount',least(20,greatest(0,coalesce((metrics->>'receivedCount')::integer,0))),
    'accountedCount',least(20,greatest(0,coalesce((metrics->>'accountedCount')::integer,0))),
    'unresolvedCount',least(20,greatest(0,coalesce((metrics->>'unresolvedCount')::integer,0)))
  );

  if complete and state_patch ? 'state' then
    next_state := state_patch->'state';
    if next_state <> 'null'::jsonb then
      if jsonb_typeof(next_state) <> 'object'
        or next_state->>'version' <> '1'
        or coalesce(next_state->>'cycleStartedAt','') = ''
        or jsonb_typeof(next_state->'pendingMessageIds') <> 'array'
        or jsonb_array_length(next_state->'pendingMessageIds') > 100
        or jsonb_typeof(next_state->'aggregate') <> 'object'
        or coalesce((next_state#>>'{aggregate,scannedCount}')::integer,-1) < 0
        or coalesce((next_state#>>'{aggregate,scannedCount}')::integer,5001) > 5000
        or jsonb_typeof(next_state#>'{aggregate,gmailOpportunityIds}') <> 'array'
        or jsonb_array_length(next_state#>'{aggregate,gmailOpportunityIds}') > 5000
        or length(coalesce(next_state->>'pageToken','')) > 4096
      then
        raise exception 'Invalid Gmail reconciliation continuation.' using errcode='22023';
      end if;
      perform (next_state->>'cycleStartedAt')::timestamptz;
    elsif not cycle_complete then
      raise exception 'Incomplete Gmail reconciliation cannot clear continuation state.' using errcode='22023';
    end if;
  end if;

  if cycle_complete
    and (not (state_patch ? 'state') or state_patch->'state' <> 'null'::jsonb)
  then
    raise exception 'Completed Gmail reconciliation must clear continuation state.' using errcode='22023';
  end if;

  update public.gmail_automation_execution_state
  set
    lease_token=null,
    lease_expires_at=null,
    gmail_reconciliation_state=case
      when complete and state_patch ? 'state' then nullif(state_patch->'state','null'::jsonb)
      else gmail_reconciliation_state
    end,
    gmail_reconciliation_requested_at=case
      when cycle_complete then null
      else gmail_reconciliation_requested_at
    end,
    gmail_reconciliation_completed_at=case
      when cycle_complete then clock_timestamp()
      else gmail_reconciliation_completed_at
    end,
    gmail_reconciliation_completed_cycles=gmail_reconciliation_completed_cycles
      + case when cycle_complete then 1 else 0 end,
    gmail_reconciliation_failed_runs=gmail_reconciliation_failed_runs
      + case when complete then 0 else 1 end,
    gmail_reconciliation_last_metrics=safe_metrics
  where user_id=target_user_id;

  return true;
end
$$;

-- Generation-fenced wrappers for non-controlled legacy, discovery and watch
-- finalizers. Lock order matches controlled execution. Delegate only to existing
-- contracts after checking the exact corresponding worker authority and binding.
create function public.pjsdas_update_google_automation_state(
 worker_token text,target_user_id uuid,expected_ciphertext text,state_operation text,state_patch jsonb
) returns boolean language plpgsql security definer set search_path=public,vault,pg_temp as $$
declare
 binding public.google_drive_connections%rowtype;
 token_name text;
begin
 token_name=case state_operation
   when 'pjsdas_update_discovery_automation_state' then 'pjsdas_discovery_automation_worker_token'
   when 'pjsdas_update_gmail_automation_state_v2' then 'pjsdas_gmail_automation_worker_token'
   when 'pjsdas_update_gmail_watch_state' then 'pjsdas_gmail_automation_worker_token'
   else null end;
 if token_name is null or worker_token is null or not exists(select 1 from vault.decrypted_secrets where name=token_name and decrypted_secret=worker_token) then
   raise exception 'Invalid automation worker authorization.' using errcode='42501';
 end if;
 select * into binding from public.google_drive_connections where user_id=target_user_id for update;
 if not found or binding.revoked_at is not null or expected_ciphertext is null
   or binding.refresh_token_ciphertext is distinct from expected_ciphertext
   or (token_name='pjsdas_gmail_automation_worker_token' and not binding.gmail_automation_enabled)
   or (token_name='pjsdas_discovery_automation_worker_token' and not binding.discovery_automation_enabled) then return false; end if;
 if coalesce(binding.gmail_last_error,'') ~ '^GOOGLE_AUTH_EXPIRED($|[:[:space:]\[])'
   or coalesce(binding.discovery_last_error,'') ~ '^GOOGLE_AUTH_EXPIRED($|[:[:space:]\[])' then return false; end if;
 if state_operation='pjsdas_update_discovery_automation_state' then
   perform public.pjsdas_update_discovery_automation_state(worker_token,target_user_id,
     (state_patch->>'checked_at')::timestamptz,(state_patch->>'success_at')::timestamptz,
     state_patch->>'last_error',coalesce((state_patch->>'set_last_error')::boolean,false));
 elsif state_operation='pjsdas_update_gmail_watch_state' then
   perform public.pjsdas_update_gmail_watch_state(worker_token,target_user_id,
     state_patch->>'watch_history_id',(state_patch->>'watch_expires_at')::timestamptz,
     (state_patch->>'renewed_at')::timestamptz,state_patch->>'last_error',
     coalesce((state_patch->>'set_watch')::boolean,false),coalesce((state_patch->>'clear_watch')::boolean,false),
     coalesce((state_patch->>'set_last_error')::boolean,false));
 else
   perform public.pjsdas_update_gmail_automation_state_v2(worker_token,target_user_id,
     state_patch->>'next_history_id',state_patch->>'next_sync_mode',state_patch->>'next_page_token',state_patch->>'next_pending_history_id',
     case when jsonb_typeof(state_patch->'next_pending_message_ids')='array' then array(select jsonb_array_elements_text(state_patch->'next_pending_message_ids')) else null end,
     (state_patch->>'checked_at')::timestamptz,(state_patch->>'success_at')::timestamptz,state_patch->>'last_error',
     coalesce((state_patch->>'set_history_id')::boolean,false),coalesce((state_patch->>'set_continuation')::boolean,false),
     coalesce((state_patch->>'clear_continuation')::boolean,false),coalesce((state_patch->>'set_last_error')::boolean,false));
 end if;
 return true;
end $$;
revoke all on function public.pjsdas_update_google_automation_state(text,uuid,text,text,jsonb) from public,authenticated;
grant execute on function public.pjsdas_update_google_automation_state(text,uuid,text,text,jsonb) to anon;
