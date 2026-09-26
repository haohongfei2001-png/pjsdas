-- TodayAction reliability closure R01 follow-up.
-- Make Gmail reconciliation resumable across bounded worker executions.
-- This is additive: primary Gmail history cursor/success/error state is untouched.

alter table public.gmail_automation_execution_state
  add column if not exists gmail_reconciliation_requested_at timestamptz,
  add column if not exists gmail_reconciliation_state jsonb,
  add column if not exists gmail_reconciliation_completed_at timestamptz,
  add column if not exists gmail_reconciliation_completed_cycles bigint not null default 0,
  add column if not exists gmail_reconciliation_failed_runs bigint not null default 0,
  add column if not exists gmail_reconciliation_last_metrics jsonb not null default '{}'::jsonb;

comment on column public.gmail_automation_execution_state.gmail_reconciliation_state is
  'Private worker continuation for the independent Gmail reconciliation cycle. May contain bounded Gmail message IDs/page tokens; cleared when the cycle completes or consent/credential identity changes.';

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
  order by c.updated_at asc;
end
$$;

revoke all on function public.pjsdas_claim_gmail_automation_bindings_v5(text)
  from public, authenticated;
grant execute on function public.pjsdas_claim_gmail_automation_bindings_v5(text)
  to anon;

create or replace function public.pjsdas_begin_gmail_execution(
  worker_token text,
  target_user_id uuid,
  execution_token uuid,
  ttl_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  binding public.google_drive_connections%rowtype;
  previous public.gmail_automation_execution_state%rowtype;
  result jsonb;
begin
  if worker_token is null or not exists(
    select 1 from vault.decrypted_secrets
    where name='pjsdas_gmail_automation_worker_token'
      and decrypted_secret=worker_token
  ) then
    raise exception 'Invalid PJSDAS automation worker token.' using errcode='42501';
  end if;
  if execution_token is null or ttl_seconds is null or ttl_seconds < 30 or ttl_seconds > 120 then
    raise exception 'Invalid execution lease.' using errcode='22023';
  end if;

  select * into binding
  from public.google_drive_connections
  where user_id=target_user_id
  for update;

  if not found or not binding.gmail_automation_enabled or binding.revoked_at is not null then
    return null;
  end if;

  insert into public.gmail_automation_execution_state(user_id)
  values(target_user_id)
  on conflict do nothing;

  select * into previous
  from public.gmail_automation_execution_state
  where user_id=target_user_id
  for update;

  if previous.lease_token is not null and previous.lease_expires_at > clock_timestamp() then
    update public.gmail_automation_execution_state
    set coalesced_runs=coalesced_runs+1
    where user_id=target_user_id;
    return null;
  end if;

  update public.gmail_automation_execution_state
  set
    lease_token=execution_token,
    lease_expires_at=clock_timestamp()+make_interval(secs=>ttl_seconds),
    binding_updated_at=binding.updated_at,
    started_at=clock_timestamp()
  where user_id=target_user_id;

  select to_jsonb(b) into result
  from public.pjsdas_claim_gmail_automation_bindings_v5(worker_token) b
  where b.user_id=target_user_id;

  return result;
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

revoke all on function public.pjsdas_finish_gmail_reconciliation(text,uuid,uuid,jsonb,jsonb)
  from public, authenticated;
grant execute on function public.pjsdas_finish_gmail_reconciliation(text,uuid,uuid,jsonb,jsonb)
  to anon;

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
    new.granted_scopes,
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
    old.granted_scopes,
    old.gmail_intake_consent_version,
    old.gmail_history_id,
    old.gmail_sync_mode,
    old.gmail_page_token,
    old.gmail_pending_history_id,
    old.gmail_pending_message_ids
  );

  reconciliation_invalidated := row(
    new.gmail_automation_enabled,
    new.revoked_at,
    new.google_subject,
    new.refresh_token_ciphertext,
    new.granted_scopes,
    new.gmail_intake_consent_version
  ) is distinct from row(
    old.gmail_automation_enabled,
    old.revoked_at,
    old.google_subject,
    old.refresh_token_ciphertext,
    old.granted_scopes,
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

do $migration$
declare
  primary_job cron.job%rowtype;
  morning_job cron.job%rowtype;
  evening_job cron.job%rowtype;
  continuation_job cron.job%rowtype;
  reconcile_command text;
  request_prefix text;
  start_command text;
  continuation_count integer;
begin
  select * into strict primary_job
  from cron.job
  where jobname='pjsdas-gmail-automation-hourly';

  if primary_job.schedule <> '*/10 * * * *' then
    raise exception 'Unexpected primary Gmail cadence; refusing reconciliation continuation migration.';
  end if;

  reconcile_command := replace(
    primary_job.command,
    '/api/automation-gmail',
    '/api/automation-gmail?mode=reconcile'
  );
  if reconcile_command=primary_job.command then
    raise exception 'Existing Gmail scheduler command does not contain the expected route.';
  end if;

  request_prefix := $request$
  insert into public.gmail_automation_execution_state(
    user_id,
    gmail_reconciliation_requested_at
  )
  select c.user_id, clock_timestamp()
  from public.google_drive_connections c
  where c.gmail_automation_enabled=true
    and c.revoked_at is null
    and c.gmail_intake_consent_version='uu06-v1'
  on conflict(user_id) do update
    set gmail_reconciliation_requested_at=excluded.gmail_reconciliation_requested_at;
  $request$;

  start_command := request_prefix || E'\n' || reconcile_command;

  select * into strict morning_job
  from cron.job
  where jobname='todayaction-gmail-reconciliation-0830';
  select * into strict evening_job
  from cron.job
  where jobname='todayaction-gmail-reconciliation-1730';

  perform cron.alter_job(
    morning_job.jobid,
    schedule := '30 0 * * *',
    command := start_command
  );
  perform cron.alter_job(
    evening_job.jobid,
    schedule := '30 9 * * *',
    command := start_command
  );

  select count(*) into continuation_count
  from cron.job
  where jobname='todayaction-gmail-reconciliation-continuation';

  if continuation_count > 1 then
    raise exception 'Duplicate reconciliation continuation jobs exist.';
  elsif continuation_count = 0 then
    perform cron.schedule(
      'todayaction-gmail-reconciliation-continuation',
      '5,15,25,35,45,55 * * * *',
      reconcile_command
    );
  else
    select * into strict continuation_job
    from cron.job
    where jobname='todayaction-gmail-reconciliation-continuation';
    perform cron.alter_job(
      continuation_job.jobid,
      schedule := '5,15,25,35,45,55 * * * *',
      command := reconcile_command
    );
  end if;
end
$migration$;
