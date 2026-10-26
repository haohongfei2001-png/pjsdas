-- Stage A only: consume the existing durable preview in the same transaction
-- as the isolated row write. Does not dispatch any model or alter funding policy.
create function pjsdas_rows_candidate.commit_ai_capture(req jsonb,target_capture_request_id text,target_capture_observation jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
declare
 h pjsdas_rows_candidate.head%rowtype;
 capture public.pjsdas_ai_capture_previews%rowtype;
 result jsonb;
begin
 if req->>'operation' is distinct from 'ai_capture_confirm' or req->>'principal' is distinct from 'first_party_web'
 or req ?| array['clientId','managementAuthorization','aiCaptureAuthorization','discoveryAuthorization'] then
  raise exception 'capture confirmation requires first-party authority' using errcode='42501';end if;
 select * into h from pjsdas_rows_candidate.head where id=(req->>'workspaceId')::uuid and user_id=(req->>'userId')::uuid for update;
 if not found then raise exception 'connected workspace absent' using errcode='P0001';end if;
 if h.epoch is distinct from (req->>'expectedEpoch')::uuid then raise exception 'unsupported generation' using errcode='PT409';end if;
 -- Preserve workspace -> preview lock order and wall-clock expiry after waits.
 select p.* into capture from public.pjsdas_ai_capture_previews p where p.user_id=h.user_id and p.request_id=target_capture_request_id for update;
 if not found or capture.status not in ('READY','COMMITTED')
 or capture.expected_revision is distinct from (req->>'expectedRevision')::bigint
 or target_capture_observation is null or capture.observation is distinct from target_capture_observation
 or (capture.status='COMMITTED' and capture.command_id is distinct from req->>'commandId') then
  raise exception 'capture absent, stale, mismatched or consumed' using errcode='42501';end if;
 if capture.status='READY' and capture.expires_at<=clock_timestamp() then
  raise exception 'capture review expired' using errcode='42501';end if;
 if (exists(select 1 from pjsdas_rows_candidate.ledger l where l.user_id=h.user_id and l.command_id=req->>'commandId')
 or exists(select 1 from public.pjsdas_command_ledger l where l.user_id=h.user_id and l.command_id=req->>'commandId'))
 and capture.command_id is distinct from req->>'commandId' then
  raise exception 'capture command belongs to another command' using errcode='23505';end if;
 result:=pjsdas_rows_internal.apply_rows(req);
 if result->>'outcome'='COMMITTED' then
  update public.pjsdas_ai_capture_previews set status='COMMITTED',command_id=req->>'commandId',committed_at=now()
   where user_id=h.user_id and request_id=target_capture_request_id;
 end if;
 return result;
end$$;
revoke all on function pjsdas_rows_candidate.commit_ai_capture(jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function pjsdas_rows_candidate.commit_ai_capture(jsonb,text,jsonb) to service_role;

-- Layout-aware admission preserves at-most-once reservation and existing free
-- policy checks. Public settlement remains unchanged because it has no layout read.
create function pjsdas_rows_candidate.admit_ai_capture(
  target_user_id uuid, target_request_id text, target_payload_hash text,
  target_text text, target_timezone text, target_reference_time timestamptz,
  target_expected_revision bigint, target_reservation_units bigint, target_epoch uuid
) returns setof public.pjsdas_ai_capture_previews
language plpgsql security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
declare
  workspace pjsdas_rows_candidate.head%rowtype;
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
  select w.* into workspace from pjsdas_rows_candidate.head w where w.user_id = target_user_id for update;
  if not found then raise exception 'Connected workspace does not exist.' using errcode = 'P0001'; end if;
  if workspace.epoch is distinct from target_epoch or workspace.format is distinct from 'workspace-rows-v1' then raise exception 'unsupported capture generation' using errcode='PT409';end if;
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
    raise exception 'AI capture workspace revision conflict.' using errcode = 'PT409';
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

revoke all on function pjsdas_rows_candidate.admit_ai_capture(uuid,text,text,text,text,timestamptz,bigint,bigint,uuid) from public,anon,authenticated;
grant execute on function pjsdas_rows_candidate.admit_ai_capture(uuid,text,text,text,text,timestamptz,bigint,bigint,uuid) to service_role;
