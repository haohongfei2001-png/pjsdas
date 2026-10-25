-- OFFLINE CANDIDATE ONLY. No production activation is authorized by this file.
-- Narrow empty Gmail history-poll audit storage; not a generic delta API.
-- Enable only after every reader/writer below, recovery and ACL checks pass.

alter table public.pjsdas_workspaces add column materialized_revision bigint;
update public.pjsdas_workspaces set materialized_revision = revision;
alter table public.pjsdas_workspaces alter column materialized_revision set default 0;
alter table public.pjsdas_workspaces alter column materialized_revision set not null;
alter table public.pjsdas_workspaces add constraint pjsdas_materialized_revision_range
  check (materialized_revision >= 0 and materialized_revision <= revision);
-- A dedicated column cannot be forged through the existing provenance argument.
-- It is immutable command evidence, retained even after snapshot materialization.
alter table public.pjsdas_command_ledger add column gmail_empty_poll_run jsonb;
alter table public.pjsdas_command_ledger add constraint pjsdas_empty_poll_run_bound
  check (gmail_empty_poll_run is null or (jsonb_typeof(gmail_empty_poll_run) = 'object'
    and octet_length(gmail_empty_poll_run::text) <= 4096
    and operation = 'gmail_semantic_intake' and principal_kind = 'automation' and status = 'COMMITTED'));
create index pjsdas_empty_poll_pending_idx
  on public.pjsdas_command_ledger(user_id, resulting_revision)
  where status = 'COMMITTED' and gmail_empty_poll_run is not null;

-- The exact existing run shape, including the ASCII FNV-1a/base36 timeline ID.
-- No caller-supplied snapshot, title, arbitrary source, operation or audit object.
create function public.pjsdas_empty_gmail_run_v1(command_id text, checked_at text, history_id text)
returns jsonb language plpgsql immutable security invoker
set search_path = pg_catalog, public, pg_temp as $$
declare
  identity text := 'gmail|gmail:primary|' || command_id;
  hash bigint := 2166136261;
  encoded text := '';
  digits constant text := '0123456789abcdefghijklmnopqrstuvwxyz';
  at_time timestamptz;
