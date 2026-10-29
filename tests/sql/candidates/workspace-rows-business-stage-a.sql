-- Isolated Stage A only. Exact v7 business evidence guard, real consent hash,
-- and scoped collection projection; no production function replacement.
create function pjsdas_rows_candidate.commit_business(req jsonb,target_grant_id uuid,target_grant_revision bigint,target_client_id text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
declare
 active_grant public.pjsdas_business_management_grants%rowtype;
 h pjsdas_rows_candidate.head%rowtype;
 target_user_id uuid := (req->>'userId')::uuid;
 target_operation text := req->>'operation';
 old_snapshot jsonb; target_snapshot jsonb; prior_evidence jsonb;
 old_evidence jsonb; row_evidence jsonb; old_found boolean; row_found boolean;
 old_operation text; row_operation text; old_status text; row_status text; old_consent jsonb; row_consent jsonb;
 evidence jsonb; changes jsonb; archives jsonb;
 old_history jsonb; new_history jsonb; old_rows jsonb; new_rows jsonb;
 retained_old jsonb; retained_new jsonb; expected_rows jsonb; change jsonb;
 before_row jsonb; after_row jsonb; current_row jsonb; proposed_row jsonb;
 kind text; collection text; row_index integer; selected_collection text;
 affected text[] := array['prep','actions','applicationGroups'];
begin
 if req->>'principal' is distinct from 'delegated_mcp' or nullif(trim(target_client_id),'') is null
 or target_grant_id is null or target_grant_revision is null
 or target_operation is null or target_operation not in ('business_management','undo_command')
 or req ?| array['managementAuthorization','aiCaptureAuthorization','discoveryAuthorization'] then
  raise exception 'business authorization required or unsupported family' using errcode='42501';end if;
 select g.* into active_grant from public.pjsdas_business_management_grants g
 where g.id=target_grant_id and g.user_id=target_user_id and g.client_id::text=target_client_id
 and g.capability='workspace.business.manage' and g.consent_version=7 and g.consent_text_hash='22626aea373e4e8eb51a90ee4b548c5f3aeeee4bbe58e77b418a0645138edb34' and g.revision=target_grant_revision
 and g.revoked_at is null and g.granted_at<=now() for share;
 if not found then raise exception 'business grant absent or stale' using errcode='42501';end if;
 prior_evidence := req->'compensation';
 if target_operation='undo_command' then
  select l.compensation,l.receipt->>'operation',l.receipt->>'status',l.receipt#>'{managementAuthorization,consentVersion}' into row_evidence,row_operation,row_status,row_consent from pjsdas_rows_candidate.ledger l
   where l.user_id=target_user_id and l.command_id=req#>>'{provenance,undoOf}';
  row_found:=found;
  select l.compensation,l.operation,l.status,l.receipt#>'{managementAuthorization,consentVersion}' into old_evidence,old_operation,old_status,old_consent from public.pjsdas_command_ledger l
   where l.user_id=target_user_id and l.command_id=req#>>'{provenance,undoOf}';
  old_found:=found;
  if not(row_found or old_found)
   or (row_found and (row_operation is distinct from 'business_management' or row_status is distinct from 'COMMITTED' or row_consent is distinct from '7'::jsonb))
   or (old_found and (old_operation is distinct from 'business_management' or old_status is distinct from 'COMMITTED' or old_consent is distinct from '7'::jsonb))
   or (row_found and old_found and row_evidence is distinct from old_evidence) then
   raise exception 'business undo target absent or ambiguous' using errcode='42501';end if;
  prior_evidence:=case when row_found then row_evidence else old_evidence end;
 end if;
 select * into h from pjsdas_rows_candidate.head where id=(req->>'workspaceId')::uuid and user_id=target_user_id for update;
 if not found then raise exception 'workspace owner mismatch' using errcode='42501';end if;
 if h.epoch is distinct from (req->>'expectedEpoch')::uuid then raise exception 'unsupported generation' using errcode='PT409';end if;
 if exists(select 1 from pjsdas_rows_candidate.ledger l where l.user_id=target_user_id and l.command_id=req->>'commandId'
   and (l.receipt->>'operation' is distinct from target_operation or l.receipt#>'{managementAuthorization,consentVersion}' is distinct from '7'::jsonb))
 or exists(select 1 from public.pjsdas_command_ledger l where l.user_id=target_user_id and l.command_id=req->>'commandId'
   and (l.operation is distinct from target_operation or l.receipt#>'{managementAuthorization,consentVersion}' is distinct from '7'::jsonb)) then
  raise exception 'command reused across operation or consent family' using errcode='23505';end if;
 if h.revision=(req->>'expectedRevision')::bigint then
  -- Protect every collection not represented in the original guard, including
  -- absent versus empty arrays. Audit changes must be append-only.
  if exists(select 1 from jsonb_array_elements(req->'changes') c where
    not ((c->>'collection')=any(affected||array['timeline']))) then
   raise exception 'business cannot change unrelated collections' using errcode='42501';end if;
  if exists(select 1 from jsonb_array_elements(req->'changes') c where c->>'collection'='timeline'
    and (c->'before' is distinct from 'null'::jsonb or c->'after'='null'::jsonb)) then
   raise exception 'business audit must append' using errcode='42501';end if;
  if (select coalesce(jsonb_agg(m order by m->>'collection'),'[]'::jsonb) from jsonb_array_elements(req->'afterManifest') m where not (m->>'collection')=any(affected||array['timeline']))
   is distinct from (select coalesce(jsonb_agg(m order by m->>'collection'),'[]'::jsonb) from jsonb_array_elements(h.manifest) m where not (m->>'collection')=any(affected||array['timeline'])) then
   raise exception 'business cannot alter unrelated collection presence' using errcode='42501';end if;
  old_snapshot:=jsonb_set(h.envelope,'{data,timeline}','[]'::jsonb);
  target_snapshot:=jsonb_set(req->'afterEnvelope','{data,timeline}','[]'::jsonb);
  foreach selected_collection in array affected loop
   if exists(select 1 from jsonb_array_elements(h.manifest) m where m->>'collection'=selected_collection) then
    select coalesce(jsonb_agg(i.value order by i.ordinal),'[]'::jsonb) into old_rows from pjsdas_rows_candidate.item i where i.workspace_id=h.id and i.collection=selected_collection;
    old_snapshot:=jsonb_set(old_snapshot,array['data',selected_collection],old_rows);
   end if;
   if exists(select 1 from jsonb_array_elements(req->'afterManifest') m where m->>'collection'=selected_collection) then
    with projected as (
     select i.ordinal,i.value from pjsdas_rows_candidate.item i where i.workspace_id=h.id and i.collection=selected_collection
      and not exists(select 1 from jsonb_array_elements(req->'changes') c where c->>'collection'=selected_collection and c->>'id'=i.id)
     union all select (c#>>'{after,ordinal}')::bigint,c#>'{after,value}' from jsonb_array_elements(req->'changes') c
      where c->>'collection'=selected_collection and c->'after' is distinct from 'null'::jsonb
    ) select coalesce(jsonb_agg(value order by ordinal),'[]'::jsonb) into new_rows from projected;
    target_snapshot:=jsonb_set(target_snapshot,array['data',selected_collection],new_rows);
   end if;
  end loop;
    if (target_snapshot - array['data','exportedAt']) is distinct from (old_snapshot - array['data','exportedAt'])
      or ((target_snapshot->'data')-array['prep','actions','applicationGroups','timeline']) is distinct from ((old_snapshot->'data')-array['prep','actions','applicationGroups','timeline']) then
      raise exception 'Consumer business edits cannot change unrelated raw data.' using errcode='42501';
    end if;
    old_history:=coalesce(old_snapshot#>'{data,timeline}','[]'::jsonb);
    new_history:=coalesce(target_snapshot#>'{data,timeline}','[]'::jsonb);
    if jsonb_typeof(old_history) is distinct from 'array' or jsonb_typeof(new_history) is distinct from 'array'
      or jsonb_array_length(new_history)<jsonb_array_length(old_history)
      or exists(select 1 from jsonb_array_elements(old_history) with ordinality e(value,n) where new_history->((e.n-1)::int) is distinct from e.value) then
      raise exception 'Existing audit history must be retained.' using errcode='42501';
    end if;
    evidence:=prior_evidence;
    changes:=evidence#>'{payload,changes}';
    if evidence->>'operation' is distinct from 'business_management_restore' or jsonb_typeof(changes) is distinct from 'array'
      or jsonb_array_length(changes) not between 1 and 50 or public.pjsdas_opportunity_evidence_bytes_v1(evidence)>1048576
      or exists(select 1 from jsonb_array_elements(changes) c where jsonb_typeof(c) is distinct from 'object' or c->>'type' is null or c->>'type' not in ('prep','action','application_group') or nullif(trim(c->>'id'),'') is null)
      or (select count(*) from jsonb_array_elements(changes))<>(select count(distinct(c->>'type',c->>'id')) from jsonb_array_elements(changes) c) then
      raise exception 'Bounded exact business change evidence is required.' using errcode='42501';
    end if;
    for kind,collection in select * from (values('prep','prep'),('action','actions'),('application_group','applicationGroups')) p(kind,collection) loop
      old_rows:=old_snapshot->'data'->collection;new_rows:=target_snapshot->'data'->collection;expected_rows:=old_rows;
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
 return pjsdas_rows_internal.apply_rows(req||jsonb_build_object('clientId',target_client_id),jsonb_build_object('managementAuthorization',jsonb_build_object('grantId',active_grant.id,'grantRevision',active_grant.revision,'consentVersion',active_grant.consent_version)));
end$$;
revoke all on function pjsdas_rows_candidate.commit_business(jsonb,uuid,bigint,text) from public,anon,authenticated;
grant execute on function pjsdas_rows_candidate.commit_business(jsonb,uuid,bigint,text) to service_role;
