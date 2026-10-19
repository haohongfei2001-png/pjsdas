-- Durable, at-most-once model dispatch and atomic consumption of reviewed captures.
-- No paid-spend switch exists: every reservation consumes explicitly approved free units.
create table public.pjsdas_ai_capture_policies (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  data_scope_approved boolean not null default false,
  funding_boundary_reference text,
  valid_until timestamptz,
  max_request_units bigint not null default 0 check (max_request_units >= 0),
  free_units_limit bigint not null default 0 check (free_units_limit >= 0),
  reserved_units bigint not null default 0 check (reserved_units >= 0 and reserved_units <= free_units_limit),
  paid_spend_allowed boolean not null default false check (not paid_spend_allowed)
);
create table public.pjsdas_ai_capture_previews (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null check (length(trim(request_id)) > 0),
  payload_hash text not null check (length(trim(payload_hash)) > 0),
  text text not null check (length(trim(text)) > 0),
  timezone text not null check (length(trim(timezone)) > 0),
  reference_time timestamptz not null,
  expected_revision bigint not null check (expected_revision >= 0),
  reservation_units bigint not null check (reservation_units > 0),
  admission_funding_boundary_reference text not null,
  admission_policy_valid_until timestamptz not null,
  admission_max_request_units bigint not null check (admission_max_request_units > 0),
  status text not null check (status in ('DISPATCHED', 'READY', 'BLOCKED', 'UNKNOWN', 'COMMITTED')),
  review jsonb,
  observation jsonb,
  command_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  finalized_at timestamptz,
  committed_at timestamptz,
  primary key (user_id, request_id),
  check (status not in ('READY', 'COMMITTED') or (review is not null and observation is not null)),
  check ((status = 'COMMITTED') = (command_id is not null and committed_at is not null))
);
alter table public.pjsdas_ai_capture_policies enable row level security;
alter table public.pjsdas_ai_capture_previews enable row level security;
revoke all on public.pjsdas_ai_capture_policies, public.pjsdas_ai_capture_previews from public, anon, authenticated;
grant select, insert, update, delete on public.pjsdas_ai_capture_policies, public.pjsdas_ai_capture_previews to service_role;

create function public.pjsdas_admit_ai_capture(
  target_user_id uuid, target_request_id text, target_payload_hash text,
  target_text text, target_timezone text, target_reference_time timestamptz,
  target_expected_revision bigint, target_reservation_units bigint
) returns setof public.pjsdas_ai_capture_previews
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  workspace public.pjsdas_workspaces%rowtype;
  previous public.pjsdas_ai_capture_previews%rowtype;
  policy public.pjsdas_ai_capture_policies%rowtype;
