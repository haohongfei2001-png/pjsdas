-- Content-free bounded diagnostics only. Existing function contracts and privileges are unchanged.

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

  -- Diagnostics contain only closed phase labels and bounded integer counters.
  -- Missing/invalid diagnostics preserve the previous caller contract exactly.
  if jsonb_typeof(metrics->'diagnostics') = 'object'
    and metrics#>'{diagnostics,version}' = '1'::jsonb
  then
    safe_metrics := safe_metrics || jsonb_build_object('diagnostics',
      jsonb_strip_nulls(jsonb_build_object(
        'version', 1,
        'phase', case when metrics#>>'{diagnostics,phase}' in ('claim','token_refresh','workspace_read','gmail_list','gmail_fetch','message_parse','semantic_apply','lease_assert','workspace_commit','checkpoint','complete')
          then metrics#>>'{diagnostics,phase}' else null end,
        'processedCount', case
          when jsonb_typeof(metrics#>'{diagnostics,processedCount}') = 'number'
            and coalesce(metrics#>>'{diagnostics,processedCount}', '') ~ '^[0-9]{1,3}$'
          then least(100, (metrics#>>'{diagnostics,processedCount}')::integer) else null end,
        'durationsMs', jsonb_strip_nulls(jsonb_build_object(
          'claim', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,claim}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,claim}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,claim}')::integer) else null end,
          'token_refresh', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,token_refresh}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,token_refresh}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,token_refresh}')::integer) else null end,
          'workspace_read', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,workspace_read}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,workspace_read}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,workspace_read}')::integer) else null end,
          'gmail_list', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,gmail_list}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,gmail_list}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,gmail_list}')::integer) else null end,
          'gmail_fetch', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,gmail_fetch}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,gmail_fetch}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,gmail_fetch}')::integer) else null end,
          'message_parse', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,message_parse}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,message_parse}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,message_parse}')::integer) else null end,
          'semantic_apply', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,semantic_apply}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,semantic_apply}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,semantic_apply}')::integer) else null end,
          'lease_assert', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,lease_assert}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,lease_assert}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,lease_assert}')::integer) else null end,
          'workspace_commit', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,workspace_commit}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,workspace_commit}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,workspace_commit}')::integer) else null end,
          'checkpoint', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,checkpoint}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,checkpoint}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,checkpoint}')::integer) else null end
        ))
      ))
    );
  end if;

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

  -- Diagnostics contain only closed phase labels and bounded integer counters.
  -- Missing/invalid diagnostics preserve the previous caller contract exactly.
  if jsonb_typeof(metrics->'diagnostics') = 'object'
    and metrics#>'{diagnostics,version}' = '1'::jsonb
  then
    safe_metrics := safe_metrics || jsonb_build_object('diagnostics',
      jsonb_strip_nulls(jsonb_build_object(
        'version', 1,
        'phase', case when metrics#>>'{diagnostics,phase}' in ('claim','token_refresh','workspace_read','gmail_list','gmail_fetch','message_parse','semantic_apply','lease_assert','workspace_commit','checkpoint','complete')
          then metrics#>>'{diagnostics,phase}' else null end,
        'processedCount', case
          when jsonb_typeof(metrics#>'{diagnostics,processedCount}') = 'number'
            and coalesce(metrics#>>'{diagnostics,processedCount}', '') ~ '^[0-9]{1,3}$'
          then least(100, (metrics#>>'{diagnostics,processedCount}')::integer) else null end,
        'durationsMs', jsonb_strip_nulls(jsonb_build_object(
          'claim', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,claim}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,claim}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,claim}')::integer) else null end,
          'token_refresh', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,token_refresh}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,token_refresh}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,token_refresh}')::integer) else null end,
          'workspace_read', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,workspace_read}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,workspace_read}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,workspace_read}')::integer) else null end,
          'gmail_list', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,gmail_list}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,gmail_list}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,gmail_list}')::integer) else null end,
          'gmail_fetch', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,gmail_fetch}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,gmail_fetch}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,gmail_fetch}')::integer) else null end,
          'message_parse', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,message_parse}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,message_parse}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,message_parse}')::integer) else null end,
          'semantic_apply', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,semantic_apply}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,semantic_apply}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,semantic_apply}')::integer) else null end,
          'lease_assert', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,lease_assert}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,lease_assert}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,lease_assert}')::integer) else null end,
          'workspace_commit', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,workspace_commit}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,workspace_commit}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,workspace_commit}')::integer) else null end,
          'checkpoint', case when jsonb_typeof(metrics#>'{diagnostics,durationsMs,checkpoint}') = 'number'
            and coalesce(metrics#>>'{diagnostics,durationsMs,checkpoint}', '') ~ '^[0-9]{1,5}$'
            then least(25000, (metrics#>>'{diagnostics,durationsMs,checkpoint}')::integer) else null end
        ))
      ))
    );
  end if;

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
