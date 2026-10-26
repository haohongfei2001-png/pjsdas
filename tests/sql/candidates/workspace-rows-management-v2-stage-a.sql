-- Isolated compatibility entry for the pre-existing broad v2 management grant.
-- It neither upgrades a v2 grant to v7 nor creates new domain capabilities.
-- Current domain-core retirement checks remain in the application layer, just
-- as with the original v2 RPC. No production function is replaced.
create function pjsdas_rows_candidate.commit_management_v2(req jsonb,target_grant_id uuid,target_grant_revision bigint,target_client_id text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
declare
 active_grant public.pjsdas_business_management_grants%rowtype;
 h pjsdas_rows_candidate.head%rowtype;
 target_user_id uuid:=(req->>'userId')::uuid;
begin
 if req->>'principal' is distinct from 'delegated_mcp' or nullif(trim(target_client_id),'') is null
 or target_grant_id is null or target_grant_revision is null
 or req->>'operation' is null or req->>'operation' not in ('business_management','undo_command')
 or req ?| array['managementAuthorization','aiCaptureAuthorization','discoveryAuthorization'] then
  raise exception 'v2 management authority required' using errcode='42501';end if;
 select g.* into active_grant from public.pjsdas_business_management_grants g
 where g.id=target_grant_id and g.user_id=target_user_id and g.client_id::text=target_client_id
 and g.capability='workspace.manage' and g.consent_version=2 and g.revision=target_grant_revision
 and g.revoked_at is null and g.granted_at<=now() for share;
 if not found then raise exception 'v2 grant absent or stale' using errcode='42501';end if;
 if req->>'operation'='undo_command' then
  if not (exists(select 1 from public.pjsdas_command_ledger l where l.user_id=target_user_id and l.command_id=req#>>'{provenance,undoOf}' and l.operation='business_management' and l.status='COMMITTED' and l.receipt#>>'{managementAuthorization,consentVersion}' is distinct from '7')
   or exists(select 1 from pjsdas_rows_candidate.ledger l where l.user_id=target_user_id and l.command_id=req#>>'{provenance,undoOf}' and l.receipt->>'operation'='business_management' and l.receipt->>'status'='COMMITTED' and l.receipt#>>'{managementAuthorization,consentVersion}' is distinct from '7'))
   or exists(select 1 from public.pjsdas_command_ledger l where l.user_id=target_user_id and l.command_id=req#>>'{provenance,undoOf}' and l.receipt#>>'{managementAuthorization,consentVersion}'='7')
   or exists(select 1 from pjsdas_rows_candidate.ledger l where l.user_id=target_user_id and l.command_id=req#>>'{provenance,undoOf}' and l.receipt#>>'{managementAuthorization,consentVersion}'='7') then
   raise exception 'v2 undo target absent or belongs to v7' using errcode='42501';end if;
 end if;
 select * into h from pjsdas_rows_candidate.head where id=(req->>'workspaceId')::uuid and user_id=target_user_id for update;
 if not found then raise exception 'workspace owner mismatch' using errcode='42501';end if;
 if h.epoch is distinct from (req->>'expectedEpoch')::uuid then raise exception 'unsupported generation' using errcode='PT409';end if;
 if exists(select 1 from public.pjsdas_command_ledger l where l.user_id=target_user_id and l.command_id=req->>'commandId' and l.receipt#>>'{managementAuthorization,consentVersion}'='7')
 or exists(select 1 from pjsdas_rows_candidate.ledger l where l.user_id=target_user_id and l.command_id=req->>'commandId' and l.receipt#>>'{managementAuthorization,consentVersion}'='7') then
  raise exception 'command reused across consent family' using errcode='23505';end if;
 return pjsdas_rows_internal.apply_rows(req||jsonb_build_object('clientId',target_client_id),jsonb_build_object('managementAuthorization',jsonb_build_object('grantId',active_grant.id,'grantRevision',active_grant.revision,'consentVersion',active_grant.consent_version)));
end$$;
revoke all on function pjsdas_rows_candidate.commit_management_v2(jsonb,uuid,bigint,text) from public,anon,authenticated;
grant execute on function pjsdas_rows_candidate.commit_management_v2(jsonb,uuid,bigint,text) to service_role;