begin
  if target_user_id is null or nullif(trim(target_request_id), '') is null
    or nullif(trim(target_payload_hash), '') is null or nullif(trim(target_text), '') is null
    or nullif(trim(target_timezone), '') is null or target_reference_time is null
    or target_expected_revision is null or target_expected_revision < 0
    or target_reservation_units is null or target_reservation_units <= 0 then
    raise exception 'AI capture admission arguments are incomplete.' using errcode = '22023';
  end if;
  select w.* into workspace from public.pjsdas_workspaces w where w.user_id = target_user_id for update;
  if not found then raise exception 'Connected workspace does not exist.' using errcode = 'P0001'; end if;
  select p.* into previous from public.pjsdas_ai_capture_previews p
    where p.user_id = target_user_id and p.request_id = target_request_id;
  if found then
    if previous.payload_hash is distinct from target_payload_hash
      or previous.text is distinct from target_text or previous.timezone is distinct from target_timezone
      or previous.expected_revision is distinct from target_expected_revision then
      raise exception 'AI capture request id was reused with a different payload.' using errcode = '23505';
    end if;
    -- Even an unresolved dispatch is never admitted again. Caller must read its receipt.
    raise exception 'AI capture request already admitted; do not dispatch again.' using errcode = '23505';
  end if;
  if workspace.revision is distinct from target_expected_revision then
    raise exception 'AI capture workspace revision conflict.' using errcode = '40001';
  end if;
  select p.* into policy from public.pjsdas_ai_capture_policies p where p.user_id = target_user_id for update;
  if not found or not policy.enabled or not policy.data_scope_approved or policy.paid_spend_allowed
    or nullif(trim(policy.funding_boundary_reference), '') is null
    or policy.valid_until is null or policy.valid_until <= clock_timestamp()
    or policy.max_request_units <= 0 or target_reservation_units < policy.max_request_units
    or target_reservation_units > policy.free_units_limit - policy.reserved_units then
    raise exception 'AI capture approved free budget unavailable.' using errcode = '42501';
  end if;
  update public.pjsdas_ai_capture_policies p set reserved_units = p.reserved_units + target_reservation_units
    where p.user_id = target_user_id;
  -- Reservations are deliberately never released after an uncertain provider outcome.
  return query insert into public.pjsdas_ai_capture_previews
    (user_id, request_id, payload_hash, text, timezone, reference_time, expected_revision, reservation_units, status,
      admission_funding_boundary_reference, admission_policy_valid_until, admission_max_request_units)
    values (target_user_id, target_request_id, target_payload_hash, target_text, target_timezone,
      target_reference_time, target_expected_revision, target_reservation_units, 'DISPATCHED',
      policy.funding_boundary_reference, policy.valid_until, policy.max_request_units) returning *;
end $$;

