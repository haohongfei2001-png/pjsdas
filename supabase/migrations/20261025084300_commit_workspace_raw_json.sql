-- Candidate only: raw-body PostgREST input avoids json_to_record materialization.
-- Separate owner approval + ACL/recovery verification required before production.
-- Preserve v2/v3 and all guarded routes; no new table or role privileges.
create or replace function public.pjsdas_commit_workspace_v4(jsonb)
returns table (outcome text, workspace_id uuid, revision bigint, receipt jsonb)
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  payload alias for $1;
begin
  -- Match the named-argument contract, rather than accepting arbitrary wrappers
  -- or silently dropping forged/unknown fields at this new raw-body boundary.
  if payload is null or jsonb_typeof(payload) <> 'object'
    or not (payload ?& array[
      'target_user_id','target_command_id','target_operation','target_payload_hash',
      'target_expected_revision','target_snapshot','target_schema_version',
      'target_principal_kind','target_client_id','target_provenance',
      'target_compensation','target_effective_time','target_receipt_context'
    ]) then
    raise exception 'PJSDAS raw commit requires the exact named argument object.' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_object_keys(payload)) <> 13 then
    raise exception 'PJSDAS raw commit contains unknown arguments.' using errcode = '22023';
  end if;
  -- Extract scalar arguments directly; do not reintroduce a record-valued input
  -- expansion. JSON null maps to SQL NULL just like json_to_record did in v3.
  return query select result.outcome,result.workspace_id,result.revision,result.receipt
  from public.pjsdas_commit_workspace_v3(
    (payload->>'target_user_id')::uuid,
    payload->>'target_command_id',
    payload->>'target_operation',
    payload->>'target_payload_hash',
    (payload->>'target_expected_revision')::bigint,
    nullif(payload->'target_snapshot','null'::jsonb),
    (payload->>'target_schema_version')::integer,
    payload->>'target_principal_kind',
    payload->>'target_client_id',
    nullif(payload->'target_provenance','null'::jsonb),
    nullif(payload->'target_compensation','null'::jsonb),
    (payload->>'target_effective_time')::timestamptz,
    nullif(payload->'target_receipt_context','null'::jsonb)
  ) result;
end
$$;
revoke all on function public.pjsdas_commit_workspace_v4(jsonb) from public, anon, authenticated;
grant execute on function public.pjsdas_commit_workspace_v4(jsonb) to service_role;