begin
  if checked_at is null or checked_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    or command_id is distinct from 'gmail:auto:' || checked_at
    or history_id is null or history_id !~ '^[0-9]{1,40}$' then
    raise exception 'Invalid bounded empty-poll identity.' using errcode='22023';
  end if;
  at_time := checked_at::timestamptz;
  if not isfinite(at_time) or to_char(at_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> checked_at then
    raise exception 'Invalid empty-poll time.' using errcode='22023';
  end if;
  for i in 1..length(identity) loop
    hash := ((hash # ascii(substr(identity,i,1))) * 16777619) % 4294967296;
  end loop;
  if hash=0 then encoded:='0'; end if;
  while hash>0 loop encoded:=substr(digits,(hash%36)::integer+1,1)||encoded; hash:=hash/36; end loop;
  return jsonb_build_object(
    'id','timeline:ingestion-run:'||encoded,'kind','ingestion_run_completed','category','data','source','gmail',
    'occurredAt',checked_at,'recordedAt',checked_at,'title','摄入完成｜gmail:primary｜0 条全部对账',
    'detail','','sourceRef',command_id,'ingestionRun',jsonb_build_object(
      'version',1,'runId',command_id,'sourceKind','gmail','sourceId','gmail:primary',
      'startedAt',checked_at,'completedAt',checked_at,'receivedCount',0,'accountedCount',0,
      'outcomes','{}'::jsonb,'cursor',history_id,'sourcePolicy',jsonb_build_object(
        'version',1,'enabled',true,'label','招聘邮件自动摄入','cadenceMinutes',10,'freshnessSlaMinutes',20)));
end $$;
revoke all on function public.pjsdas_empty_gmail_run_v1(text,text,text) from public,anon,authenticated;
grant execute on function public.pjsdas_empty_gmail_run_v1(text,text,text) to service_role;

-- Merge only immutable, server-created empty-run records in an exact revision
-- window. The preimage is the locked raw snapshot, never an already-overlaid one.
-- Legacy append-only targets receive pending rows BEFORE their new audit suffix.
-- Ambiguous history edits fail closed; a maintenance drain can precede such work.
create function public.pjsdas_merge_empty_gmail_runs_v1(
  target_user_id uuid, base_snapshot jsonb, base_revision bigint, observed_revision bigint,
  proposed_snapshot jsonb, read_projection boolean default false
) returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public, pg_temp as $$
declare
  pending jsonb;
  old_history jsonb;
  proposed_history jsonb;
  prefix_length integer;
  matching_rows jsonb;
  next_history jsonb;
  latest_at text;
begin
  if base_revision is null or observed_revision is null or base_revision > observed_revision then
    raise exception 'Invalid materialized workspace revision.' using errcode='22023';
  end if;
  if base_revision=observed_revision then return proposed_snapshot; end if;
  select coalesce(jsonb_agg(l.gmail_empty_poll_run order by l.resulting_revision),'[]'::jsonb)
    into pending from (select gmail_empty_poll_run,resulting_revision from public.pjsdas_command_ledger
      where user_id=target_user_id and resulting_revision>base_revision and resulting_revision<=observed_revision
        and status='COMMITTED' and gmail_empty_poll_run is not null
      order by resulting_revision limit 257) l;
  if jsonb_array_length(pending)<>observed_revision-base_revision then
    raise exception 'Pending empty-poll revision evidence is incomplete.' using errcode='40001';
  end if;
  if jsonb_array_length(pending)>256 then
    raise exception 'Empty-poll audit overlay exceeded its bounded window.' using errcode='54000';
  end if;
  old_history:=coalesce(base_snapshot#>'{data,timeline}','[]'::jsonb);
  proposed_history:=coalesce(proposed_snapshot#>'{data,timeline}','[]'::jsonb);
  if jsonb_typeof(old_history) is distinct from 'array' or jsonb_typeof(proposed_history) is distinct from 'array'
    or jsonb_typeof(proposed_snapshot->'data') is distinct from 'object' then
    raise exception 'Pending audit evidence requires a valid snapshot timeline.' using errcode='22023';
  end if;
  prefix_length:=jsonb_array_length(old_history);
  -- Scalar JSONPath keeps full history out of SQL set-returning tuplestores.
  if jsonb_array_length(proposed_history)<prefix_length
    or (prefix_length>0 and jsonb_path_query_array(proposed_history,
      format('$[0 to %s]',prefix_length-1)::jsonpath) is distinct from old_history) then
    raise exception 'Drain pending empty-poll audits before rewriting historical order.' using errcode='40001';
  end if;
  matching_rows:=jsonb_path_query_array(proposed_history,'$[*] ? (@.id == $ids[*])',
    jsonb_build_object('ids',jsonb_path_query_array(pending,'$[*].id')));
  if jsonb_array_length(matching_rows)=0 then
    next_history:=old_history||pending||case when jsonb_array_length(proposed_history)>prefix_length
      then jsonb_path_query_array(proposed_history,format('$[%s to last]',prefix_length)::jsonpath)
      else '[]'::jsonb end;
  elsif matching_rows=pending and jsonb_path_query_array(proposed_history,
    format('$[%s to %s]',prefix_length,prefix_length+jsonb_array_length(pending)-1)::jsonpath)=pending then
    next_history:=proposed_history;
  else
    raise exception 'Pending empty-poll audit evidence differs or is duplicated.' using errcode='40001';
  end if;
  proposed_snapshot:=jsonb_set(proposed_snapshot,'{data,timeline}',next_history);
  latest_at:=pending->(jsonb_array_length(pending)-1)->>'occurredAt';
  if read_projection or proposed_snapshot->>'exportedAt'=base_snapshot->>'exportedAt' then
    proposed_snapshot:=jsonb_set(proposed_snapshot,'{exportedAt}',to_jsonb(latest_at));
  end if;
  return proposed_snapshot;
end $$;
revoke all on function public.pjsdas_merge_empty_gmail_runs_v1(uuid,jsonb,bigint,bigint,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.pjsdas_merge_empty_gmail_runs_v1(uuid,jsonb,bigint,bigint,jsonb,boolean) to service_role;

create function public.pjsdas_logical_workspace_snapshot_v1(w public.pjsdas_workspaces)
returns jsonb language sql stable security invoker
set search_path=pg_catalog,public,pg_temp as $$
  select public.pjsdas_merge_empty_gmail_runs_v1(w.user_id,w.snapshot,w.materialized_revision,w.revision,w.snapshot,true)
$$;
revoke all on function public.pjsdas_logical_workspace_snapshot_v1(public.pjsdas_workspaces) from public,anon,authenticated;
grant execute on function public.pjsdas_logical_workspace_snapshot_v1(public.pjsdas_workspaces) to service_role;

-- Maintenance drain advances CAS as a fence against pre-drain raw readers.
-- Historical command receipts remain immutable; the fence is not a business command.
-- This is the explicit rollback gate, not an automatic destructive cleanup.
create function public.pjsdas_drain_empty_gmail_runs_v1(target_user_id uuid,target_expected_revision bigint)
returns table(outcome text,revision bigint) language plpgsql security invoker
set search_path=pg_catalog,public,pg_temp as $$
declare w public.pjsdas_workspaces%rowtype;
begin
  select * into w from public.pjsdas_workspaces where user_id=target_user_id for update;
  if not found then raise exception 'Connected workspace does not exist.' using errcode='P0001'; end if;
  revision:=w.revision;
  if w.revision is distinct from target_expected_revision then outcome:='CONFLICT'; return next; return; end if;
  if w.materialized_revision=w.revision then outcome:='ALREADY_DRAINED'; return next; return; end if;
  update public.pjsdas_workspaces set snapshot=public.pjsdas_logical_workspace_snapshot_v1(w),
    revision=w.revision+1,materialized_revision=w.revision+1,updated_at=now() where id=w.id;
  revision:=w.revision+1;
  outcome:='DRAINED'; return next;
end $$;
revoke all on function public.pjsdas_drain_empty_gmail_runs_v1(uuid,bigint) from public,anon,authenticated;
grant execute on function public.pjsdas_drain_empty_gmail_runs_v1(uuid,bigint) to service_role;

create function public.pjsdas_checkpoint_empty_gmail_poll_v1(
  target_user_id uuid,target_execution_token uuid,target_command_id text,target_payload_hash text,
  target_expected_revision bigint,target_checked_at text,target_history_id text,
  target_observation jsonb
) returns table(outcome text,workspace_id uuid,revision bigint,receipt jsonb)
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare
  binding public.google_drive_connections%rowtype;
  lease public.gmail_automation_execution_state%rowtype;
  w public.pjsdas_workspaces%rowtype;
  previous public.pjsdas_command_ledger%rowtype;
  run jsonb;
  refs jsonb;
  next_receipt jsonb;
  pending_count integer;
begin
  if target_user_id is null or target_execution_token is null or target_expected_revision is null
    or target_expected_revision<0 or target_payload_hash is null or target_payload_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Incomplete empty-poll checkpoint.' using errcode='22023';
  end if;
  run:=public.pjsdas_empty_gmail_run_v1(target_command_id,target_checked_at,target_history_id);
  -- Exact proof shape. The service-only worker owns retrieval truth, while SQL
  -- independently verifies the unchanged cursor, original lease and consent.
  if target_observation is distinct from '{"version":1,"mode":"history","coverageComplete":true,"fetchedCount":0,"unavailableCount":0,"sourceRecordCount":0,"hasContinuation":false,"hasRecoveryGap":false,"backfillComplete":true}'::jsonb then
    outcome:='NOT_ELIGIBLE'; return next; return;
  end if;
  -- Same authority lock order as existing controlled execution: binding, lease,
  -- then workspace. No mailbox credentials or new worker token are introduced.
  select * into binding from public.google_drive_connections where user_id=target_user_id for share;
  select * into lease from public.gmail_automation_execution_state where user_id=target_user_id for share;
  if binding.user_id is null or lease.user_id is null
    or lease.lease_token is distinct from target_execution_token or lease.lease_expires_at is null
    or not isfinite(lease.lease_expires_at) or lease.lease_expires_at<=clock_timestamp()
    or lease.started_at is null or not isfinite(lease.started_at)
    or lease.binding_updated_at is null or binding.updated_at is null
    or lease.binding_updated_at is distinct from binding.updated_at
    or binding.gmail_automation_enabled is not true or binding.revoked_at is not null
    or binding.gmail_intake_consent_version is distinct from 'uu06-v1'
    or not ('https://www.googleapis.com/auth/gmail.readonly'=any(coalesce(binding.granted_scopes,'{}'::text[]))) then
    raise exception 'Original Gmail execution authority is absent or changed.' using errcode='42501';
  end if;
  if binding.gmail_history_id is distinct from target_history_id
    or binding.gmail_sync_mode is not null or binding.gmail_page_token is not null
    or binding.gmail_pending_history_id is not null or cardinality(coalesce(binding.gmail_pending_message_ids,'{}'::text[]))<>0 then
    outcome:='NOT_ELIGIBLE'; return next; return;
  end if;
  if target_checked_at::timestamptz < lease.started_at-interval '1 second'
    or target_checked_at::timestamptz > clock_timestamp()+interval '1 second' then
    raise exception 'Empty-poll time is outside the original execution.' using errcode='22023';
  end if;
  select * into w from public.pjsdas_workspaces where user_id=target_user_id for update;
  if not found then raise exception 'Connected workspace does not exist.' using errcode='P0001'; end if;
  -- The lock wait is part of this transaction; expiry must be tested AFTER it.
  if lease.lease_expires_at<=clock_timestamp() then
    raise exception 'Original Gmail execution expired while waiting.' using errcode='42501';
  end if;
  workspace_id:=w.id; revision:=w.revision;
  select * into previous from public.pjsdas_command_ledger where user_id=target_user_id and command_id=target_command_id;
  if found then
    if previous.payload_hash is distinct from target_payload_hash or previous.operation<>'gmail_semantic_intake'
      or previous.gmail_empty_poll_run is distinct from run then
      raise exception 'Command identity was reused with different empty-poll evidence.' using errcode='23505';
    end if;
    outcome:='ALREADY_APPLIED'; receipt:=previous.receipt; return next; return;
  end if;
  if w.revision<>target_expected_revision then outcome:='CONFLICT'; return next; return; end if;
  -- Do not detoast the full JSON merely to recheck a stored schema scalar.
  if w.schema_version<>4 then outcome:='NOT_ELIGIBLE'; return next; return; end if;
  -- Preserve the original validator's unique-ID invariant, including possible
  -- FNV collisions, and independently require the prior UU06 coverage boundary.
  -- These scalar JSONPath reads may detoast input but never materialize a large
  -- SQL set or rewrite the JSONB. New reads are not claimed to be zero-cost.
  if jsonb_path_exists(w.snapshot,'$.data.timeline[*] ? (@.id == $id)',jsonb_build_object('id',run->>'id'))
    or not jsonb_path_exists(w.snapshot,'$.data.timeline[*] ? (@.ingestion.sourceKind == "gmail" && @.ingestion.sourceId == "gmail:primary" && @.ingestion.sourceRecordId == "coverage-boundary:uu06-90-days")')
    or exists(select 1 from public.pjsdas_command_ledger l where l.user_id=target_user_id
      and l.resulting_revision>w.materialized_revision and l.resulting_revision<=w.revision
      and l.gmail_empty_poll_run->>'id'=run->>'id') then
    outcome:='NOT_ELIGIBLE'; return next; return;
  end if;
  select count(*) into pending_count from public.pjsdas_command_ledger
    where user_id=target_user_id and resulting_revision>w.materialized_revision and resulting_revision<=w.revision
      and status='COMMITTED' and gmail_empty_poll_run is not null;
  if pending_count<>w.revision-w.materialized_revision then
    raise exception 'Pending empty-poll revision evidence is incomplete.' using errcode='40001';
  end if;
  if pending_count>=256 then outcome:='NOT_ELIGIBLE'; return next; return; end if;
  refs:=jsonb_build_array(jsonb_build_object('type','timeline','id',run->>'id'));
  next_receipt:=jsonb_build_object('commandId',target_command_id,'receiptId','command-receipt:'||target_command_id,
    'status','COMMITTED','operation','gmail_semantic_intake','revision',w.revision+1,'committedAt',now(),
    'undoAvailable',true,'contractVersion',2,'commandType','workspace_source_semantic',
    'affectedObjects',refs,'undoDependencyObjects',refs,'readModelInvalidation',jsonb_build_array('timeline'),
    'storageContract','gmail-empty-poll-v1','lifecycle',jsonb_build_object('receivedAt',target_checked_at,
      'validatedAt',target_checked_at,'baseRevision',w.revision,'authoritativeRevisionBeforeCommit',w.revision,'rebased',false));
  -- Critically: do not SET snapshot, even to its existing value.
  update public.pjsdas_workspaces set revision=w.revision+1,updated_at=now() where id=w.id;
  insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,expected_revision,
    principal_kind,client_id,provenance,compensation,effective_time,status,resulting_revision,receipt,gmail_empty_poll_run)
  values(w.id,target_user_id,target_command_id,'gmail_semantic_intake',target_payload_hash,w.revision,'automation',null,
    '{"writer":"gmail-automation-worker","sourceId":"gmail:primary","adapterVersion":"uu06-v1"}'::jsonb,
    '{"operation":"semantic_batch","payload":{"domainCompensations":[],"decisionRequestIds":[],"receiptIds":[]}}'::jsonb,
    target_checked_at::timestamptz,'COMMITTED',w.revision+1,next_receipt,run);
  outcome:='COMMITTED'; revision:=w.revision+1; receipt:=next_receipt; return next;
end $$;
revoke all on function public.pjsdas_checkpoint_empty_gmail_poll_v1(uuid,uuid,text,text,bigint,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.pjsdas_checkpoint_empty_gmail_poll_v1(uuid,uuid,text,text,bigint,text,text,jsonb) to service_role;

-- Explicit complete replacements below preserve signatures, owners and existing ACLs.
-- Each change is limited to overlay preimages / pending absorption / materialization.

-- Original body: 2026091901_ai_operated_mutation_foundation.sql
create or replace function public.pjsdas_commit_workspace(
  target_user_id uuid,
  target_command_id text,
  target_operation text,
  target_payload_hash text,
  target_expected_revision bigint,
  target_snapshot jsonb,
  target_schema_version integer,
  target_principal_kind text,
  target_client_id text default null,
  target_provenance jsonb default '{}'::jsonb,
  target_compensation jsonb default null,
  target_effective_time timestamptz default null
)
returns table (
  outcome text,
  workspace_id uuid,
  revision bigint,
  snapshot jsonb,
  receipt jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_workspace public.pjsdas_workspaces%rowtype;
  existing_command public.pjsdas_command_ledger%rowtype;
  next_revision bigint;
  next_receipt jsonb;
begin
  if target_user_id is null
    or nullif(trim(target_command_id), '') is null
    or nullif(trim(target_operation), '') is null
    or nullif(trim(target_payload_hash), '') is null
    or target_snapshot is null
    or nullif(trim(target_principal_kind), '') is null then
    raise exception 'PJSDAS commit arguments are incomplete.' using errcode = '22023';
  end if;

  -- Serialize every commit for one workspace before consulting the command
  -- ledger. This makes a simultaneous retry of the same command observe the
  -- first committed receipt instead of racing into a false revision conflict.
  select * into current_workspace
  from public.pjsdas_workspaces
  where user_id = target_user_id
  for update;

  if not found then
    raise exception 'PJSDAS connected workspace does not exist.' using errcode = 'P0001';
  end if;

  select * into existing_command
  from public.pjsdas_command_ledger
  where user_id = target_user_id
    and command_id = target_command_id;

  if found then
    if existing_command.payload_hash <> target_payload_hash then
      raise exception 'PJSDAS command id was reused with a different payload.' using errcode = '23505';
    end if;

    outcome := 'ALREADY_APPLIED';
    workspace_id := existing_command.workspace_id;
    revision := current_workspace.revision;
    snapshot := public.pjsdas_logical_workspace_snapshot_v1(current_workspace);
    receipt := existing_command.receipt;
    return next;
    return;
  end if;

  if target_expected_revision is null or current_workspace.revision <> target_expected_revision then
    outcome := 'CONFLICT';
    workspace_id := current_workspace.id;
    revision := current_workspace.revision;
    snapshot := public.pjsdas_logical_workspace_snapshot_v1(current_workspace);
    receipt := jsonb_build_object(
      'commandId', target_command_id,
      'status', 'CONFLICT',
      'expectedRevision', target_expected_revision,
      'actualRevision', current_workspace.revision
    );
    return next;
    return;
  end if;

  target_snapshot := public.pjsdas_merge_empty_gmail_runs_v1(target_user_id,current_workspace.snapshot,
    current_workspace.materialized_revision,current_workspace.revision,target_snapshot,false);

  next_revision := current_workspace.revision + 1;
  next_receipt := jsonb_build_object(
    'commandId', target_command_id,
    'status', 'COMMITTED',
    'operation', target_operation,
    'revision', next_revision,
    'undoAvailable', target_compensation is not null
  );

  update public.pjsdas_workspaces
  set
    snapshot = target_snapshot,
    revision = next_revision,
    materialized_revision = next_revision,
    schema_version = target_schema_version,
    updated_at = now()
  where id = current_workspace.id;

  insert into public.pjsdas_command_ledger (
    workspace_id,
    user_id,
    command_id,
    operation,
    payload_hash,
    expected_revision,
    principal_kind,
    client_id,
    provenance,
    compensation,
    effective_time,
    status,
    resulting_revision,
    receipt,
    updated_at
  )
  values (
    current_workspace.id,
    target_user_id,
    target_command_id,
    target_operation,
    target_payload_hash,
    target_expected_revision,
    target_principal_kind,
    target_client_id,
    coalesce(target_provenance, '{}'::jsonb),
    target_compensation,
    target_effective_time,
    'COMMITTED',
    next_revision,
    next_receipt,
    now()
  );

  outcome := 'COMMITTED';
  workspace_id := current_workspace.id;
  revision := next_revision;
  snapshot := target_snapshot;
  receipt := next_receipt;
  return next;
end
$$;

-- Original body: 20260923030000_cgr01_authoritative_commands.sql
create or replace function public.pjsdas_commit_workspace_v2(
  target_user_id uuid,
  target_command_id text,
  target_operation text,
  target_payload_hash text,
  target_expected_revision bigint,
  target_snapshot jsonb,
  target_schema_version integer,
  target_principal_kind text,
  target_client_id text,
  target_provenance jsonb,
  target_compensation jsonb,
  target_effective_time timestamptz,
  target_receipt_context jsonb
)
returns table (
  outcome text,
  workspace_id uuid,
  revision bigint,
  snapshot jsonb,
  receipt jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_workspace public.pjsdas_workspaces%rowtype;
  existing_command public.pjsdas_command_ledger%rowtype;
  next_revision bigint;
  next_receipt jsonb;
begin
  if target_user_id is null
    or nullif(trim(target_command_id), '') is null
    or nullif(trim(target_operation), '') is null
    or nullif(trim(target_payload_hash), '') is null
    or target_snapshot is null
    or nullif(trim(target_principal_kind), '') is null then
    raise exception 'PJSDAS v2 commit arguments are incomplete.' using errcode = '22023';
  end if;

  select * into current_workspace
  from public.pjsdas_workspaces
  where user_id = target_user_id
  for update;

  if not found then
    raise exception 'PJSDAS connected workspace does not exist.' using errcode = 'P0001';
  end if;

  select * into existing_command
  from public.pjsdas_command_ledger
  where user_id = target_user_id
    and command_id = target_command_id;

  if found then
    if existing_command.payload_hash <> target_payload_hash then
      raise exception 'PJSDAS command id was reused with a different payload.' using errcode = '23505';
    end if;

    outcome := 'ALREADY_APPLIED';
    workspace_id := existing_command.workspace_id;
    revision := current_workspace.revision;
    snapshot := public.pjsdas_logical_workspace_snapshot_v1(current_workspace);
    receipt := existing_command.receipt;
    return next;
    return;
  end if;

  if target_expected_revision is null or current_workspace.revision <> target_expected_revision then
    outcome := 'CONFLICT';
    workspace_id := current_workspace.id;
    revision := current_workspace.revision;
    snapshot := public.pjsdas_logical_workspace_snapshot_v1(current_workspace);
    receipt := coalesce(target_receipt_context, '{}'::jsonb) || jsonb_build_object(
      'commandId', target_command_id,
      'receiptId', 'command-receipt:' || target_command_id,
      'status', 'CONFLICT',
      'expectedRevision', target_expected_revision,
      'actualRevision', current_workspace.revision
    );
    return next;
    return;
  end if;

  target_snapshot := public.pjsdas_merge_empty_gmail_runs_v1(target_user_id,current_workspace.snapshot,
    current_workspace.materialized_revision,current_workspace.revision,target_snapshot,false);

  next_revision := current_workspace.revision + 1;
  next_receipt := coalesce(target_receipt_context, '{}'::jsonb) || jsonb_build_object(
    'commandId', target_command_id,
    'receiptId', 'command-receipt:' || target_command_id,
    'status', 'COMMITTED',
    'operation', target_operation,
    'revision', next_revision,
    'committedAt', now(),
    'undoAvailable', target_compensation is not null
  );

  update public.pjsdas_workspaces
  set
    snapshot = target_snapshot,
    revision = next_revision,
    materialized_revision = next_revision,
    schema_version = target_schema_version,
    updated_at = now()
  where id = current_workspace.id;

  insert into public.pjsdas_command_ledger (
    workspace_id,
    user_id,
    command_id,
    operation,
    payload_hash,
    expected_revision,
    principal_kind,
    client_id,
    provenance,
    compensation,
    effective_time,
    status,
    resulting_revision,
    receipt,
    updated_at
  )
  values (
    current_workspace.id,
    target_user_id,
    target_command_id,
    target_operation,
    target_payload_hash,
    target_expected_revision,
    target_principal_kind,
    target_client_id,
    coalesce(target_provenance, '{}'::jsonb),
    target_compensation,
    target_effective_time,
    'COMMITTED',
    next_revision,
    next_receipt,
    now()
  );

  outcome := 'COMMITTED';
  workspace_id := current_workspace.id;
  revision := next_revision;
  snapshot := target_snapshot;
  receipt := next_receipt;
  return next;
end
$$;

-- Original body: 20261025065403_commit_workspace_metadata_only.sql
create or replace function public.pjsdas_commit_workspace_v3(
  target_user_id uuid,
  target_command_id text,
  target_operation text,
  target_payload_hash text,
  target_expected_revision bigint,
  target_snapshot jsonb,
  target_schema_version integer,
  target_principal_kind text,
  target_client_id text,
  target_provenance jsonb,
  target_compensation jsonb,
  target_effective_time timestamptz,
  target_receipt_context jsonb
)
returns table (
  outcome text,
  workspace_id uuid,
  revision bigint,
  receipt jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_workspace public.pjsdas_workspaces%rowtype;
  existing_command public.pjsdas_command_ledger%rowtype;
  next_revision bigint;
  next_receipt jsonb;
begin
  if target_user_id is null
    or nullif(trim(target_command_id), '') is null
    or nullif(trim(target_operation), '') is null
    or nullif(trim(target_payload_hash), '') is null
    or target_snapshot is null
    or nullif(trim(target_principal_kind), '') is null then
    raise exception 'PJSDAS v2 commit arguments are incomplete.' using errcode = '22023';
  end if;

  select * into current_workspace
  from public.pjsdas_workspaces
  where user_id = target_user_id
  for update;

  if not found then
    raise exception 'PJSDAS connected workspace does not exist.' using errcode = 'P0001';
  end if;

  select * into existing_command
  from public.pjsdas_command_ledger
  where user_id = target_user_id
    and command_id = target_command_id;

  if found then
    if existing_command.payload_hash <> target_payload_hash then
      raise exception 'PJSDAS command id was reused with a different payload.' using errcode = '23505';
    end if;

    outcome := 'ALREADY_APPLIED';
    workspace_id := existing_command.workspace_id;
    revision := current_workspace.revision;
    receipt := existing_command.receipt;
    return next;
    return;
  end if;

  if target_expected_revision is null or current_workspace.revision <> target_expected_revision then
    outcome := 'CONFLICT';
    workspace_id := current_workspace.id;
    revision := current_workspace.revision;
    receipt := coalesce(target_receipt_context, '{}'::jsonb) || jsonb_build_object(
      'commandId', target_command_id,
      'receiptId', 'command-receipt:' || target_command_id,
      'status', 'CONFLICT',
      'expectedRevision', target_expected_revision,
      'actualRevision', current_workspace.revision
    );
    return next;
    return;
  end if;

  -- Metadata-only callers echo their submitted snapshot. Reject an unaware old
  -- client rather than committing a different snapshot behind its response.
  if public.pjsdas_merge_empty_gmail_runs_v1(target_user_id,current_workspace.snapshot,
      current_workspace.materialized_revision,current_workspace.revision,target_snapshot,false) is distinct from target_snapshot then
    raise exception 'Read the logical workspace before a metadata-only commit.' using errcode='40001';
  end if;

  next_revision := current_workspace.revision + 1;
  next_receipt := coalesce(target_receipt_context, '{}'::jsonb) || jsonb_build_object(
    'commandId', target_command_id,
    'receiptId', 'command-receipt:' || target_command_id,
    'status', 'COMMITTED',
    'operation', target_operation,
    'revision', next_revision,
    'committedAt', now(),
    'undoAvailable', target_compensation is not null
  );

  update public.pjsdas_workspaces
  set
    snapshot = target_snapshot,
    revision = next_revision,
    materialized_revision = next_revision,
    schema_version = target_schema_version,
    updated_at = now()
  where id = current_workspace.id;

  insert into public.pjsdas_command_ledger (
    workspace_id,
    user_id,
    command_id,
    operation,
    payload_hash,
    expected_revision,
    principal_kind,
    client_id,
    provenance,
    compensation,
    effective_time,
    status,
    resulting_revision,
    receipt,
    updated_at
  )
  values (
    current_workspace.id,
    target_user_id,
    target_command_id,
    target_operation,
    target_payload_hash,
    target_expected_revision,
    target_principal_kind,
    target_client_id,
    coalesce(target_provenance, '{}'::jsonb),
    target_compensation,
    target_effective_time,
    'COMMITTED',
    next_revision,
    next_receipt,
    now()
  );

  outcome := 'COMMITTED';
  workspace_id := current_workspace.id;
  revision := next_revision;
  receipt := next_receipt;
  return next;
end
$$;

create or replace function public.pjsdas_bootstrap_workspace(
  target_user_id uuid,
  initial_snapshot jsonb,
  initial_schema_version integer,
  initial_source_fingerprint text default null,
  initial_migrated_from text default null
)
returns table (
  outcome text,
  workspace_id uuid,
  revision bigint,
  snapshot jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.pjsdas_workspaces%rowtype;
begin
  if target_user_id is null or initial_snapshot is null then
    raise exception 'PJSDAS bootstrap requires user and snapshot.' using errcode = '22023';
  end if;

  insert into public.pjsdas_workspaces (
    user_id, snapshot, revision, schema_version, migrated_from, source_fingerprint
  )
  values (
    target_user_id,
    initial_snapshot,
    0,
    initial_schema_version,
    initial_migrated_from,
    initial_source_fingerprint
  )
  on conflict (user_id) do nothing;

  select * into existing
  from public.pjsdas_workspaces
  where user_id = target_user_id;

  if not found then
    raise exception 'PJSDAS workspace bootstrap failed.' using errcode = 'P0001';
  end if;

  outcome := case when existing.revision = 0 and existing.snapshot = initial_snapshot then 'CREATED_OR_MATCHED' else 'EXISTS' end;
  workspace_id := existing.id;
  revision := existing.revision;
  snapshot := public.pjsdas_logical_workspace_snapshot_v1(existing);
  return next;
end
$$;

-- Original guard body: 20261002195807_planning_management_v4.sql
create or replace function public.pjsdas_commit_planning_workspace_v1(
  target_user_id uuid,
  target_command_id text,
  target_operation text,
  target_payload_hash text,
  target_expected_revision bigint,
  target_snapshot jsonb,
  target_schema_version integer,
  target_principal_kind text,
  target_client_id text,
  target_provenance jsonb,
  target_compensation jsonb,
  target_effective_time timestamptz,
  target_receipt_context jsonb,
  target_grant_id uuid,
  target_grant_revision bigint
)
returns table (outcome text, workspace_id uuid, revision bigint, snapshot jsonb, receipt jsonb)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  active_grant public.pjsdas_business_management_grants%rowtype;
  stored_workspace public.pjsdas_workspaces%rowtype;
  stored_timeline jsonb;
  proposed_timeline jsonb;
begin
  if target_principal_kind <> 'delegated_mcp' or target_principal_kind is null
    or nullif(trim(target_client_id), '') is null
    or target_grant_id is null or target_grant_revision is null then
    raise exception 'Management authorization is required.' using errcode = '42501';
  end if;

  -- This lock and the workspace/ledger mutation share ONE database transaction.
  -- A concurrent UPDATE/DELETE that revokes this row must serialize with commit.
  select g.* into active_grant
    from public.pjsdas_business_management_grants g
    where g.id = target_grant_id
      and g.user_id = target_user_id
      and g.client_id::text = target_client_id
      and g.capability = 'workspace.planning.manage'
      and g.consent_version = 4
      and g.revision = target_grant_revision
      and g.revoked_at is null
      and g.granted_at <= now()
    for share;
  if not found then
    raise exception 'Management grant is absent, revoked, replaced or stale.' using errcode = '42501';
  end if;

  if target_operation = 'undo_command' then
    perform 1 from public.pjsdas_command_ledger
      where user_id = target_user_id
        and command_id = target_provenance ->> 'undoOf'
        and operation = 'planning_management'
        and status = 'COMMITTED';
    if not found then
      raise exception 'Management undo target was not found.' using errcode = '42501';
    end if;
  elsif target_operation is distinct from 'planning_management' then
    raise exception 'Unsupported management operation.' using errcode = '42501';
  end if;

  -- Whole-row planning writes may not persist normalization side effects from
  -- read/upgrade paths. Compare the protected stored data under the same CAS
  -- transaction before delegating. A stale CAS is handled by the base RPC.
  select * into stored_workspace from public.pjsdas_workspaces
    where user_id = target_user_id for update;
  if stored_workspace.id is not null and stored_workspace.revision=target_expected_revision then
    target_snapshot := public.pjsdas_merge_empty_gmail_runs_v1(target_user_id,stored_workspace.snapshot,
      stored_workspace.materialized_revision,stored_workspace.revision,target_snapshot,false);
    stored_workspace.snapshot := public.pjsdas_logical_workspace_snapshot_v1(stored_workspace);
  end if;

  if found and stored_workspace.revision = target_expected_revision then
    if ((target_snapshot -> 'data') - array['decisionRules','timePlanning','timeline'])
      is distinct from ((stored_workspace.snapshot -> 'data') - array['decisionRules','timePlanning','timeline']) then
      raise exception 'Planning management cannot rewrite other business data.' using errcode = '42501';
    end if;
    stored_timeline := coalesce(stored_workspace.snapshot -> 'data' -> 'timeline', '[]'::jsonb);
    proposed_timeline := coalesce(target_snapshot -> 'data' -> 'timeline', '[]'::jsonb);
    if jsonb_typeof(proposed_timeline) is distinct from 'array'
      or jsonb_array_length(proposed_timeline) < jsonb_array_length(stored_timeline)
      or exists (select 1 from jsonb_array_elements(stored_timeline) with ordinality old_event(value, position)
        where proposed_timeline -> ((old_event.position - 1)::int) is distinct from old_event.value) then
      raise exception 'Planning management cannot rewrite existing audit history.' using errcode = '42501';
    end if;
  end if;

  return query select * from public.pjsdas_commit_workspace_v2(
    target_user_id, target_command_id, target_operation, target_payload_hash,
    target_expected_revision, target_snapshot, target_schema_version,
    target_principal_kind, target_client_id, target_provenance,
    target_compensation, target_effective_time,
    coalesce(target_receipt_context, '{}'::jsonb) || jsonb_build_object(
      'managementAuthorization', jsonb_build_object(
        'grantId', active_grant.id, 'grantRevision', active_grant.revision,
        'consentVersion', active_grant.consent_version
      )
    )
  );
end
$$;

-- Original guard body: 20261002211312_discovery_profile_management_v5.sql
create or replace function public.pjsdas_commit_discovery_profile_workspace_v1(
  target_user_id uuid,
  target_command_id text,
  target_operation text,
  target_payload_hash text,
  target_expected_revision bigint,
  target_snapshot jsonb,
  target_schema_version integer,
  target_principal_kind text,
  target_client_id text,
  target_provenance jsonb,
  target_compensation jsonb,
  target_effective_time timestamptz,
  target_receipt_context jsonb,
  target_grant_id uuid,
  target_grant_revision bigint
)
returns table (outcome text, workspace_id uuid, revision bigint, snapshot jsonb, receipt jsonb)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  active_grant public.pjsdas_business_management_grants%rowtype;
  stored_workspace public.pjsdas_workspaces%rowtype;
  stored_timeline jsonb;
  proposed_timeline jsonb;
begin
  if target_principal_kind <> 'delegated_mcp' or target_principal_kind is null
    or nullif(trim(target_client_id), '') is null
    or target_grant_id is null or target_grant_revision is null then
    raise exception 'Management authorization is required.' using errcode = '42501';
  end if;

  -- This lock and the workspace/ledger mutation share ONE database transaction.
  -- A concurrent UPDATE/DELETE that revokes this row must serialize with commit.
  select g.* into active_grant
    from public.pjsdas_business_management_grants g
    where g.id = target_grant_id
      and g.user_id = target_user_id
      and g.client_id::text = target_client_id
      and g.capability = 'workspace.discovery-profile.manage'
      and g.consent_version = 5
      and g.revision = target_grant_revision
      and g.revoked_at is null
      and g.granted_at <= now()
    for share;
  if not found then
    raise exception 'Management grant is absent, revoked, replaced or stale.' using errcode = '42501';
  end if;

  if target_operation = 'undo_command' then
    perform 1 from public.pjsdas_command_ledger
      where user_id = target_user_id
        and command_id = target_provenance ->> 'undoOf'
        and operation = 'discovery_profile_management'
        and status = 'COMMITTED';
    if not found then
      raise exception 'Management undo target was not found.' using errcode = '42501';
    end if;
  elsif target_operation is distinct from 'discovery_profile_management' then
    raise exception 'Unsupported management operation.' using errcode = '42501';
  end if;

  -- Whole-row profile writes may not persist normalization side effects from
  -- read/upgrade paths. Compare the protected stored data under the same CAS
  -- transaction before delegating. A stale CAS is handled by the base RPC.
  select * into stored_workspace from public.pjsdas_workspaces
    where user_id = target_user_id for update;
  if stored_workspace.id is not null and stored_workspace.revision=target_expected_revision then
    target_snapshot := public.pjsdas_merge_empty_gmail_runs_v1(target_user_id,stored_workspace.snapshot,
      stored_workspace.materialized_revision,stored_workspace.revision,target_snapshot,false);
    stored_workspace.snapshot := public.pjsdas_logical_workspace_snapshot_v1(stored_workspace);
  end if;

  if found and stored_workspace.revision = target_expected_revision then
    if ((target_snapshot -> 'data') - array['discoveryProfile','timeline'])
      is distinct from ((stored_workspace.snapshot -> 'data') - array['discoveryProfile','timeline']) then
      raise exception 'Discovery-profile management cannot rewrite other business data.' using errcode = '42501';
    end if;
    stored_timeline := coalesce(stored_workspace.snapshot -> 'data' -> 'timeline', '[]'::jsonb);
    proposed_timeline := coalesce(target_snapshot -> 'data' -> 'timeline', '[]'::jsonb);
    if jsonb_typeof(proposed_timeline) is distinct from 'array'
      or jsonb_array_length(proposed_timeline) < jsonb_array_length(stored_timeline)
      or exists (select 1 from jsonb_array_elements(stored_timeline) with ordinality old_event(value, position)
        where proposed_timeline -> ((old_event.position - 1)::int) is distinct from old_event.value) then
      raise exception 'Discovery-profile management cannot rewrite existing audit history.' using errcode = '42501';
    end if;
  end if;

  return query select * from public.pjsdas_commit_workspace_v2(
    target_user_id, target_command_id, target_operation, target_payload_hash,
    target_expected_revision, target_snapshot, target_schema_version,
    target_principal_kind, target_client_id, target_provenance,
    target_compensation, target_effective_time,
    coalesce(target_receipt_context, '{}'::jsonb) || jsonb_build_object(
      'managementAuthorization', jsonb_build_object(
        'grantId', active_grant.id, 'grantRevision', active_grant.revision,
        'consentVersion', active_grant.consent_version
      )
    )
  );
end
$$;

-- Original guard body: 20261002220516_private_reminder_management_v6.sql
create or replace function public.pjsdas_commit_private_reminder_workspace_v1(
  target_user_id uuid,
  target_command_id text,
  target_operation text,
  target_payload_hash text,
  target_expected_revision bigint,
  target_snapshot jsonb,
  target_schema_version integer,
  target_principal_kind text,
  target_client_id text,
  target_provenance jsonb,
  target_compensation jsonb,
  target_effective_time timestamptz,
  target_receipt_context jsonb,
  target_grant_id uuid,
  target_grant_revision bigint
)
returns table (outcome text, workspace_id uuid, revision bigint, snapshot jsonb, receipt jsonb)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  active_grant public.pjsdas_business_management_grants%rowtype;
  stored_workspace public.pjsdas_workspaces%rowtype;
  stored_timeline jsonb;
  proposed_timeline jsonb;
  old_reminders jsonb;
  new_reminders jsonb;
  protected_before jsonb;
  protected_after jsonb;
  candidate jsonb;
  target_node jsonb;
begin
  if target_principal_kind <> 'delegated_mcp' or target_principal_kind is null
    or nullif(trim(target_client_id), '') is null
    or target_grant_id is null or target_grant_revision is null then
    raise exception 'Management authorization is required.' using errcode = '42501';
  end if;

  -- This lock and the workspace/ledger mutation share ONE database transaction.
  -- A concurrent UPDATE/DELETE that revokes this row must serialize with commit.
  select g.* into active_grant
    from public.pjsdas_business_management_grants g
    where g.id = target_grant_id
      and g.user_id = target_user_id
      and g.client_id::text = target_client_id
      and g.capability = 'workspace.reminders.manage'
      and g.consent_version = 6
      and g.revision = target_grant_revision
      and g.revoked_at is null
      and g.granted_at <= now()
    for share;
  if not found then
    raise exception 'Management grant is absent, revoked, replaced or stale.' using errcode = '42501';
  end if;

  if target_operation = 'undo_command' then
    perform 1 from public.pjsdas_command_ledger
      where user_id = target_user_id
        and command_id = target_provenance ->> 'undoOf'
        and operation = 'private_reminder_management'
        and status = 'COMMITTED';
    if not found then
      raise exception 'Management undo target was not found.' using errcode = '42501';
    end if;
  elsif target_operation is distinct from 'private_reminder_management' then
    raise exception 'Unsupported management operation.' using errcode = '42501';
  end if;

  -- Whole-row reminder writes may not persist normalization side effects from
  -- read/upgrade paths. Compare the protected stored data under the same CAS
  -- transaction before delegating. A stale CAS is handled by the base RPC.
  select * into stored_workspace from public.pjsdas_workspaces
    where user_id = target_user_id for update;
  if stored_workspace.id is not null and stored_workspace.revision=target_expected_revision then
    target_snapshot := public.pjsdas_merge_empty_gmail_runs_v1(target_user_id,stored_workspace.snapshot,
      stored_workspace.materialized_revision,stored_workspace.revision,target_snapshot,false);
    stored_workspace.snapshot := public.pjsdas_logical_workspace_snapshot_v1(stored_workspace);
  end if;

  if found and stored_workspace.revision = target_expected_revision then
    if ((target_snapshot -> 'data') - array['reminderIntents','timeline'])
      is distinct from ((stored_workspace.snapshot -> 'data') - array['reminderIntents','timeline']) then
      raise exception 'Private reminder management cannot rewrite other business data.' using errcode = '42501';
    end if;
    old_reminders := stored_workspace.snapshot -> 'data' -> 'reminderIntents';
    new_reminders := target_snapshot -> 'data' -> 'reminderIntents';
    if jsonb_typeof(old_reminders) is distinct from 'array' or jsonb_typeof(new_reminders) is distinct from 'array' then
      raise exception 'Private reminder data requires an explicit snapshot migration.' using errcode = '42501';
    end if;

    if exists (select 1 from jsonb_array_elements(new_reminders) r
        where jsonb_typeof(r -> 'id') is distinct from 'string' or nullif(btrim(r ->> 'id'), '') is null)
      or (select count(*) from jsonb_array_elements(new_reminders))
        <> (select count(distinct r ->> 'id') from jsonb_array_elements(new_reminders) r) then
      raise exception 'Reminder identities must remain unique and nonblank.' using errcode = '42501';
    end if;

    -- Preserve all external, outbox-linked and unclassifiable rows exactly and
    -- in their relative order. JSON null fields are not absent capabilities.
    select coalesce(jsonb_agg(item order by position), '[]'::jsonb) into protected_before
      from jsonb_array_elements(old_reminders) with ordinality r(item, position)
      where (item ->> 'deliveryOwner' = 'pjsdas' and item ->> 'channel' = 'in_product'
        and not (item ? 'capability') and not (item ? 'externalLink')
        and not exists (select 1 from jsonb_array_elements(stored_workspace.snapshot -> 'data' -> 'reminderOutbox') o
          where o ->> 'reminderIntentId' = item ->> 'id')) is not true;
    select coalesce(jsonb_agg(item order by position), '[]'::jsonb) into protected_after
      from jsonb_array_elements(new_reminders) with ordinality r(item, position)
      where (item ->> 'deliveryOwner' = 'pjsdas' and item ->> 'channel' = 'in_product'
        and not (item ? 'capability') and not (item ? 'externalLink')
        and not exists (select 1 from jsonb_array_elements(stored_workspace.snapshot -> 'data' -> 'reminderOutbox') o
          where o ->> 'reminderIntentId' = item ->> 'id')) is not true;
    if protected_before is distinct from protected_after then
      raise exception 'External or outbox-linked reminders cannot be changed by private management.' using errcode = '42501';
    end if;

    for candidate in select value from jsonb_array_elements(new_reminders) loop
      if exists (select 1 from jsonb_array_elements(old_reminders) old_row where old_row = candidate) then continue; end if;
      -- Every changed/new row must remain private; protected rows were compared above.
      if (candidate ->> 'deliveryOwner' = 'pjsdas' and candidate ->> 'channel' = 'in_product'
        and not (candidate ? 'capability') and not (candidate ? 'externalLink')) is not true then
        raise exception 'Only private in-product reminders are writable.' using errcode = '42501';
      end if;
      select node into target_node from jsonb_array_elements(stored_workspace.snapshot -> 'data' -> 'scheduleNodes') node
        where node ->> 'id' = candidate ->> 'scheduleNodeId';
      if not found or candidate -> 'scheduleNodeVersion' is distinct from target_node -> 'version'
        or candidate ->> 'dedupeKey' is distinct from ((target_node ->> 'id') || '@' || (target_node ->> 'version') || '|' || (candidate ->> 'purpose')) then
        raise exception 'Reminder target identity is stale or inconsistent.' using errcode = '42501';
      end if;
      if candidate ->> 'state' = 'active' then
        if (target_node ->> 'state' in ('scheduled','in_progress','elapsed_unresolved')) is not true
          or exists (select 1 from jsonb_array_elements(stored_workspace.snapshot -> 'data' -> 'scheduleNodes') newer
            where newer ->> 'occurrenceId' = target_node ->> 'occurrenceId'
              and (newer ->> 'version')::bigint > (target_node ->> 'version')::bigint)
          or exists (select 1 from jsonb_array_elements(new_reminders) other
            where other ->> 'id' is distinct from candidate ->> 'id'
              and (other ->> 'dedupeKey' = candidate ->> 'dedupeKey'
                or other ->> 'scheduleNodeId' = candidate ->> 'scheduleNodeId' and other ->> 'purpose' = candidate ->> 'purpose')) then
          raise exception 'Reminder activation conflicts with its target or another delivery owner.' using errcode = '42501';
        end if;
      end if;
    end loop;

    stored_timeline := coalesce(stored_workspace.snapshot -> 'data' -> 'timeline', '[]'::jsonb);
    proposed_timeline := coalesce(target_snapshot -> 'data' -> 'timeline', '[]'::jsonb);
    if jsonb_typeof(proposed_timeline) is distinct from 'array'
      or jsonb_array_length(proposed_timeline) < jsonb_array_length(stored_timeline)
      or exists (select 1 from jsonb_array_elements(stored_timeline) with ordinality old_event(value, position)
        where proposed_timeline -> ((old_event.position - 1)::int) is distinct from old_event.value) then
      raise exception 'Private reminder management cannot rewrite existing audit history.' using errcode = '42501';
    end if;
  end if;

  return query select * from public.pjsdas_commit_workspace_v2(
    target_user_id, target_command_id, target_operation, target_payload_hash,
    target_expected_revision, target_snapshot, target_schema_version,
    target_principal_kind, target_client_id, target_provenance,
    target_compensation, target_effective_time,
    coalesce(target_receipt_context, '{}'::jsonb) || jsonb_build_object(
      'managementAuthorization', jsonb_build_object(
        'grantId', active_grant.id, 'grantRevision', active_grant.revision,
        'consentVersion', active_grant.consent_version
      )
    )
  );
end
$$;

-- Original guard body: 20261002234255_opportunity_management_raw_boundary.sql
create or replace function public.pjsdas_commit_opportunity_workspace_v1(
  target_user_id uuid,
  target_command_id text,
  target_operation text,
  target_payload_hash text,
  target_expected_revision bigint,
  target_snapshot jsonb,
  target_schema_version integer,
  target_principal_kind text,
  target_client_id text,
  target_provenance jsonb,
  target_compensation jsonb,
  target_effective_time timestamptz,
  target_receipt_context jsonb,
  target_grant_id uuid,
  target_grant_revision bigint
)
returns table (outcome text, workspace_id uuid, revision bigint, snapshot jsonb, receipt jsonb)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  active_grant public.pjsdas_business_management_grants%rowtype;
  stored_workspace public.pjsdas_workspaces%rowtype;
  evidence jsonb; changes jsonb; archives jsonb;
  old_history jsonb; new_history jsonb; old_rows jsonb; new_rows jsonb;
  retained_old jsonb; retained_new jsonb; expected_rows jsonb; change jsonb;
  before_row jsonb; after_row jsonb; current_row jsonb; proposed_row jsonb;
  kind text; collection text; row_index integer;
begin
  if target_principal_kind <> 'delegated_mcp' or target_principal_kind is null
    or nullif(trim(target_client_id), '') is null
    or target_grant_id is null or target_grant_revision is null then
    raise exception 'Management authorization is required.' using errcode = '42501';
  end if;

  -- This lock and the workspace/ledger mutation share ONE database transaction.
  -- A concurrent UPDATE/DELETE that revokes this row must serialize with commit.
  select g.* into active_grant
    from public.pjsdas_business_management_grants g
    where g.id = target_grant_id
      and g.user_id = target_user_id
      and g.client_id::text = target_client_id
      and g.capability = 'workspace.opportunity.manage'
      and g.consent_version = 3
      and g.revision = target_grant_revision
      and g.revoked_at is null
      and g.granted_at <= now()
    for share;
  if not found then
    raise exception 'Management grant is absent, revoked, replaced or stale.' using errcode = '42501';
  end if;

  if target_operation = 'undo_command' then
    perform 1 from public.pjsdas_command_ledger
      where user_id = target_user_id
        and command_id = target_provenance ->> 'undoOf'
        and operation = 'opportunity_management'
        and status = 'COMMITTED';
    if not found then
      raise exception 'Management undo target was not found.' using errcode = '42501';
    end if;
  elsif target_operation is distinct from 'opportunity_management' then
    raise exception 'Unsupported management operation.' using errcode = '42501';
  end if;

  -- Validate against the current row while holding the same lock as CAS. A
  -- stale request goes to the base RPC's conflict path, never writes this data.
  select * into stored_workspace from public.pjsdas_workspaces where user_id = target_user_id for update;
  if stored_workspace.id is not null and stored_workspace.revision=target_expected_revision then
    target_snapshot := public.pjsdas_merge_empty_gmail_runs_v1(target_user_id,stored_workspace.snapshot,
      stored_workspace.materialized_revision,stored_workspace.revision,target_snapshot,false);
    stored_workspace.snapshot := public.pjsdas_logical_workspace_snapshot_v1(stored_workspace);
  end if;

  if found and stored_workspace.revision = target_expected_revision then
    if (target_snapshot - array['data','version','exportedAt']) is distinct from (stored_workspace.snapshot - array['data','version','exportedAt'])
      or ((target_snapshot -> 'data') - array['opportunities','processes','processEvents','actions','scheduleNodes','reminderIntents','timeline'])
        is distinct from ((stored_workspace.snapshot -> 'data') - array['opportunities','processes','processEvents','actions','scheduleNodes','reminderIntents','timeline']) then
      raise exception 'Opportunity management cannot rewrite unrelated raw data.' using errcode = '42501';
    end if;
    old_history := coalesce(stored_workspace.snapshot #> '{data,timeline}', '[]'::jsonb);
    new_history := coalesce(target_snapshot #> '{data,timeline}', '[]'::jsonb);
    if jsonb_typeof(old_history) is distinct from 'array' or jsonb_typeof(new_history) is distinct from 'array'
      or jsonb_array_length(new_history) < jsonb_array_length(old_history)
      or exists(select 1 from jsonb_array_elements(old_history) with ordinality e(value,n) where new_history -> ((e.n-1)::int) is distinct from e.value) then
      raise exception 'Opportunity management cannot rewrite existing audit history.' using errcode = '42501';
    end if;
    if target_operation = 'undo_command' then
      select l.compensation into evidence from public.pjsdas_command_ledger l
        where l.user_id=target_user_id and l.command_id=target_provenance->>'undoOf'
          and l.operation='opportunity_management' and l.status='COMMITTED';
    else evidence := target_compensation;
    end if;
    -- The direct RPC independently enforces the same compact 1 MiB ceiling.
    changes := coalesce(evidence #> '{payload,changes}', '[]'::jsonb);
    archives := coalesce(evidence #> '{payload,archives}', '[]'::jsonb);
    if jsonb_typeof(changes) is distinct from 'array' or jsonb_typeof(archives) is distinct from 'array'
      or jsonb_array_length(changes)>2500 or (evidence is not null and public.pjsdas_opportunity_evidence_bytes_v1(evidence)>1048576)
      or (jsonb_array_length(changes)>0 and evidence->>'operation' is distinct from 'opportunity_management_restore')
      or exists(select 1 from jsonb_array_elements(changes) c where jsonb_typeof(c->'type') is distinct from 'string' or c->>'type' not in ('opportunity','process','process_event','action','schedule_node','reminder_intent') or nullif(trim(c->>'id'),'') is null)
      or jsonb_array_length(archives)>20
      or exists(select 1 from jsonb_array_elements(archives) a where jsonb_typeof(a) is distinct from 'string'
        or not exists(select 1 from jsonb_array_elements(changes) c where c->>'type'='opportunity' and c->>'id'=a#>>'{}' and c->'after'='null'::jsonb))
      or (select count(*) from jsonb_array_elements(archives))<>(select count(distinct a) from jsonb_array_elements(archives) a)
      or (select count(*) from jsonb_array_elements(changes))<>(select count(distinct (c->>'type',c->>'id')) from jsonb_array_elements(changes) c) then
      raise exception 'Opportunity change evidence is invalid.' using errcode = '42501';
    end if;
    if target_operation='undo_command' then
      for change in select g from jsonb_array_elements(coalesce(evidence#>'{payload,guards}','[]'::jsonb)) g loop
        if change->>'type'='application_group' then
          select g into current_row from jsonb_array_elements(coalesce(stored_workspace.snapshot#>'{data,applicationGroups}','[]'::jsonb)) g where g->>'id'=change->>'id';
        elsif change->>'type'='decision_rules' and change->>'id'='current' then
          current_row:=coalesce(stored_workspace.snapshot#>'{data,decisionRules}','null'::jsonb);
        else raise exception 'Opportunity restore guard is invalid.' using errcode='42501';
        end if;
        if current_row is distinct from change->'value' then
          raise exception 'Opportunity restore parent or rules changed.' using errcode='42501';
        end if;
      end loop;
      -- A new dependency arriving after archive must not be adopted by undo,
      -- even if a caller preserves that new row in the proposed snapshot.
      if exists(select 1 from jsonb_array_elements(
          (stored_workspace.snapshot#>'{data,processes}') || (stored_workspace.snapshot#>'{data,processEvents}') || (stored_workspace.snapshot#>'{data,actions}') || (stored_workspace.snapshot#>'{data,scheduleNodes}') || (stored_workspace.snapshot#>'{data,reminderIntents}')
        ) r where coalesce(archives ? (r->>'opportunityId'),false)
          or exists(select 1 from jsonb_array_elements(changes) c where c->'after'='null'::jsonb and (
            (c->>'type'='process' and r->>'processId'=c->>'id')
            or (c->>'type'='process_event' and (r->>'processEventId'=c->>'id' or r->>'effectiveProcessEventId'=c->>'id'))
            or (c->>'type'='action' and coalesce(r->'relatedActionIds','[]'::jsonb) ? (c->>'id'))
            or (c->>'type'='schedule_node' and (r->>'scheduleNodeId'=c->>'id' or r->>'occurrenceId'=c#>>'{before,occurrenceId}'))
          ))) then raise exception 'New archive dependencies require reconciliation before restore.' using errcode='42501';
      end if;
    end if;
    for kind, collection in select * from (values ('opportunity','opportunities'),('process','processes'),('process_event','processEvents'),('action','actions'),('schedule_node','scheduleNodes'),('reminder_intent','reminderIntents')) pairs(kind,collection) loop
      old_rows := stored_workspace.snapshot -> 'data' -> collection;
      new_rows := target_snapshot -> 'data' -> collection;
      if jsonb_typeof(old_rows) is distinct from 'array' or jsonb_typeof(new_rows) is distinct from 'array'
        or exists(select 1 from jsonb_array_elements(old_rows || new_rows) r where jsonb_typeof(r->'id') is distinct from 'string' or nullif(trim(r->>'id'),'') is null)
        or (select count(*) from jsonb_array_elements(old_rows))<>(select count(distinct r->>'id') from jsonb_array_elements(old_rows) r)
        or (select count(*) from jsonb_array_elements(new_rows))<>(select count(distinct r->>'id') from jsonb_array_elements(new_rows) r) then
        raise exception 'Opportunity collections need exact unique identities.' using errcode = '42501';
      end if;
      if target_operation='opportunity_management' then
        select coalesce(jsonb_agg(coalesce(c.value->'after',r.value) order by r.n),'[]'::jsonb) into expected_rows
          from jsonb_array_elements(old_rows) with ordinality r(value,n)
          left join lateral (select value from jsonb_array_elements(changes) e(value) where e.value->>'type'=kind and e.value->>'id'=r.value->>'id') c on true
          where c.value is null or c.value->'after' is distinct from 'null'::jsonb;
        if expected_rows is distinct from new_rows then
          raise exception 'Opportunity edits must preserve exact retained row ordering.' using errcode = '42501';
        end if;
      end if;
      if target_operation='undo_command' then
        expected_rows:=old_rows;
        for change in select c from jsonb_array_elements(changes) c where c->>'type'=kind order by (c->>'beforeIndex')::numeric loop
          if jsonb_typeof(change->'beforeIndex') is distinct from 'number' or (change->>'beforeIndex')::numeric<0 or trunc((change->>'beforeIndex')::numeric)<>(change->>'beforeIndex')::numeric then
            raise exception 'Opportunity restore index is invalid.' using errcode='42501';
          end if;
          select (r.n-1)::int into row_index from jsonb_array_elements(expected_rows) with ordinality r(value,n) where r.value->>'id'=change->>'id';
          if found then expected_rows:=jsonb_set(expected_rows,array[row_index::text],change->'before');
          else expected_rows:=jsonb_insert(expected_rows,array[least(jsonb_array_length(expected_rows)::numeric,(change->>'beforeIndex')::numeric)::text],change->'before');
          end if;
        end loop;
        if expected_rows is distinct from new_rows then
          raise exception 'Opportunity restore must preserve exact retained row ordering.' using errcode='42501';
        end if;
      end if;
      -- Retained rows, metadata and relative ordering must be byte-semantic equal.
      select coalesce(jsonb_agg(r.value order by r.n),'[]'::jsonb) into retained_old from jsonb_array_elements(old_rows) with ordinality r(value,n)
        where not exists(select 1 from jsonb_array_elements(changes) c where c->>'type'=kind and c->>'id'=r.value->>'id');
      select coalesce(jsonb_agg(r.value order by r.n),'[]'::jsonb) into retained_new from jsonb_array_elements(new_rows) with ordinality r(value,n)
        where not exists(select 1 from jsonb_array_elements(changes) c where c->>'type'=kind and c->>'id'=r.value->>'id');
      if retained_old is distinct from retained_new then
        raise exception 'Opportunity management cannot rewrite unselected rows.' using errcode = '42501';
      end if;
      for change in select c from jsonb_array_elements(changes) c where c->>'type'=kind loop
        before_row := change->'before'; after_row := change->'after';
        if not change ? 'after' or jsonb_typeof(before_row) is distinct from 'object' or before_row->>'id' is distinct from change->>'id'
          or (after_row is distinct from 'null'::jsonb and (jsonb_typeof(after_row) is distinct from 'object' or after_row->>'id' is distinct from change->>'id')) then
          raise exception 'Opportunity row evidence identity is invalid.' using errcode = '42501';
        end if;
        select r into current_row from jsonb_array_elements(old_rows) r where r->>'id'=change->>'id';
        select r into proposed_row from jsonb_array_elements(new_rows) r where r->>'id'=change->>'id';
        if coalesce(current_row,'null'::jsonb) is distinct from (case when target_operation='undo_command' then after_row else before_row end)
          or coalesce(proposed_row,'null'::jsonb) is distinct from (case when target_operation='undo_command' then before_row else after_row end) then
          raise exception 'Opportunity row evidence does not match the locked state.' using errcode = '42501';
        end if;
        if after_row is distinct from 'null'::jsonb then
          if kind<>'opportunity'
            or (before_row-array['roleType','early','prepEstimateMinutes','detail','assessmentStatus','fitScore','opportunityValue']) is distinct from (after_row-array['roleType','early','prepEstimateMinutes','detail','assessmentStatus','fitScore','opportunityValue'])
            or (coalesce(before_row->'detail','{}'::jsonb)-array['backgroundTag','coreOutput','workMode','candidateProfile','jdSummary','gap','intensity','earlyReason','rules','userFacts','assessment']) is distinct from (coalesce(after_row->'detail','{}'::jsonb)-array['backgroundTag','coreOutput','workMode','candidateProfile','jdSummary','gap','intensity','earlyReason','rules','userFacts','assessment'])
            or (coalesce(before_row#>'{detail,userFacts}','{}'::jsonb)-array['location','compensationText','applicationUrl','updatedAt','provenance']) is distinct from (coalesce(after_row#>'{detail,userFacts}','{}'::jsonb)-array['location','compensationText','applicationUrl','updatedAt','provenance'])
            or (before_row#>'{detail,userFacts,provenance}' is not null and before_row#>'{detail,userFacts,provenance}' is distinct from after_row#>'{detail,userFacts,provenance}')
            or (coalesce(before_row#>'{detail,assessment}','{}'::jsonb)-array['version','mode','fit','opportunityValue','assessedAt']) is distinct from (coalesce(after_row#>'{detail,assessment}','{}'::jsonb)-array['version','mode','fit','opportunityValue','assessedAt']) then
            raise exception 'Opportunity profile edits cannot rewrite source facts or neighboring objects.' using errcode = '42501';
          end if;
        elsif (kind='opportunity' and not coalesce(archives ? (before_row->>'id'),false))
          or (kind in ('process','process_event') and not coalesce(archives ? (before_row->>'opportunityId'),false))
          or (kind='action' and not (coalesce(archives ? (before_row->>'opportunityId'),false) or exists(select 1 from jsonb_array_elements(changes) c where c->>'type'='process_event' and c->>'id'=before_row->>'processEventId' and c->'after'='null'::jsonb)))
          or (kind='action' and (nullif(before_row->>'prepId','') is not null or nullif(before_row->>'applicationGroupId','') is not null))
          or (kind='schedule_node' and (
            (nullif(before_row->>'opportunityId','') is not null and not coalesce(archives ? (before_row->>'opportunityId'),false))
            or jsonb_array_length(coalesce(before_row->'relatedPrepIds','[]'::jsonb))>0
            or exists(select 1 from jsonb_array_elements_text(coalesce(before_row->'relatedActionIds','[]'::jsonb)) a(id) where not exists(select 1 from jsonb_array_elements(changes) c where c->>'type'='action' and c->>'id'=a.id and c->'after'='null'::jsonb))))
          or (kind='schedule_node' and not exists(
            select 1 from jsonb_array_elements(changes) seed
            where seed->>'type'='schedule_node' and seed->'after'='null'::jsonb
              and seed#>>'{before,occurrenceId}'=before_row->>'occurrenceId'
              and (coalesce(archives ? (seed#>>'{before,opportunityId}'),false)
                or exists(select 1 from jsonb_array_elements(changes) c where c->'after'='null'::jsonb and
                  ((c->>'type'='process' and c->>'id'=seed#>>'{before,processId}')
                  or (c->>'type'='process_event' and c->>'id'=seed#>>'{before,processEventId}')
                  or (c->>'type'='action' and coalesce(seed#>'{before,relatedActionIds}','[]'::jsonb) ? (c->>'id')))))))
          or (kind='reminder_intent' and (before_row->>'deliveryOwner' is distinct from 'pjsdas' or before_row->>'channel' is distinct from 'in_product' or before_row ? 'capability' or before_row ? 'externalLink'
            or not exists(select 1 from jsonb_array_elements(changes) c where c->>'type'='schedule_node' and c->>'id'=before_row->>'scheduleNodeId' and c->'after'='null'::jsonb)
            or exists(select 1 from jsonb_array_elements(coalesce(stored_workspace.snapshot#>'{data,reminderOutbox}','[]'::jsonb)) r where r->>'reminderIntentId'=before_row->>'id'))) then
          raise exception 'Archive evidence includes an unowned or external row.' using errcode = '42501';
        end if;
      end loop;
    end loop;
    if target_operation='opportunity_management' and exists(
      select 1 from jsonb_array_elements(changes) c
      cross join lateral jsonb_array_elements(
        (target_snapshot#>'{data,opportunities}') || (target_snapshot#>'{data,processes}') || (target_snapshot#>'{data,processEvents}') || (target_snapshot#>'{data,actions}') || (target_snapshot#>'{data,scheduleNodes}') || (target_snapshot#>'{data,reminderIntents}')
      ) r
      where c->'after'='null'::jsonb and (
        (c->>'type'='opportunity' and r->>'opportunityId'=c->>'id')
        or (c->>'type'='process' and r->>'processId'=c->>'id')
        or (c->>'type'='process_event' and (r->>'processEventId'=c->>'id' or r->>'effectiveProcessEventId'=c->>'id'))
        or (c->>'type'='action' and coalesce(r->'relatedActionIds','[]'::jsonb) ? (c->>'id'))
        or (c->>'type'='schedule_node' and r->>'scheduleNodeId'=c->>'id')
      )) then
      raise exception 'Archive must retain a complete owned dependency closure.' using errcode = '42501';
    end if;
  end if;

  return query select * from public.pjsdas_commit_workspace_v2(
    target_user_id, target_command_id, target_operation, target_payload_hash,
    target_expected_revision, target_snapshot, target_schema_version,
    target_principal_kind, target_client_id, target_provenance,
    target_compensation, target_effective_time,
    coalesce(target_receipt_context, '{}'::jsonb) || jsonb_build_object(
      'managementAuthorization', jsonb_build_object(
        'grantId', active_grant.id, 'grantRevision', active_grant.revision,
        'consentVersion', active_grant.consent_version
      )
    )
  );
end
$$;

-- Original guard body: 20261003104723_consumer_business_scoped_access.sql
create or replace function public.pjsdas_commit_consumer_business_workspace_v1(
  target_user_id uuid,
  target_command_id text,
  target_operation text,
  target_payload_hash text,
  target_expected_revision bigint,
  target_snapshot jsonb,
  target_schema_version integer,
  target_principal_kind text,
  target_client_id text,
  target_provenance jsonb,
  target_compensation jsonb,
  target_effective_time timestamptz,
  target_receipt_context jsonb,
  target_grant_id uuid,
  target_grant_revision bigint
)
returns table (outcome text, workspace_id uuid, revision bigint, snapshot jsonb, receipt jsonb)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  active_grant public.pjsdas_business_management_grants%rowtype;
  stored_workspace public.pjsdas_workspaces%rowtype;
  evidence jsonb; changes jsonb; change jsonb; kind text; collection text;
  old_rows jsonb; new_rows jsonb; expected_rows jsonb; current_row jsonb;
  before_row jsonb; after_row jsonb; row_index integer; old_history jsonb; new_history jsonb;
begin
  if target_principal_kind <> 'delegated_mcp' or target_principal_kind is null
    or nullif(trim(target_client_id), '') is null
    or target_grant_id is null or target_grant_revision is null then
    raise exception 'Management authorization is required.' using errcode = '42501';
  end if;

  -- This lock and the workspace/ledger mutation share ONE database transaction.
  -- A concurrent UPDATE/DELETE that revokes this row must serialize with commit.
  select g.* into active_grant
    from public.pjsdas_business_management_grants g
    where g.id = target_grant_id
      and g.user_id = target_user_id
      and g.client_id::text = target_client_id
      and g.capability = 'workspace.business.manage'
      and g.consent_version = 7
      and g.consent_text_hash = '22626aea373e4e8eb51a90ee4b548c5f3aeeee4bbe58e77b418a0645138edb34'
      and g.revision = target_grant_revision
      and g.revoked_at is null
      and g.granted_at <= now()
    for share;
  if not found then
    raise exception 'Management grant is absent, revoked, replaced or stale.' using errcode = '42501';
  end if;

  if target_operation = 'undo_command' then
    perform 1 from public.pjsdas_command_ledger l
      where user_id = target_user_id
        and command_id = target_provenance ->> 'undoOf'
        and operation = 'business_management'
        and l.receipt #> '{managementAuthorization,consentVersion}' = '7'::jsonb
        and status = 'COMMITTED';
    if not found then
      raise exception 'Management undo target was not found.' using errcode = '42501';
    end if;
  elsif target_operation is distinct from 'business_management' then
    raise exception 'Unsupported management operation.' using errcode = '42501';
  end if;

  select w.* into stored_workspace from public.pjsdas_workspaces w where w.user_id=target_user_id for update;
  if stored_workspace.id is not null and stored_workspace.revision=target_expected_revision then
    target_snapshot := public.pjsdas_merge_empty_gmail_runs_v1(target_user_id,stored_workspace.snapshot,
      stored_workspace.materialized_revision,stored_workspace.revision,target_snapshot,false);
    stored_workspace.snapshot := public.pjsdas_logical_workspace_snapshot_v1(stored_workspace);
  end if;

  if exists(select 1 from public.pjsdas_command_ledger l where l.user_id=target_user_id and l.command_id=target_command_id and (l.operation is distinct from target_operation or l.receipt#>'{managementAuthorization,consentVersion}' is distinct from '7'::jsonb)) then
    raise exception 'Command id was reused with a different payload or consent family.' using errcode='23505';
  end if;
  if stored_workspace.id is not null and stored_workspace.revision=target_expected_revision then
    if (target_snapshot - array['data','exportedAt']) is distinct from (stored_workspace.snapshot - array['data','exportedAt'])
      or target_schema_version is distinct from stored_workspace.schema_version
      or ((target_snapshot->'data')-array['prep','actions','applicationGroups','timeline']) is distinct from ((stored_workspace.snapshot->'data')-array['prep','actions','applicationGroups','timeline']) then
      raise exception 'Consumer business edits cannot change unrelated raw data.' using errcode='42501';
    end if;
    old_history:=coalesce(stored_workspace.snapshot#>'{data,timeline}','[]'::jsonb);
    new_history:=coalesce(target_snapshot#>'{data,timeline}','[]'::jsonb);
    if jsonb_typeof(old_history) is distinct from 'array' or jsonb_typeof(new_history) is distinct from 'array'
      or jsonb_array_length(new_history)<jsonb_array_length(old_history)
      or exists(select 1 from jsonb_array_elements(old_history) with ordinality e(value,n) where new_history->((e.n-1)::int) is distinct from e.value) then
      raise exception 'Existing audit history must be retained.' using errcode='42501';
    end if;
    if target_operation='undo_command' then
      select l.compensation into evidence from public.pjsdas_command_ledger l where l.user_id=target_user_id and l.command_id=target_provenance->>'undoOf' and l.operation='business_management' and l.status='COMMITTED' and l.receipt#>'{managementAuthorization,consentVersion}'='7'::jsonb;
    else evidence:=target_compensation;end if;
    changes:=evidence#>'{payload,changes}';
    if evidence->>'operation' is distinct from 'business_management_restore' or jsonb_typeof(changes) is distinct from 'array'
      or jsonb_array_length(changes) not between 1 and 50 or public.pjsdas_opportunity_evidence_bytes_v1(evidence)>1048576
      or exists(select 1 from jsonb_array_elements(changes) c where jsonb_typeof(c) is distinct from 'object' or c->>'type' is null or c->>'type' not in ('prep','action','application_group') or nullif(trim(c->>'id'),'') is null)
      or (select count(*) from jsonb_array_elements(changes))<>(select count(distinct(c->>'type',c->>'id')) from jsonb_array_elements(changes) c) then
      raise exception 'Bounded exact business change evidence is required.' using errcode='42501';
    end if;
    for kind,collection in select * from (values('prep','prep'),('action','actions'),('application_group','applicationGroups')) p(kind,collection) loop
      old_rows:=stored_workspace.snapshot->'data'->collection;new_rows:=target_snapshot->'data'->collection;expected_rows:=old_rows;
      if jsonb_typeof(old_rows) is distinct from 'array' or jsonb_typeof(new_rows) is distinct from 'array'
        or exists(select 1 from jsonb_array_elements(old_rows||new_rows) r where jsonb_typeof(r->'id') is distinct from 'string' or nullif(trim(r->>'id'),'') is null)
        or (select count(*) from jsonb_array_elements(old_rows))<>(select count(distinct r->>'id') from jsonb_array_elements(old_rows) r)
        or (select count(*) from jsonb_array_elements(new_rows))<>(select count(distinct r->>'id') from jsonb_array_elements(new_rows) r) then
        raise exception 'Business rows need unique exact identities.' using errcode='42501';
      end if;
      for change in select c.value from jsonb_array_elements(changes) with ordinality c(value,n) where c.value->>'type'=kind order by case when target_operation='undo_command' then (c.value->>'beforeIndex')::numeric else c.n end loop
        before_row:=change->'before';after_row:=change->'after';
        if not(change ?& array['before','after','beforeIndex']) or (before_row='null'::jsonb and after_row='null'::jsonb)
          or (before_row is distinct from 'null'::jsonb and (jsonb_typeof(before_row) is distinct from 'object' or before_row->>'id' is distinct from change->>'id'))
          or (after_row is distinct from 'null'::jsonb and (jsonb_typeof(after_row) is distinct from 'object' or after_row->>'id' is distinct from change->>'id'))
          or jsonb_typeof(change->'beforeIndex') is distinct from 'number' or trunc((change->>'beforeIndex')::numeric)<>(change->>'beforeIndex')::numeric
          or (before_row='null'::jsonb and (change->>'beforeIndex')::numeric<>-1)
          or (before_row is distinct from 'null'::jsonb and (change->>'beforeIndex')::numeric<0) then
          raise exception 'Business before/after evidence is invalid.' using errcode='42501';
        end if;
        current_row:=null;row_index:=null;
        select r.value,(r.n-1)::int into current_row,row_index from jsonb_array_elements(expected_rows) with ordinality r(value,n) where r.value->>'id'=change->>'id';
        if coalesce(current_row,'null'::jsonb) is distinct from (case when target_operation='undo_command' then after_row else before_row end) then
          raise exception 'Business target changed after the observed preimage.' using errcode='42501';
        end if;
        if target_operation='business_management' and before_row is distinct from 'null'::jsonb and old_rows->((change->>'beforeIndex')::int) is distinct from before_row then
          raise exception 'Business original order evidence is invalid.' using errcode='42501';
        end if;
        current_row:=case when target_operation='undo_command' then before_row else after_row end;
        if current_row='null'::jsonb then expected_rows:=expected_rows-row_index;
        elsif row_index is not null then expected_rows:=jsonb_set(expected_rows,array[row_index::text],current_row);
        elsif target_operation='undo_command' then expected_rows:=jsonb_insert(expected_rows,array[least(jsonb_array_length(expected_rows)::numeric,(change->>'beforeIndex')::numeric)::text],current_row);
        else expected_rows:=expected_rows||jsonb_build_array(current_row);end if;
      end loop;
      if expected_rows is distinct from new_rows then raise exception 'Consumer business edits cannot rewrite unselected rows or ordering.' using errcode='42501';end if;
    end loop;
  end if;

  return query select * from public.pjsdas_commit_workspace_v2(
    target_user_id, target_command_id, target_operation, target_payload_hash,
    target_expected_revision, target_snapshot, target_schema_version,
    target_principal_kind, target_client_id, target_provenance,
    target_compensation, target_effective_time,
    coalesce(target_receipt_context, '{}'::jsonb) || jsonb_build_object(
      'managementAuthorization', jsonb_build_object(
        'grantId', active_grant.id, 'grantRevision', active_grant.revision,
        'consentVersion', active_grant.consent_version
      )
    )
  );
end
$$;

-- Original guard body: 20261008164000_discovery_batch_budget_claim.sql
create or replace function public.pjsdas_commit_discovery_workspace_v1(
  target_user_id uuid, target_command_id text, target_operation text, target_payload_hash text,
  target_expected_revision bigint, target_snapshot jsonb, target_schema_version integer,
  target_principal_kind text, target_client_id text, target_provenance jsonb,
  target_compensation jsonb, target_effective_time timestamptz, target_receipt_context jsonb,
  target_discovery_authorization jsonb
)
returns table (outcome text, workspace_id uuid, revision bigint, snapshot jsonb, receipt jsonb)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  active_grant public.pjsdas_authorization_grants%rowtype;
  active_connection public.google_drive_connections%rowtype;
  checkpoint_workspace public.pjsdas_workspaces%rowtype;
  original_claim public.pjsdas_command_ledger%rowtype;
  proof jsonb := target_discovery_authorization;
  trusted_proof jsonb;
  budget_hold jsonb;
  budget_policy jsonb;
  prior_budget_policy jsonb;
  trusted_budget jsonb;
  budget_amount bigint;
  budget_cap bigint;
  held_total numeric;
  budget_admitted boolean;
  budget_starts_at timestamptz;
  budget_expires_at timestamptz;
  requested_source_id text := target_provenance ->> 'sourceId';
begin
  if target_operation not in ('ingest_verified_discovery', 'checkpoint_discovery_search') or target_operation is null
    or jsonb_typeof(proof) is distinct from 'object'
    or proof ->> 'userId' is distinct from target_user_id::text
    or nullif(trim(requested_source_id), '') is null then
    raise exception 'Discovery admission proof is required.' using errcode = '42501';
  end if;
  if target_provenance ? 'discoveryBudgetHold' and (
    target_operation is distinct from 'checkpoint_discovery_search'
    or target_provenance ->> 'searchPhase' is distinct from 'claimed'
  ) then raise exception 'Only an internal original claim can propose a budget hold.' using errcode = '42501'; end if;
  -- Checkpoints are internal automation bookkeeping under the same consent
  -- lock. No delegated client gains a cursor-writing capability.
  if target_operation = 'checkpoint_discovery_search' and (
    target_principal_kind is distinct from 'automation' or proof ->> 'kind' is distinct from 'automation'
    or target_client_id is not null or target_compensation is not null
    or target_provenance ->> 'producer' is distinct from 'server_scheduler'
    or coalesce(target_provenance ->> 'searchPhase', '') not in ('claimed', 'settled')
    or coalesce(target_provenance ->> 'searchPlanFingerprint', '') !~ '^[a-f0-9]{64}$'
    or coalesce(target_provenance ->> 'scopeFingerprint', '') !~ '^[a-f0-9]{64}$'
    or coalesce(target_provenance ->> 'searchCycleId', '') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(target_provenance -> 'searchBatch') is distinct from 'object'
    or target_provenance -> 'searchBatch' ->> 'phase' is distinct from target_provenance ->> 'searchPhase'
    or target_provenance -> 'searchBatch' ->> 'planFingerprint' is distinct from target_provenance ->> 'searchPlanFingerprint'
    or target_provenance -> 'searchBatch' ->> 'cycleId' is distinct from target_provenance ->> 'searchCycleId'
    or coalesce(target_provenance -> 'searchBatch' ->> 'claimAttemptId', '') !~ '^[a-f0-9-]{36}$'
    or jsonb_typeof(target_provenance -> 'searchBatch' -> 'index') is distinct from 'number'
    or target_provenance -> 'searchBatch' ->> 'index' is distinct from target_provenance ->> 'searchBatchIndex'
  ) then raise exception 'Only internal Discovery automation checkpoints are allowed.' using errcode = '42501'; end if;
  if target_principal_kind = 'automation' and proof ->> 'kind' = 'automation' and target_client_id is null then
    -- Consistent lock order: authority row, then the existing workspace CAS.
    select c.* into active_connection from public.google_drive_connections c
      where c.user_id = target_user_id for share;
    if not found or active_connection.revoked_at is not null
      or active_connection.discovery_automation_enabled is not true
      or active_connection.google_subject is distinct from proof ->> 'googleSubject'
      or active_connection.discovery_consent_generation::text is distinct from proof ->> 'consentGeneration'
      or coalesce(active_connection.discovery_last_error, '') ~ '^GOOGLE_AUTH_EXPIRED($|[:[:space:]\[])' then
      raise exception 'Discovery consent is absent, revoked, replaced or stale.' using errcode = '42501';
    end if;
    trusted_proof := jsonb_build_object('kind', 'automation', 'userId', active_connection.user_id,
      'consentGeneration', active_connection.discovery_consent_generation);
  elsif target_principal_kind = 'delegated_mcp' and proof ->> 'kind' = 'delegated_mcp'
    and nullif(trim(target_client_id), '') is not null
    and proof ->> 'clientId' = target_client_id and proof ->> 'sourceId' = requested_source_id then
    select g.* into active_grant from public.pjsdas_authorization_grants g
      where g.id::text = proof ->> 'grantId' and g.user_id = target_user_id
        and g.client_id = target_client_id and g.source_id = requested_source_id
        and g.capability = 'ingest_discovery_run' for share;
    if not found or active_grant.revoked_at is not null or active_grant.granted_at > now()
      or active_grant.revision::text is distinct from proof ->> 'grantRevision' then
      raise exception 'Discovery grant is absent, revoked, replaced or stale.' using errcode = '42501';
    end if;
    trusted_proof := jsonb_build_object('kind', 'delegated_mcp', 'userId', active_grant.user_id,
      'clientId', active_grant.client_id, 'sourceId', active_grant.source_id,
      'grantId', active_grant.id, 'grantRevision', active_grant.revision);
  else
    raise exception 'Unsupported Discovery admission authority.' using errcode = '42501';
  end if;
  if target_operation = 'checkpoint_discovery_search' then
    select w.* into checkpoint_workspace from public.pjsdas_workspaces w where w.user_id = target_user_id for update;
    if checkpoint_workspace.id is not null and checkpoint_workspace.revision=target_expected_revision then
      target_snapshot := public.pjsdas_merge_empty_gmail_runs_v1(target_user_id,checkpoint_workspace.snapshot,
        checkpoint_workspace.materialized_revision,checkpoint_workspace.revision,target_snapshot,false);
      checkpoint_workspace.snapshot := public.pjsdas_logical_workspace_snapshot_v1(checkpoint_workspace);
    end if;

    -- Preserve the ordinary CAS conflict/replay behavior. A current-revision
    -- checkpoint can only submit the exact existing authoritative snapshot.
    if found and checkpoint_workspace.revision = target_expected_revision
      and (target_snapshot is distinct from checkpoint_workspace.snapshot or target_schema_version is distinct from checkpoint_workspace.schema_version) then
      raise exception 'Search checkpoints cannot mutate workspace data.' using errcode = '42501';
    end if;
  end if;
  if target_provenance ? 'searchBatch' then
    if target_principal_kind is distinct from 'automation' or proof ->> 'kind' is distinct from 'automation' then
      raise exception 'Only server automation owns search progress.' using errcode = '42501';
    end if;
    if target_operation = 'ingest_verified_discovery' and target_provenance ->> 'searchPhase' is distinct from 'settled' then
      raise exception 'Discovery facts can only settle an original search claim.' using errcode = '42501';
    end if;
    -- Serialize progress admission with the original workspace transaction.
    perform 1 from public.pjsdas_workspaces w where w.user_id = target_user_id for update;
    select c.* into original_claim from public.pjsdas_command_ledger c
      where c.user_id = target_user_id and c.operation = 'checkpoint_discovery_search' and c.status = 'COMMITTED'
        and c.principal_kind = 'automation' and c.provenance ->> 'producer' = 'server_scheduler'
        and c.provenance ->> 'sourceId' = requested_source_id
        and c.provenance ->> 'scopeFingerprint' = target_provenance ->> 'scopeFingerprint'
        and c.provenance ->> 'searchPlanFingerprint' = target_provenance ->> 'searchPlanFingerprint'
        and c.provenance ->> 'searchCycleId' = target_provenance ->> 'searchCycleId'
        and c.provenance ->> 'searchBatchIndex' = target_provenance ->> 'searchBatchIndex'
        and c.provenance ->> 'searchPhase' = 'claimed';
    if target_provenance ->> 'searchPhase' = 'settled' then
      if not found or original_claim.provenance -> 'searchBatch' ->> 'claimAttemptId'
        is distinct from target_provenance -> 'searchBatch' ->> 'claimAttemptId' then
        raise exception 'Search settlement requires its original claim.' using errcode = '42501';
      end if;
    elsif target_provenance ->> 'searchPhase' = 'claimed' then
      if found and original_claim.command_id is distinct from target_command_id then
        raise exception 'This search batch already has an original claim.' using errcode = '42501';
      end if;
      if (target_provenance ->> 'searchBatchIndex')::integer > 0 and not exists (
        select 1 from public.pjsdas_command_ledger c where c.user_id = target_user_id and c.status = 'COMMITTED'
          and c.principal_kind = 'automation' and c.provenance ->> 'producer' = 'server_scheduler'
          and c.provenance ->> 'sourceId' = requested_source_id
          and c.provenance ->> 'searchPlanFingerprint' = target_provenance ->> 'searchPlanFingerprint'
          and c.provenance ->> 'searchCycleId' = target_provenance ->> 'searchCycleId'
          and c.provenance ->> 'searchBatchIndex' = ((target_provenance ->> 'searchBatchIndex')::integer - 1)::text
          and c.provenance ->> 'searchPhase' = 'settled'
      ) then raise exception 'Search progress cannot skip an unsettled batch.' using errcode = '42501'; end if;
    else raise exception 'Invalid search progress phase.' using errcode = '42501'; end if;
    if target_provenance ->> 'searchPhase' = 'settled' and exists (select 1 from public.pjsdas_command_ledger c
      where c.user_id = target_user_id and c.status = 'COMMITTED'
        and c.provenance ->> 'sourceId' = requested_source_id
        and c.provenance ->> 'searchPlanFingerprint' = target_provenance ->> 'searchPlanFingerprint'
        and c.provenance ->> 'searchCycleId' = target_provenance ->> 'searchCycleId'
        and c.provenance ->> 'searchBatchIndex' = target_provenance ->> 'searchBatchIndex'
        and c.provenance ->> 'searchPhase' = 'settled' and c.command_id is distinct from target_command_id) then
      raise exception 'This search batch already has its immutable settlement.' using errcode = '42501';
    end if;
    if target_provenance ->> 'searchPhase' = 'claimed' and target_provenance ? 'discoveryBudgetHold' then
      budget_hold := target_provenance -> 'discoveryBudgetHold';
      budget_policy := budget_hold -> 'policy';
      if jsonb_typeof(budget_hold) is distinct from 'object'
        or budget_hold - array['version','policy','policyFingerprint','sourceId','claimAttemptId','searchRequestLimit','modelRequestLimit','reservedMicroUsd'] <> '{}'::jsonb
        or budget_hold -> 'version' is distinct from '1'::jsonb
        or jsonb_typeof(budget_hold -> 'sourceId') is distinct from 'string'
        or jsonb_typeof(budget_hold -> 'claimAttemptId') is distinct from 'string'
        or coalesce(budget_hold ->> 'claimAttemptId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or budget_hold ->> 'sourceId' is distinct from requested_source_id
        or budget_hold ->> 'claimAttemptId' is distinct from target_provenance -> 'searchBatch' ->> 'claimAttemptId'
        or jsonb_typeof(budget_hold -> 'policyFingerprint') is distinct from 'string'
        or coalesce(budget_hold ->> 'policyFingerprint', '') !~ '^[a-f0-9]{64}$'
        or budget_hold ->> 'modelRequestLimit' is distinct from '1'
        or jsonb_typeof(budget_hold -> 'modelRequestLimit') is distinct from 'number'
        or jsonb_typeof(budget_hold -> 'searchRequestLimit') is distinct from 'number'
        or coalesce(budget_hold ->> 'searchRequestLimit', '') !~ '^[1-9][0-9]?$'
        or budget_hold ->> 'searchRequestLimit' is distinct from target_provenance -> 'searchBatch' ->> 'queryCount'
        or jsonb_typeof(budget_hold -> 'reservedMicroUsd') is distinct from 'number'
        or coalesce(budget_hold ->> 'reservedMicroUsd', '') !~ '^[1-9][0-9]{0,15}$'
        or jsonb_typeof(budget_policy) is distinct from 'object'
        or budget_policy - array['version','application','approvalId','accountId','scopeFingerprint','currency','maximumMicroUsd','validFrom','expiresAt','tariffVersion'] <> '{}'::jsonb
        or budget_policy -> 'version' is distinct from '1'::jsonb
        or budget_policy ->> 'application' is distinct from 'todayaction'
        or budget_policy ->> 'accountId' is distinct from target_user_id::text
        or budget_policy ->> 'scopeFingerprint' is distinct from target_provenance ->> 'scopeFingerprint'
        or budget_policy ->> 'currency' is distinct from 'USD'
        or budget_policy ->> 'tariffVersion' is distinct from 'todayaction-standard-search-text-2026-10-08'
        or jsonb_typeof(budget_policy -> 'approvalId') is distinct from 'string'
        or jsonb_typeof(budget_policy -> 'scopeFingerprint') is distinct from 'string'
        or coalesce(budget_policy ->> 'scopeFingerprint', '') !~ '^[a-f0-9]{64}$'
        or coalesce(budget_policy ->> 'approvalId', '') !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$'
        or jsonb_typeof(budget_policy -> 'maximumMicroUsd') is distinct from 'number'
        or coalesce(budget_policy ->> 'maximumMicroUsd', '') !~ '^[1-9][0-9]{0,15}$'
        or jsonb_typeof(budget_policy -> 'validFrom') is distinct from 'string'
        or jsonb_typeof(budget_policy -> 'expiresAt') is distinct from 'string'
        or coalesce(budget_policy ->> 'validFrom', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$'
        or coalesce(budget_policy ->> 'expiresAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
        raise exception 'Invalid account-bound Discovery budget terms.' using errcode = '42501';
      end if;
      budget_amount := (budget_hold ->> 'reservedMicroUsd')::bigint;
      budget_cap := (budget_policy ->> 'maximumMicroUsd')::bigint;
      if (budget_hold ->> 'searchRequestLimit')::integer > 48
        or budget_amount <> (budget_hold ->> 'searchRequestLimit')::bigint * 5000 + 427031
        or budget_cap > 9007199254740991 then
        raise exception 'The hold does not cover the complete fixed-tariff batch.' using errcode = '42501';
      end if;
      begin
        budget_starts_at := (budget_policy ->> 'validFrom')::timestamptz;
        budget_expires_at := (budget_policy ->> 'expiresAt')::timestamptz;
      exception when datetime_field_overflow or invalid_datetime_format then
        raise exception 'Invalid Discovery budget window.' using errcode = '42501';
      end;
      if not isfinite(budget_starts_at) or not isfinite(budget_expires_at) or budget_expires_at <= budget_starts_at then
        raise exception 'Invalid Discovery budget window.' using errcode = '42501';
      end if;
      if original_claim.command_id = target_command_id then
        -- A retry preserves the original decision and amount, including a
        -- rejected hold. It never tests the remaining cap a second time.
        if original_claim.provenance -> 'discoveryBudgetHold' is distinct from budget_hold
          or original_claim.receipt -> 'discoveryBudget' is null then
          raise exception 'Budget replay differs from its original claim.' using errcode = '42501';
        end if;
        trusted_budget := original_claim.receipt -> 'discoveryBudget';
      else
        -- Use wall time after both authority and workspace locks. Waiting on a
        -- lock cannot extend an expired approval using transaction start time.
        if clock_timestamp() < budget_starts_at or clock_timestamp() >= budget_expires_at then
          raise exception 'Discovery budget window is closed.' using errcode = '42501';
        end if;
        select c.provenance #> '{discoveryBudgetHold,policy}' into prior_budget_policy
          from public.pjsdas_command_ledger c where c.user_id = target_user_id and c.status = 'COMMITTED'
            and c.operation = 'checkpoint_discovery_search' and c.principal_kind = 'automation'
            and c.provenance ->> 'searchPhase' = 'claimed' and c.provenance ? 'discoveryBudgetHold'
            and c.provenance #>> '{discoveryBudgetHold,policy,approvalId}' = budget_policy ->> 'approvalId'
          order by c.resulting_revision limit 1;
        if found and prior_budget_policy is distinct from budget_policy then
          raise exception 'An existing budget approval cannot change terms or reset its cap.' using errcode = '42501';
        end if;
        if exists (select 1 from public.pjsdas_command_ledger c where c.user_id = target_user_id and c.status = 'COMMITTED'
            and c.operation = 'checkpoint_discovery_search' and c.principal_kind = 'automation'
            and c.provenance ->> 'searchPhase' = 'claimed' and c.provenance ? 'discoveryBudgetHold'
            and c.provenance #>> '{discoveryBudgetHold,policy,approvalId}' = budget_policy ->> 'approvalId'
            and (c.receipt #>> '{discoveryBudget,version}' is distinct from '1'
              or c.receipt #> '{discoveryBudget,hold}' is distinct from c.provenance -> 'discoveryBudgetHold'
              or jsonb_typeof(c.receipt #> '{discoveryBudget,admitted}') is distinct from 'boolean'
              or c.receipt #>> '{discoveryBudget,retainedMicroUsd}' is distinct from
                case when c.receipt #>> '{discoveryBudget,admitted}' = 'true'
                  then c.provenance #>> '{discoveryBudgetHold,reservedMicroUsd}' else '0' end)) then
          raise exception 'An original budget hold lacks verified admission; reconcile before new spending.' using errcode = '42501';
        end if;
        select coalesce(sum((c.receipt #>> '{discoveryBudget,retainedMicroUsd}')::numeric), 0) into held_total
          from public.pjsdas_command_ledger c where c.user_id = target_user_id and c.status = 'COMMITTED'
            and c.operation = 'checkpoint_discovery_search' and c.principal_kind = 'automation'
            and c.provenance ->> 'searchPhase' = 'claimed' and c.provenance ? 'discoveryBudgetHold'
            and c.provenance #>> '{discoveryBudgetHold,policy,approvalId}' = budget_policy ->> 'approvalId';
        budget_admitted := held_total + budget_amount <= budget_cap;
        trusted_budget := jsonb_build_object('version', 1, 'hold', budget_hold, 'admitted', budget_admitted,
          'retainedMicroUsd', case when budget_admitted then budget_amount else 0 end);
      end if;
    elsif target_provenance ->> 'searchPhase' = 'settled' and original_claim.provenance ? 'discoveryBudgetHold' then
      trusted_budget := original_claim.receipt -> 'discoveryBudget';
      if trusted_budget is null then raise exception 'The original budget admission is unavailable.' using errcode = '42501'; end if;
      if trusted_budget ->> 'admitted' = 'false' and (
        target_operation <> 'checkpoint_discovery_search'
        or target_provenance -> 'searchBatch' ->> 'outcome' is distinct from 'budget_exhausted'
      ) then raise exception 'A declined budget claim cannot record successful retrieval or facts.' using errcode = '42501'; end if;
    end if;
  end if;
  return query select * from public.pjsdas_commit_workspace_v2(
    target_user_id, target_command_id, target_operation, target_payload_hash,
    target_expected_revision, target_snapshot, target_schema_version, target_principal_kind,
    target_client_id, target_provenance, target_compensation, target_effective_time,
    (coalesce(target_receipt_context, '{}'::jsonb) - 'discoveryBudget')
      || jsonb_build_object('discoveryAuthorization', trusted_proof)
      || case when trusted_budget is null then '{}'::jsonb else jsonb_build_object('discoveryBudget', trusted_budget) end
  );
end
$$;