create function public.pjsdas_finish_ai_capture(
  target_user_id uuid, target_request_id text, target_payload_hash text,
  target_status text, target_review jsonb, target_observation jsonb
) returns setof public.pjsdas_ai_capture_previews
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  previous public.pjsdas_ai_capture_previews%rowtype;
begin
  if target_status is null or target_status not in ('READY', 'BLOCKED', 'UNKNOWN')
    or (target_status = 'READY' and (target_review is null or target_observation is null
      or jsonb_typeof(target_review) <> 'object' or jsonb_typeof(target_observation) <> 'object')) then
    raise exception 'Invalid AI capture terminal result.' using errcode = '22023';
  end if;
  select p.* into previous from public.pjsdas_ai_capture_previews p
    where p.user_id = target_user_id and p.request_id = target_request_id for update;
  if not found or previous.payload_hash is distinct from target_payload_hash then
    raise exception 'AI capture dispatch receipt not found or mismatched.' using errcode = '42501';
  end if;
  if target_status = 'READY' and (
    target_review ->> 'status' is distinct from 'ready_for_review'
    or (target_review ->> 'statementMode') is null or (target_review ->> 'statementMode') not in ('assertion', 'current_intent')
    or target_observation ->> 'statementMode' is distinct from target_review ->> 'statementMode'
    or jsonb_typeof(target_review -> 'candidates') is distinct from 'array'
    or target_review -> 'candidates' = '[]'::jsonb
    or target_observation -> 'candidates' is distinct from target_review -> 'candidates'
    or target_observation ->> 'inputId' is distinct from 'ai:' || previous.request_id
    or target_observation ->> 'originalText' is distinct from previous.text
    or target_observation #>> '{source,kind}' is distinct from 'web'
    or target_observation #>> '{source,sourceId}' is distinct from 'todayaction-web'
    or target_observation #>> '{source,sourceRecordId}' is distinct from previous.request_id
    or target_observation #>> '{source,timezone}' is distinct from previous.timezone
    or (target_observation #>> '{source,observedAt}')::timestamptz is distinct from previous.reference_time
  ) then
    raise exception 'AI capture review and observation binding is invalid.' using errcode = '22023';
  end if;
  if previous.status <> 'DISPATCHED' then
    -- Same settlement is safe to recover, but no terminal receipt can be overwritten.
    if previous.status = target_status and previous.review is not distinct from target_review
      and previous.observation is not distinct from target_observation then return next previous; return; end if;
    raise exception 'AI capture receipt is already finalized.' using errcode = '23505';
  end if;
  return query update public.pjsdas_ai_capture_previews p
    set status = target_status, review = target_review, observation = target_observation, finalized_at = now()
    where p.user_id = target_user_id and p.request_id = target_request_id returning p.*;
end $$;

create function public.pjsdas_commit_ai_capture(
  target_user_id uuid, target_command_id text, target_operation text, target_payload_hash text,
  target_expected_revision bigint, target_snapshot jsonb, target_schema_version integer,
  target_principal_kind text, target_client_id text, target_provenance jsonb,
  target_compensation jsonb, target_effective_time timestamptz, target_receipt_context jsonb,
  target_capture_request_id text, target_capture_observation jsonb
) returns table (outcome text, workspace_id uuid, revision bigint, snapshot jsonb, receipt jsonb)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  capture public.pjsdas_ai_capture_previews%rowtype;
  result record;
begin
  if target_operation is distinct from 'ai_capture_confirm'
    or target_principal_kind is distinct from 'first_party_web' or target_client_id is not null then
    raise exception 'AI capture confirmation requires first-party web authority.' using errcode = '42501';
  end if;
  -- Match the global workspace lock order before locking the capture receipt.
  perform 1 from public.pjsdas_workspaces w where w.user_id = target_user_id for update;
  if not found then raise exception 'Connected workspace does not exist.' using errcode = 'P0001'; end if;
  select p.* into capture from public.pjsdas_ai_capture_previews p
    where p.user_id = target_user_id and p.request_id = target_capture_request_id for update;
  if not found or capture.status not in ('READY', 'COMMITTED')
    or capture.expected_revision is distinct from target_expected_revision
    or target_capture_observation is null or capture.observation is distinct from target_capture_observation
    or (capture.status = 'COMMITTED' and capture.command_id is distinct from target_command_id) then
    raise exception 'AI capture confirmation receipt is absent, stale, mismatched or consumed.' using errcode = '42501';
  end if;
  if capture.status = 'READY' and capture.expires_at <= clock_timestamp() then
    raise exception 'AI capture review expired.' using errcode = '42501';
  end if;
  -- A pre-existing unrelated command cannot consume this receipt via v2 replay.
  if exists (select 1 from public.pjsdas_command_ledger c where c.user_id = target_user_id
    and c.command_id = target_command_id) and capture.command_id is distinct from target_command_id then
    raise exception 'AI capture command id already belongs to another command.' using errcode = '23505';
  end if;
  select * into result from public.pjsdas_commit_workspace_v2(
    target_user_id, target_command_id, target_operation, target_payload_hash,
    target_expected_revision, target_snapshot, target_schema_version, target_principal_kind,
    target_client_id, target_provenance, target_compensation, target_effective_time, target_receipt_context
  );
  if result.outcome = 'COMMITTED' then
    update public.pjsdas_ai_capture_previews p set status = 'COMMITTED',
      command_id = target_command_id, committed_at = now()
      where p.user_id = target_user_id and p.request_id = target_capture_request_id;
  end if;
  return query select result.outcome, result.workspace_id, result.revision, result.snapshot, result.receipt;
end $$;

revoke all on function public.pjsdas_admit_ai_capture(uuid,text,text,text,text,timestamptz,bigint,bigint) from public, anon, authenticated;
grant execute on function public.pjsdas_admit_ai_capture(uuid,text,text,text,text,timestamptz,bigint,bigint) to service_role;
revoke all on function public.pjsdas_finish_ai_capture(uuid,text,text,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.pjsdas_finish_ai_capture(uuid,text,text,text,jsonb,jsonb) to service_role;
revoke all on function public.pjsdas_commit_ai_capture(uuid,text,text,text,bigint,jsonb,integer,text,text,jsonb,jsonb,timestamptz,jsonb,text,jsonb) from public, anon, authenticated;
grant execute on function public.pjsdas_commit_ai_capture(uuid,text,text,text,bigint,jsonb,integer,text,text,jsonb,jsonb,timestamptz,jsonb,text,jsonb) to service_role;
