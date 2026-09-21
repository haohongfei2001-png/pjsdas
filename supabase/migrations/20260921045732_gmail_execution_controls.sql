-- Dormant until PJSDAS_GMAIL_EXECUTION_CONTROLS=true. No schedules, grants to
-- mail sources, enabled-user changes, secrets or production activation.
create table public.gmail_automation_execution_state (
  user_id uuid primary key references public.google_drive_connections(user_id) on delete cascade,
  lease_token uuid,
  lease_expires_at timestamptz,
  binding_updated_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  completed_runs bigint not null default 0,
  failed_runs bigint not null default 0,
  coalesced_runs bigint not null default 0,
  last_metrics jsonb not null default '{}'::jsonb,
  constraint gmail_execution_lease_pair check ((lease_token is null) = (lease_expires_at is null))
);
alter table public.gmail_automation_execution_state enable row level security;
revoke all on public.gmail_automation_execution_state from public, anon, authenticated;

-- RLS-authorized settings/token updates must invalidate a live lease even if a
-- caller does not bump updated_at. Store no duplicate credentials/fingerprints.
create function public.pjsdas_invalidate_gmail_execution()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if row(new.gmail_automation_enabled,new.revoked_at,new.google_subject,new.refresh_token_ciphertext,
      new.granted_scopes,new.gmail_intake_consent_version,new.gmail_history_id,new.gmail_sync_mode,
      new.gmail_page_token,new.gmail_pending_history_id,new.gmail_pending_message_ids)
    is distinct from row(old.gmail_automation_enabled,old.revoked_at,old.google_subject,old.refresh_token_ciphertext,
      old.granted_scopes,old.gmail_intake_consent_version,old.gmail_history_id,old.gmail_sync_mode,
      old.gmail_page_token,old.gmail_pending_history_id,old.gmail_pending_message_ids) then
    update public.gmail_automation_execution_state set lease_token=null,lease_expires_at=null where user_id=new.user_id;
  end if;
  return new;
end $$;
revoke all on function public.pjsdas_invalidate_gmail_execution() from public,anon,authenticated;
create trigger pjsdas_invalidate_gmail_execution after update on public.google_drive_connections
for each row execute function public.pjsdas_invalidate_gmail_execution();

create function public.pjsdas_begin_gmail_execution(worker_token text, target_user_id uuid, execution_token uuid, ttl_seconds integer default 60)
returns jsonb language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  binding public.google_drive_connections%rowtype;
  previous public.gmail_automation_execution_state%rowtype;
  result jsonb;
begin
  if worker_token is null or not exists(select 1 from vault.decrypted_secrets where name='pjsdas_gmail_automation_worker_token' and decrypted_secret=worker_token) then
    raise exception 'Invalid PJSDAS automation worker token.' using errcode='42501';
  end if;
  if execution_token is null or ttl_seconds is null or ttl_seconds < 30 or ttl_seconds > 120 then raise exception 'Invalid execution lease.' using errcode='22023'; end if;
  select * into binding from public.google_drive_connections where user_id=target_user_id for update;
  if not found or not binding.gmail_automation_enabled or binding.revoked_at is not null then return null; end if;
  insert into public.gmail_automation_execution_state(user_id) values(target_user_id) on conflict do nothing;
  select * into previous from public.gmail_automation_execution_state where user_id=target_user_id for update;
  if previous.lease_token is not null and previous.lease_expires_at > clock_timestamp() then
    update public.gmail_automation_execution_state set coalesced_runs=coalesced_runs+1 where user_id=target_user_id;
    return null;
  end if;
  update public.gmail_automation_execution_state set lease_token=execution_token,
    lease_expires_at=clock_timestamp()+make_interval(secs=>ttl_seconds), binding_updated_at=binding.updated_at,
    started_at=clock_timestamp() where user_id=target_user_id;
  -- Return fresh binding state after taking the lease; never use a stale list snapshot.
  select to_jsonb(b) into result from public.pjsdas_claim_gmail_automation_bindings_v3(worker_token) b where b.user_id=target_user_id;
  return result;
