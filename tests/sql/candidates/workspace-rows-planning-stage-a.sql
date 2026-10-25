-- Stage A only. Requires the real existing grant migration chain in an isolated DB.
-- No production function is replaced. Other management families stay rejected.
create function pjsdas_rows_candidate.commit_planning(req jsonb,target_grant_id uuid,target_grant_revision bigint,target_client_id text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
declare
 active_grant public.pjsdas_business_management_grants%rowtype;
 h pjsdas_rows_candidate.head%rowtype;
begin
 if req->>'principal' is distinct from 'delegated_mcp' or nullif(trim(target_client_id),'') is null
 or target_grant_id is null or target_grant_revision is null
 or (req->>'operation') is null or (req->>'operation') not in ('planning_management','undo_command')
 or req ?| array['managementAuthorization','aiCaptureAuthorization','discoveryAuthorization'] then
  raise exception 'planning authorization required or unsupported family' using errcode='42501';end if;
 -- Preserve real grant SHARE lock and revoke/replace/revision/owner/client checks.
 select g.* into active_grant from public.pjsdas_business_management_grants g
 where g.id=target_grant_id and g.user_id=(req->>'userId')::uuid and g.client_id::text=target_client_id
 and g.capability='workspace.planning.manage' and g.consent_version=4 and g.revision=target_grant_revision
 and g.revoked_at is null and g.granted_at<=now() for share;
 if not found then raise exception 'planning grant absent or stale' using errcode='42501';end if;
 if req->>'operation'='undo_command' and not (
 exists(select 1 from pjsdas_rows_candidate.ledger where user_id=(req->>'userId')::uuid and command_id=req#>>'{provenance,undoOf}' and receipt->>'operation'='planning_management' and receipt->>'status'='COMMITTED')
 or exists(select 1 from public.pjsdas_command_ledger where user_id=(req->>'userId')::uuid and command_id=req#>>'{provenance,undoOf}' and operation='planning_management' and status='COMMITTED')) then
 raise exception 'planning undo target absent or foreign family' using errcode='42501';end if;

 select * into h from pjsdas_rows_candidate.head where id=(req->>'workspaceId')::uuid and user_id=(req->>'userId')::uuid for update;
 if not found then raise exception 'workspace owner mismatch' using errcode='42501';end if;
 if h.epoch is distinct from (req->>'expectedEpoch')::uuid then raise exception 'unsupported generation' using errcode='PT409';end if;
 -- Match the existing guard's stale-CAS semantics; core handles original replay.
 if h.revision=(req->>'expectedRevision')::bigint then
  if ((req#>'{afterEnvelope,data}')-array['decisionRules','timePlanning']) is distinct from ((h.envelope->'data')-array['decisionRules','timePlanning']) then
   raise exception 'planning cannot change protected envelope' using errcode='42501';end if;
  if exists(select 1 from jsonb_array_elements(req->'changes') c where c->>'collection' is distinct from 'timeline'
   or c->'before' is distinct from 'null'::jsonb or c->'after'='null'::jsonb) then
   raise exception 'planning only appends audit rows' using errcode='42501';end if;
  if (select coalesce(jsonb_agg(m order by m->>'collection'),'[]'::jsonb) from jsonb_array_elements(req->'afterManifest') m where m->>'collection'<>'timeline')
   is distinct from (select coalesce(jsonb_agg(m order by m->>'collection'),'[]'::jsonb) from jsonb_array_elements(h.manifest) m where m->>'collection'<>'timeline') then
   raise exception 'planning cannot alter protected collection presence/count' using errcode='42501';end if;
 end if;
 return pjsdas_rows_internal.apply_rows(req,jsonb_build_object('managementAuthorization',jsonb_build_object('grantId',active_grant.id,'grantRevision',active_grant.revision,'consentVersion',active_grant.consent_version)));
end$$;
revoke all on function pjsdas_rows_candidate.commit_planning(jsonb,uuid,bigint,text) from public,anon,authenticated;
grant execute on function pjsdas_rows_candidate.commit_planning(jsonb,uuid,bigint,text) to service_role;
