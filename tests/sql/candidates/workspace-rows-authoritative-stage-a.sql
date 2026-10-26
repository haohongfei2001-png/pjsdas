-- Trusted existing-core base command surface. This does not independently
-- authorize semantic changes; it retains the existing service-side core boundary.
-- Protected families must use their separately checked SQL wrappers.
create function pjsdas_rows_candidate.commit_authoritative(req jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
declare original jsonb;
begin
 if req->>'principal' is null or req->>'principal' not in ('first_party_web','delegated_mcp','automation')
 or nullif(req->>'operation','') is null
 or req->>'operation' in ('gmail_semantic_intake','business_management','opportunity_management','planning_management','discovery_profile_management','private_reminder_management','ai_capture_confirm','ingest_verified_discovery','checkpoint_discovery_search')
 or req ?| array['managementAuthorization','aiCaptureAuthorization','discoveryAuthorization']
 or (req->>'principal'='delegated_mcp' and nullif(trim(req->>'clientId'),'') is null)
 or (req->>'principal'<>'delegated_mcp' and req->>'clientId' is not null)
 or coalesce(req->'receiptContext','{}'::jsonb) ? 'managementAuthorization' then
 raise exception 'protected command family or invalid principal requires its dedicated entry' using errcode='42501';end if;
 if req->>'operation'='undo_command' then
  if nullif(req#>>'{provenance,undoOf}','') is null then raise exception 'undo target missing' using errcode='42501';end if;
  original:=pjsdas_rows_internal.original_command((req->>'workspaceId')::uuid,(req->>'userId')::uuid,req#>>'{provenance,undoOf}');
  if original is null or original#>>'{receipt,operation}' in ('business_management','opportunity_management','planning_management','discovery_profile_management','private_reminder_management') then
   raise exception 'protected or missing undo target requires original authority' using errcode='42501';end if;
 end if;
 return pjsdas_rows_internal.apply_rows(req);
end$$;
revoke all on function pjsdas_rows_candidate.commit_authoritative(jsonb) from public,anon,authenticated;
grant execute on function pjsdas_rows_candidate.commit_authoritative(jsonb) to service_role;
