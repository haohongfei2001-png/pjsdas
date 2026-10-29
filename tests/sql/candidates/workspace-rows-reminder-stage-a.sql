-- Stage A only. Requires the real existing grant migration chain in an isolated DB.
-- No production function is replaced. Other management families stay rejected.
create function pjsdas_rows_candidate.commit_private_reminder(req jsonb,target_grant_id uuid,target_grant_revision bigint,target_client_id text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
declare
 active_grant public.pjsdas_business_management_grants%rowtype;
 h pjsdas_rows_candidate.head%rowtype;
 candidate jsonb; target_node jsonb;
begin
 if req->>'principal' is distinct from 'delegated_mcp' or nullif(trim(target_client_id),'') is null
 or target_grant_id is null or target_grant_revision is null
 or (req->>'operation') is null or (req->>'operation') not in ('private_reminder_management','undo_command')
 or req ?| array['managementAuthorization','aiCaptureAuthorization','discoveryAuthorization'] then
  raise exception 'private reminder authorization required or unsupported family' using errcode='42501';end if;
 -- Preserve real grant SHARE lock and revoke/replace/revision/owner/client checks.
 select g.* into active_grant from public.pjsdas_business_management_grants g
 where g.id=target_grant_id and g.user_id=(req->>'userId')::uuid and g.client_id::text=target_client_id
 and g.capability='workspace.reminders.manage' and g.consent_version=6 and g.revision=target_grant_revision
 and g.revoked_at is null and g.granted_at<=now() for share;
 if not found then raise exception 'private reminder grant absent or stale' using errcode='42501';end if;
 if req->>'operation'='undo_command' and not (
 exists(select 1 from pjsdas_rows_candidate.ledger where user_id=(req->>'userId')::uuid and command_id=req#>>'{provenance,undoOf}' and receipt->>'operation'='private_reminder_management' and receipt->>'status'='COMMITTED')
 or exists(select 1 from public.pjsdas_command_ledger where user_id=(req->>'userId')::uuid and command_id=req#>>'{provenance,undoOf}' and operation='private_reminder_management' and status='COMMITTED')) then
 raise exception 'private reminder undo target absent or foreign family' using errcode='42501';end if;

 select * into h from pjsdas_rows_candidate.head where id=(req->>'workspaceId')::uuid and user_id=(req->>'userId')::uuid for update;
 if not found then raise exception 'workspace owner mismatch' using errcode='42501';end if;
 if h.epoch is distinct from (req->>'expectedEpoch')::uuid then raise exception 'unsupported generation' using errcode='PT409';end if;
 -- Match the existing guard's stale-CAS semantics; core handles original replay.
 if h.revision=(req->>'expectedRevision')::bigint then
  if req#>'{afterEnvelope,data}' is distinct from h.envelope->'data' then raise exception 'private reminder cannot change protected data' using errcode='42501';end if;
  if exists(select 1 from jsonb_array_elements(req->'changes') c where c->>'collection' not in ('reminderIntents','timeline')
   or (c->>'collection'='timeline' and (c->'before' is distinct from 'null'::jsonb or c->'after'='null'::jsonb))) then
   raise exception 'private reminder cannot change other objects or prior audit' using errcode='42501';end if;
  if not exists(select 1 from jsonb_array_elements(h.manifest) m where m->>'collection'='reminderIntents')
   or not exists(select 1 from jsonb_array_elements(req->'afterManifest') m where m->>'collection'='reminderIntents') then
   raise exception 'explicit reminder migration required' using errcode='42501';end if;
  if (select coalesce(jsonb_agg(m order by m->>'collection'),'[]'::jsonb) from jsonb_array_elements(req->'afterManifest') m where m->>'collection' not in ('reminderIntents','timeline'))
   is distinct from (select coalesce(jsonb_agg(m order by m->>'collection'),'[]'::jsonb) from jsonb_array_elements(h.manifest) m where m->>'collection' not in ('reminderIntents','timeline')) then
   raise exception 'private reminder cannot alter protected collections' using errcode='42501';end if;
  if exists(with projected as not materialized (
 select i.id,i.ordinal,i.value from pjsdas_rows_candidate.item i where i.workspace_id=h.id and i.collection='reminderIntents'
 and not exists(select 1 from jsonb_array_elements(req->'changes') c where c->>'collection'='reminderIntents' and c->>'id'=i.id)
 union all select c->>'id',(c#>>'{after,ordinal}')::bigint,c#>'{after,value}' from jsonb_array_elements(req->'changes') c
 where c->>'collection'='reminderIntents' and c->'after' is distinct from 'null'::jsonb
) select 1 from projected where jsonb_typeof(value->'id') is distinct from 'string' or nullif(btrim(value->>'id'),'') is null) then
   raise exception 'reminder identity invalid' using errcode='42501';end if;
  -- Preserve external/outbox-linked/unclassifiable values AND relative order.
  if exists(with projected as not materialized (
 select i.id,i.ordinal,i.value from pjsdas_rows_candidate.item i where i.workspace_id=h.id and i.collection='reminderIntents'
 and not exists(select 1 from jsonb_array_elements(req->'changes') c where c->>'collection'='reminderIntents' and c->>'id'=i.id)
 union all select c->>'id',(c#>>'{after,ordinal}')::bigint,c#>'{after,value}' from jsonb_array_elements(req->'changes') c
 where c->>'collection'='reminderIntents' and c->'after' is distinct from 'null'::jsonb
),
   old_protected as (select i.id,i.value,row_number() over(order by i.ordinal) position from pjsdas_rows_candidate.item i where i.workspace_id=h.id and i.collection='reminderIntents' and (i.value->>'deliveryOwner'='pjsdas' and i.value->>'channel'='in_product' and not(i.value?'capability') and not(i.value?'externalLink')
 and not exists(select 1 from pjsdas_rows_candidate.item o where o.workspace_id=h.id and o.collection='reminderOutbox' and o.value->>'reminderIntentId'=i.id)) is not true),
   new_protected as (select i.id,i.value,row_number() over(order by i.ordinal) position from projected i where (i.value->>'deliveryOwner'='pjsdas' and i.value->>'channel'='in_product' and not(i.value?'capability') and not(i.value?'externalLink')
 and not exists(select 1 from pjsdas_rows_candidate.item o where o.workspace_id=h.id and o.collection='reminderOutbox' and o.value->>'reminderIntentId'=i.id)) is not true)
   select 1 from old_protected a full join new_protected b using(position) where a.id is distinct from b.id or a.value is distinct from b.value) then
   raise exception 'protected reminders cannot change' using errcode='42501';end if;
  for candidate in select c#>'{after,value}' from jsonb_array_elements(req->'changes') c where c->>'collection'='reminderIntents' and c->'after'<>'null'::jsonb loop
   if exists(select 1 from pjsdas_rows_candidate.item i where i.workspace_id=h.id and i.collection='reminderIntents' and i.value=candidate) then continue;end if;
   if (candidate->>'deliveryOwner'='pjsdas' and candidate->>'channel'='in_product' and not(candidate?'capability') and not(candidate?'externalLink')) is not true then
    raise exception 'only private in-product reminders writable' using errcode='42501';end if;
   select i.value into target_node from pjsdas_rows_candidate.item i where i.workspace_id=h.id and i.collection='scheduleNodes' and i.id=candidate->>'scheduleNodeId';
   if not found or candidate->'scheduleNodeVersion' is distinct from target_node->'version'
    or candidate->>'dedupeKey' is distinct from ((target_node->>'id')||'@'||(target_node->>'version')||'|'||(candidate->>'purpose')) then
    raise exception 'reminder target stale or inconsistent' using errcode='42501';end if;
   if candidate->>'state'='active' then
    if (target_node->>'state' in ('scheduled','in_progress','elapsed_unresolved')) is not true
     or exists(select 1 from pjsdas_rows_candidate.item i where i.workspace_id=h.id and i.collection='scheduleNodes' and i.value->>'occurrenceId'=target_node->>'occurrenceId' and (i.value->>'version')::bigint>(target_node->>'version')::bigint)
     or exists(with projected as not materialized (
 select i.id,i.ordinal,i.value from pjsdas_rows_candidate.item i where i.workspace_id=h.id and i.collection='reminderIntents'
 and not exists(select 1 from jsonb_array_elements(req->'changes') c where c->>'collection'='reminderIntents' and c->>'id'=i.id)
 union all select c->>'id',(c#>>'{after,ordinal}')::bigint,c#>'{after,value}' from jsonb_array_elements(req->'changes') c
 where c->>'collection'='reminderIntents' and c->'after' is distinct from 'null'::jsonb
) select 1 from projected i where i.id is distinct from candidate->>'id' and (i.value->>'dedupeKey'=candidate->>'dedupeKey' or i.value->>'scheduleNodeId'=candidate->>'scheduleNodeId' and i.value->>'purpose'=candidate->>'purpose')) then
     raise exception 'reminder activation conflicts with target or owner' using errcode='42501';end if;
   end if;
  end loop;
 end if;
 return pjsdas_rows_internal.apply_rows(req||jsonb_build_object('clientId',target_client_id),jsonb_build_object('managementAuthorization',jsonb_build_object('grantId',active_grant.id,'grantRevision',active_grant.revision,'consentVersion',active_grant.consent_version)));
end$$;
revoke all on function pjsdas_rows_candidate.commit_private_reminder(jsonb,uuid,bigint,text) from public,anon,authenticated;
grant execute on function pjsdas_rows_candidate.commit_private_reminder(jsonb,uuid,bigint,text) to service_role;