end $$;

create function public.pjsdas_assert_gmail_execution(worker_token text, target_user_id uuid, execution_token uuid)
returns boolean language plpgsql security definer set search_path = public, vault, pg_temp as $$
begin
  if worker_token is null or not exists(select 1 from vault.decrypted_secrets where name='pjsdas_gmail_automation_worker_token' and decrypted_secret=worker_token) then
    raise exception 'Invalid PJSDAS automation worker token.' using errcode='42501';
  end if;
  return exists(select 1 from public.gmail_automation_execution_state s join public.google_drive_connections c using(user_id)
    where s.user_id=target_user_id and s.lease_token=execution_token and s.lease_expires_at>clock_timestamp()
      and s.binding_updated_at is not distinct from c.updated_at and c.gmail_automation_enabled and c.revoked_at is null);
end $$;

create function public.pjsdas_finish_gmail_execution(worker_token text, target_user_id uuid, execution_token uuid, state_patch jsonb, metrics jsonb)
returns boolean language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  binding public.google_drive_connections%rowtype;
  lease public.gmail_automation_execution_state%rowtype;
  complete boolean;
  run_mode text;
  error_code text;
  duration_ms bigint;
  safe_metrics jsonb;
begin
  if worker_token is null or not exists(select 1 from vault.decrypted_secrets where name='pjsdas_gmail_automation_worker_token' and decrypted_secret=worker_token) then
    raise exception 'Invalid PJSDAS automation worker token.' using errcode='42501';
  end if;
  if execution_token is null then return false; end if;
  select * into binding from public.google_drive_connections where user_id=target_user_id for update;
  select * into lease from public.gmail_automation_execution_state where user_id=target_user_id for update;
  if lease.lease_token is distinct from execution_token or lease.lease_expires_at is null or lease.lease_expires_at<=clock_timestamp()
    or lease.binding_updated_at is distinct from binding.updated_at or not binding.gmail_automation_enabled or binding.revoked_at is not null then return false; end if;
  complete := metrics->>'status'='completed';
  run_mode := case when metrics->>'mode' in ('history','initial_backfill','history_recovery') then metrics->>'mode' else 'unknown' end;
  error_code := case when metrics->>'errorCode' in ('BUDGET_EXHAUSTED','LEASE_LOST','GOOGLE_AUTH_EXPIRED','GOOGLE_GMAIL_FORBIDDEN','GOOGLE_GMAIL_SCOPE_MISSING','GOOGLE_ACCOUNT_MISMATCH','GOOGLE_REFRESH_FAILED','WORKSPACE_CONFLICT','AUTH_UNAVAILABLE') then metrics->>'errorCode' else 'AUTOMATION_FAILED' end;
  duration_ms := greatest(0,(extract(epoch from(clock_timestamp()-lease.started_at))*1000)::bigint);
  safe_metrics := jsonb_build_object('status',case when complete then 'completed' else 'error' end,
    'mode',run_mode,'durationMs',duration_ms,'errorCode',case when complete then null else error_code end,
    'receivedCount',least(100,greatest(0,coalesce((metrics->>'receivedCount')::integer,0))),
    'accountedCount',least(100,greatest(0,coalesce((metrics->>'accountedCount')::integer,0))),
    'unresolvedCount',least(100,greatest(0,coalesce((metrics->>'unresolvedCount')::integer,0))));
  if complete and run_mode='history' then
    safe_metrics := safe_metrics || jsonb_build_object('historyLag',jsonb_build_object(
      'count',least(100,greatest(0,coalesce((metrics#>>'{historyLag,count}')::integer,0))),
      'sumMs',least(3153600000000,greatest(0,coalesce((metrics#>>'{historyLag,sumMs}')::bigint,0))),
      'maxMs',least(31536000000,greatest(0,coalesce((metrics#>>'{historyLag,maxMs}')::bigint,0))),
      'under2m',least(100,greatest(0,coalesce((metrics#>>'{historyLag,under2m}')::integer,0))),
      'under15m',least(100,greatest(0,coalesce((metrics#>>'{historyLag,under15m}')::integer,0))),
      'over15m',least(100,greatest(0,coalesce((metrics#>>'{historyLag,over15m}')::integer,0)))));
  end if;
  if complete and state_patch ? 'continuation' and jsonb_typeof(state_patch->'continuation')='object'
    and state_patch#>>'{continuation,mode}' not in ('history','fallback') then raise exception 'Invalid continuation.' using errcode='22023'; end if;
  update public.google_drive_connections set
    gmail_history_id=case when complete and state_patch ? 'historyId' then state_patch->>'historyId' else gmail_history_id end,
    gmail_sync_mode=case when complete and state_patch ? 'continuation' then state_patch#>>'{continuation,mode}' else gmail_sync_mode end,
    gmail_page_token=case when complete and state_patch ? 'continuation' then state_patch#>>'{continuation,pageToken}' else gmail_page_token end,
    gmail_pending_history_id=case when complete and state_patch ? 'continuation' then state_patch#>>'{continuation,pendingHistoryId}' else gmail_pending_history_id end,
    gmail_pending_message_ids=case when complete and state_patch ? 'continuation' then
      coalesce(array(select jsonb_array_elements_text(state_patch#>'{continuation,pendingMessageIds}')),'{}'::text[]) else gmail_pending_message_ids end,
    gmail_last_checked_at=lease.started_at,
    gmail_last_success_at=case when complete and state_patch ? 'successAt' then clock_timestamp() else gmail_last_success_at end,
    gmail_last_error=case when complete then null else error_code || ': automation execution failed' end,
    updated_at=clock_timestamp()
    where user_id=target_user_id;
  update public.gmail_automation_execution_state set lease_token=null,lease_expires_at=null,completed_at=clock_timestamp(),
    completed_runs=completed_runs+case when complete then 1 else 0 end,
    failed_runs=failed_runs+case when complete then 0 else 1 end,last_metrics=safe_metrics where user_id=target_user_id;
  return true;
end $$;

revoke all on function public.pjsdas_begin_gmail_execution(text,uuid,uuid,integer) from public,authenticated;
revoke all on function public.pjsdas_assert_gmail_execution(text,uuid,uuid) from public,authenticated;
revoke all on function public.pjsdas_finish_gmail_execution(text,uuid,uuid,jsonb,jsonb) from public,authenticated;
grant execute on function public.pjsdas_begin_gmail_execution(text,uuid,uuid,integer) to anon;
grant execute on function public.pjsdas_assert_gmail_execution(text,uuid,uuid) to anon;
grant execute on function public.pjsdas_finish_gmail_execution(text,uuid,uuid,jsonb,jsonb) to anon;

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

  -- Durable generation fence: once a binding enters controlled execution, a
  -- delayed legacy writer must never move its cursor, even after lease release
  -- or expiry. Never-controlled bindings retain their original v2 behavior.
  perform 1 from public.google_drive_connections where user_id=target_user_id for update;
  if exists(select 1 from public.gmail_automation_execution_state where user_id=target_user_id) then
    raise exception 'A controlled Gmail execution fence owns this binding.' using errcode='40001';
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

revoke execute on function public.pjsdas_update_gmail_automation_state_v2(text,uuid,text,text,text,text,text[],timestamptz,timestamptz,text,boolean,boolean,boolean,boolean) from authenticated;

-- Fence the still-exposed pre-v2 writer as well.
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

  perform 1 from public.google_drive_connections where user_id=target_user_id for update;
  if exists(select 1 from public.gmail_automation_execution_state where user_id=target_user_id) then
    raise exception 'A controlled Gmail execution fence owns this binding.' using errcode='40001';
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

revoke execute on function public.pjsdas_update_gmail_automation_state(text,uuid,text,timestamptz,timestamptz,text,boolean,boolean) from authenticated;
