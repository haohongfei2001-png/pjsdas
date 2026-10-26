-- LOCAL SYNTHETIC ONLY. Not a production migration, runtime route or public API.
-- Existing v3 authority/evidence bounds are not changed. Upload is not authority.
create function pjsdas_rows_candidate.large_begin_opportunity(
 stage_id uuid,req jsonb,effect_count integer,final_digest text,
 target_grant_id uuid,target_grant_revision bigint,target_client_id text
) returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare s pjsdas_rows_candidate.large_stage%rowtype;h pjsdas_rows_candidate.head%rowtype;proof jsonb;
begin
 if req->>'principal' is distinct from 'delegated_mcp' or req->>'operation' is null
 or req->>'operation' not in ('opportunity_management','undo_command')
 or req ?| array['changes','clientId','managementAuthorization','aiCaptureAuthorization','discoveryAuthorization']
 or target_grant_id is null or target_grant_revision is null or target_grant_revision<1 or nullif(trim(target_client_id),'') is null
 or effect_count is null or effect_count<0 or effect_count>130048 or final_digest is null or final_digest !~ '^[0-9a-f]{64}$'
 or octet_length(req::text)>1048576 then raise exception 'unsupported staged opportunity contract' using errcode='22023';end if;
 proof:=jsonb_build_object('grantId',target_grant_id,'grantRevision',target_grant_revision,'clientId',target_client_id);
 select * into h from pjsdas_rows_candidate.head where id=(req->>'workspaceId')::uuid and user_id=(req->>'userId')::uuid;
 if not found or h.epoch is distinct from (req->>'expectedEpoch')::uuid or h.format is distinct from 'workspace-rows-v1' then raise exception 'owner/generation mismatch' using errcode='42501';end if;
 -- Bind the supplied identity now; deliberately do not cache a grant decision.
 -- Only finalize, under the original grant lock, may authorize a business write.
 insert into pjsdas_rows_candidate.large_stage(id,user_id,workspace_id,request,effect_count,final_digest,expires_at,family,authority)
 values(stage_id,h.user_id,h.id,req,effect_count,final_digest,clock_timestamp()+interval '1 hour','opportunity_v3',proof) on conflict(id) do nothing;
 select * into s from pjsdas_rows_candidate.large_stage where id=stage_id for update;
 if s.family is distinct from 'opportunity_v3' or s.authority is distinct from proof or s.request is distinct from req
 or s.effect_count is distinct from effect_count or s.final_digest is distinct from final_digest then raise exception 'stage identity collision' using errcode='23505';end if;
 if s.expires_at<=clock_timestamp() and s.result is null then raise exception 'expired stage' using errcode='22023';end if;
 -- Upload status is not an authorized command-replay endpoint.
 return jsonb_build_object('nextOrdinal',s.next_ordinal,'completed',s.result is not null);
end$$;

-- A relation, not a reconstructed JSON change array. Only private guards use it.
create function pjsdas_rows_internal.staged_changes(target_stage uuid) returns setof jsonb
language sql stable security invoker set search_path=pg_catalog as $$
 select effect from pjsdas_rows_candidate.large_effect where stage_id=target_stage order by ordinal
$$;

-- Exact original v3 guard below; source-parity testing verifies that only the
-- change source and staged transaction envelope differ from commit_opportunity.
create function pjsdas_rows_internal.commit_opportunity_staged(req jsonb,target_stage uuid,target_grant_id uuid,target_grant_revision bigint,target_client_id text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
declare
 s pjsdas_rows_candidate.large_stage%rowtype; staged_result jsonb;
 active_grant public.pjsdas_business_management_grants%rowtype;
 h pjsdas_rows_candidate.head%rowtype;
 target_user_id uuid := (req->>'userId')::uuid;
 target_operation text := req->>'operation';
 old_snapshot jsonb; target_snapshot jsonb; prior_evidence jsonb;
 old_evidence jsonb; row_evidence jsonb; old_found boolean; row_found boolean;
 old_operation text; row_operation text; old_status text; row_status text;
 evidence jsonb; changes jsonb; archives jsonb;
 old_history jsonb; new_history jsonb; old_rows jsonb; new_rows jsonb;
 retained_old jsonb; retained_new jsonb; expected_rows jsonb; change jsonb;
 before_row jsonb; after_row jsonb; current_row jsonb; proposed_row jsonb;
 kind text; collection text; row_index integer; selected_collection text;
 old_ids text[]; new_ids text[]; change_ids text[]; expected_ids text[]; insertion_index integer; kind_changes jsonb;
 affected text[] := array['opportunities','processes','processEvents','actions','scheduleNodes','reminderIntents'];
begin
 if req->>'principal' is distinct from 'delegated_mcp' or nullif(trim(target_client_id),'') is null
 or target_grant_id is null or target_grant_revision is null
 or target_operation is null or target_operation not in ('opportunity_management','undo_command')
 or req ?| array['managementAuthorization','aiCaptureAuthorization','discoveryAuthorization'] then
  raise exception 'opportunity authorization required or unsupported family' using errcode='42501';end if;
 select g.* into active_grant from public.pjsdas_business_management_grants g
 where g.id=target_grant_id and g.user_id=target_user_id and g.client_id::text=target_client_id
 and g.capability='workspace.opportunity.manage' and g.consent_version=3 and g.revision=target_grant_revision
 and g.revoked_at is null and g.granted_at<=now() for share;
 if not found then raise exception 'opportunity grant absent or stale' using errcode='42501';end if;
 prior_evidence := req->'compensation';
 if target_operation='undo_command' then
  select l.compensation,l.receipt->>'operation',l.receipt->>'status' into row_evidence,row_operation,row_status from pjsdas_rows_candidate.ledger l
   where l.user_id=target_user_id and l.command_id=req#>>'{provenance,undoOf}';
  row_found:=found;
  select l.compensation,l.operation,l.status into old_evidence,old_operation,old_status from public.pjsdas_command_ledger l
   where l.user_id=target_user_id and l.command_id=req#>>'{provenance,undoOf}';
  old_found:=found;
  if not(row_found or old_found)
   or (row_found and (row_operation is distinct from 'opportunity_management' or row_status is distinct from 'COMMITTED'))
   or (old_found and (old_operation is distinct from 'opportunity_management' or old_status is distinct from 'COMMITTED'))
   or (row_found and old_found and row_evidence is distinct from old_evidence) then
   raise exception 'opportunity undo target absent or ambiguous' using errcode='42501';end if;
  prior_evidence:=case when row_found then row_evidence else old_evidence end;
 end if;
 select * into h from pjsdas_rows_candidate.head where id=(req->>'workspaceId')::uuid and user_id=target_user_id for update;
 if not found then raise exception 'workspace owner mismatch' using errcode='42501';end if;
 if h.epoch is distinct from (req->>'expectedEpoch')::uuid then raise exception 'unsupported generation' using errcode='PT409';end if;
 -- Original lock order is grant -> workspace; stage is last, never before grant.
 select * into s from pjsdas_rows_candidate.large_stage where id=target_stage for update;
 if not found or s.user_id is distinct from target_user_id or s.workspace_id is distinct from h.id
 or s.family is distinct from 'opportunity_v3' or s.request is distinct from req
 or s.authority is distinct from jsonb_build_object('grantId',target_grant_id,'grantRevision',target_grant_revision,'clientId',target_client_id)
 or h.format is distinct from 'workspace-rows-v1' then raise exception 'stage identity/family mismatch' using errcode='42501';end if;
 -- Even cached completion rechecks the original authority and Undo family above.
 if s.result is not null then return s.result;end if;
 if s.expires_at<=clock_timestamp() or s.next_ordinal<>s.effect_count or s.rolling_digest<>s.final_digest then raise exception 'incomplete/expired/digest mismatch' using errcode='22023';end if;

 if h.revision=(req->>'expectedRevision')::bigint then
  -- Protect every collection not represented in the original guard, including
  -- absent versus empty arrays. Audit changes must be append-only.
  if exists(select 1 from pjsdas_rows_internal.staged_changes(target_stage) c where
    not ((c->>'collection')=any(affected||array['timeline']))) then
   raise exception 'opportunity cannot change unrelated collections' using errcode='42501';end if;
  if exists(select 1 from pjsdas_rows_internal.staged_changes(target_stage) c where c->>'collection'='timeline'
    and (c->'before' is distinct from 'null'::jsonb or c->'after'='null'::jsonb)) then
   raise exception 'opportunity audit must append' using errcode='42501';end if;
  if (select coalesce(jsonb_agg(m order by m->>'collection'),'[]'::jsonb) from jsonb_array_elements(req->'afterManifest') m where not (m->>'collection')=any(affected||array['timeline']))
   is distinct from (select coalesce(jsonb_agg(m order by m->>'collection'),'[]'::jsonb) from jsonb_array_elements(h.manifest) m where not (m->>'collection')=any(affected||array['timeline'])) then
   raise exception 'opportunity cannot alter unrelated collection presence' using errcode='42501';end if;
  old_snapshot:=jsonb_set(h.envelope,'{data,timeline}','[]'::jsonb);
  target_snapshot:=jsonb_set(req->'afterEnvelope','{data,timeline}','[]'::jsonb);
  foreach selected_collection in array affected||array['applicationGroups','reminderOutbox'] loop
   if exists(select 1 from jsonb_array_elements(h.manifest) m where m->>'collection'=selected_collection) then
    select coalesce(jsonb_agg(i.value order by i.ordinal),'[]'::jsonb) into old_rows from pjsdas_rows_candidate.item i where i.workspace_id=h.id and i.collection=selected_collection;
    old_snapshot:=jsonb_set(old_snapshot,array['data',selected_collection],old_rows);
   end if;
   if exists(select 1 from jsonb_array_elements(req->'afterManifest') m where m->>'collection'=selected_collection) then
    with projected as (
     select i.ordinal,i.value from pjsdas_rows_candidate.item i where i.workspace_id=h.id and i.collection=selected_collection
      and not exists(select 1 from pjsdas_rows_internal.staged_changes(target_stage) c where c->>'collection'=selected_collection and c->>'id'=i.id)
     union all select (c#>>'{after,ordinal}')::bigint,c#>'{after,value}' from pjsdas_rows_internal.staged_changes(target_stage) c
      where c->>'collection'=selected_collection and c->'after' is distinct from 'null'::jsonb
    ) select coalesce(jsonb_agg(value order by ordinal),'[]'::jsonb) into new_rows from projected;
    target_snapshot:=jsonb_set(target_snapshot,array['data',selected_collection],new_rows);
   end if;
  end loop;
    if (target_snapshot - array['data','version','exportedAt']) is distinct from (old_snapshot - array['data','version','exportedAt'])
      or ((target_snapshot -> 'data') - array['opportunities','processes','processEvents','actions','scheduleNodes','reminderIntents','timeline'])
        is distinct from ((old_snapshot -> 'data') - array['opportunities','processes','processEvents','actions','scheduleNodes','reminderIntents','timeline']) then
      raise exception 'Opportunity management cannot rewrite unrelated raw data.' using errcode = '42501';
    end if;
    old_history := coalesce(old_snapshot #> '{data,timeline}', '[]'::jsonb);
    new_history := coalesce(target_snapshot #> '{data,timeline}', '[]'::jsonb);
    if jsonb_typeof(old_history) is distinct from 'array' or jsonb_typeof(new_history) is distinct from 'array'
      or jsonb_array_length(new_history) < jsonb_array_length(old_history)
      or exists(select 1 from jsonb_array_elements(old_history) with ordinality e(value,n) where new_history -> ((e.n-1)::int) is distinct from e.value) then
      raise exception 'Opportunity management cannot rewrite existing audit history.' using errcode = '42501';
    end if;
    evidence := prior_evidence;
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
          select g into current_row from jsonb_array_elements(coalesce(old_snapshot#>'{data,applicationGroups}','[]'::jsonb)) g where g->>'id'=change->>'id';
        elsif change->>'type'='decision_rules' and change->>'id'='current' then
          current_row:=coalesce(old_snapshot#>'{data,decisionRules}','null'::jsonb);
        else raise exception 'Opportunity restore guard is invalid.' using errcode='42501';
        end if;
        if current_row is distinct from change->'value' then
          raise exception 'Opportunity restore parent or rules changed.' using errcode='42501';
        end if;
      end loop;
      -- A new dependency arriving after archive must not be adopted by undo,
      -- even if a caller preserves that new row in the proposed snapshot.
      if exists(select 1 from jsonb_array_elements(
          (old_snapshot#>'{data,processes}') || (old_snapshot#>'{data,processEvents}') || (old_snapshot#>'{data,actions}') || (old_snapshot#>'{data,scheduleNodes}') || (old_snapshot#>'{data,reminderIntents}')
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
      old_rows := old_snapshot -> 'data' -> collection;
      new_rows := target_snapshot -> 'data' -> collection;
      if jsonb_typeof(old_rows) is distinct from 'array' or jsonb_typeof(new_rows) is distinct from 'array'
        or exists(select 1 from jsonb_array_elements(old_rows || new_rows) r where jsonb_typeof(r->'id') is distinct from 'string' or nullif(trim(r->>'id'),'') is null)
        or (select count(*) from jsonb_array_elements(old_rows))<>(select count(distinct r->>'id') from jsonb_array_elements(old_rows) r)
        or (select count(*) from jsonb_array_elements(new_rows))<>(select count(distinct r->>'id') from jsonb_array_elements(new_rows) r) then
        raise exception 'Opportunity collections need exact unique identities.' using errcode = '42501';
      end if;
      -- Scalar sidecars are built only AFTER the original collection/evidence
      -- identity guards. They accelerate lookup, not JSONB equality or validation.
      select coalesce(array_agg(r.value->>'id' order by r.n),array[]::text[]) into old_ids from jsonb_array_elements(old_rows) with ordinality r(value,n);
      select coalesce(array_agg(r.value->>'id' order by r.n),array[]::text[]) into new_ids from jsonb_array_elements(new_rows) with ordinality r(value,n);
      select coalesce(jsonb_agg(c.value order by c.n),'[]'::jsonb),coalesce(array_agg(c.value->>'id' order by c.n),array[]::text[]) into kind_changes,change_ids
        from jsonb_array_elements(changes) with ordinality c(value,n) where c.value->>'type'=kind;
      if target_operation='opportunity_management' then
        select coalesce(jsonb_agg(coalesce(c.value->'after',r.value) order by r.n),'[]'::jsonb) into expected_rows
          from jsonb_array_elements(old_rows) with ordinality r(value,n)
          left join lateral (select kind_changes -> (array_position(change_ids,r.value->>'id')-1) as value) c on true
          where c.value is null or c.value->'after' is distinct from 'null'::jsonb;
        if expected_rows is distinct from new_rows then
          raise exception 'Opportunity edits must preserve exact retained row ordering.' using errcode = '42501';
        end if;
      end if;
      if target_operation='undo_command' then
        expected_rows:=old_rows; expected_ids:=old_ids;
        for change in select c from jsonb_array_elements(changes) c where c->>'type'=kind order by (c->>'beforeIndex')::numeric loop
          if jsonb_typeof(change->'beforeIndex') is distinct from 'number' or (change->>'beforeIndex')::numeric<0 or trunc((change->>'beforeIndex')::numeric)<>(change->>'beforeIndex')::numeric then
            raise exception 'Opportunity restore index is invalid.' using errcode='42501';
          end if;
          -- SQL '=' never matches a NULL probe; array_position otherwise keeps
          -- the original first match and default text collation, including bad
          -- before.id values whose original later guard must still reject them.
          row_index:=case when change->>'id' is null then null else array_position(expected_ids,change->>'id')-1 end;
          if row_index is not null then
            expected_rows:=jsonb_set(expected_rows,array[row_index::text],change->'before');
            if expected_rows is null then expected_ids:=null;
            else expected_ids[row_index+1]:=change#>>'{before,id}'; end if;
          else
            -- Keep this exact path expression and mutate JSONB FIRST. Numeric
            -- scale (1.0), strict SQL NULL and original errors must not change.
            expected_rows:=jsonb_insert(expected_rows,array[least(jsonb_array_length(expected_rows)::numeric,(change->>'beforeIndex')::numeric)::text],change->'before');
            if expected_rows is null then expected_ids:=null;
            else
              insertion_index:=least(cardinality(expected_ids)::numeric,(change->>'beforeIndex')::numeric)::int;
              expected_ids:=expected_ids[1:insertion_index] || array[change#>>'{before,id}'] || expected_ids[insertion_index+1:cardinality(expected_ids)];
            end if;
          end if;
        end loop;
        if expected_rows is distinct from new_rows then
          raise exception 'Opportunity restore must preserve exact retained row ordering.' using errcode='42501';
        end if;
      end if;
      -- Retained rows, metadata and relative ordering must be byte-semantic equal.
      select coalesce(jsonb_agg(r.value order by r.n),'[]'::jsonb) into retained_old from jsonb_array_elements(old_rows) with ordinality r(value,n)
        where not coalesce((r.value->>'id')=any(change_ids),false);
      select coalesce(jsonb_agg(r.value order by r.n),'[]'::jsonb) into retained_new from jsonb_array_elements(new_rows) with ordinality r(value,n)
        where not coalesce((r.value->>'id')=any(change_ids),false);
      if retained_old is distinct from retained_new then
        raise exception 'Opportunity management cannot rewrite unselected rows.' using errcode = '42501';
      end if;
      for change in select c from jsonb_array_elements(changes) c where c->>'type'=kind loop
        before_row := change->'before'; after_row := change->'after';
        if not change ? 'after' or jsonb_typeof(before_row) is distinct from 'object' or before_row->>'id' is distinct from change->>'id'
          or (after_row is distinct from 'null'::jsonb and (jsonb_typeof(after_row) is distinct from 'object' or after_row->>'id' is distinct from change->>'id')) then
          raise exception 'Opportunity row evidence identity is invalid.' using errcode = '42501';
        end if;
        current_row:=old_rows -> (array_position(old_ids,change->>'id')-1);
        proposed_row:=new_rows -> (array_position(new_ids,change->>'id')-1);
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
            or exists(select 1 from jsonb_array_elements(coalesce(old_snapshot#>'{data,reminderOutbox}','[]'::jsonb)) r where r->>'reminderIntentId'=before_row->>'id'))) then
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
 staged_result:=pjsdas_rows_internal.apply_staged_rows(req||jsonb_build_object('clientId',target_client_id),target_stage,jsonb_build_object('managementAuthorization',jsonb_build_object('grantId',active_grant.id,'grantRevision',active_grant.revision,'consentVersion',active_grant.consent_version)));
 if staged_result->>'outcome' in ('COMMITTED','ALREADY_APPLIED') then update pjsdas_rows_candidate.large_stage set result=staged_result where id=s.id;end if;
 return staged_result;
end$$;

create function pjsdas_rows_candidate.large_finish_opportunity(stage_id uuid,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare s pjsdas_rows_candidate.large_stage%rowtype;
begin
 -- No stage lock here: first acquire authority through the original v3 guard.
 select * into s from pjsdas_rows_candidate.large_stage where id=stage_id;
 if not found or s.user_id is distinct from target_user_id or s.family is distinct from 'opportunity_v3' then raise exception 'stage owner/family mismatch' using errcode='42501';end if;
 return pjsdas_rows_internal.commit_opportunity_staged(s.request,s.id,(s.authority->>'grantId')::uuid,(s.authority->>'grantRevision')::bigint,s.authority->>'clientId');
end$$;
revoke all on function pjsdas_rows_internal.staged_changes(uuid),pjsdas_rows_internal.commit_opportunity_staged(jsonb,uuid,uuid,bigint,text),pjsdas_rows_candidate.large_begin_opportunity(uuid,jsonb,integer,text,uuid,bigint,text),pjsdas_rows_candidate.large_finish_opportunity(uuid,uuid) from public,anon,authenticated;
grant execute on function pjsdas_rows_internal.staged_changes(uuid),pjsdas_rows_internal.commit_opportunity_staged(jsonb,uuid,uuid,bigint,text),pjsdas_rows_candidate.large_begin_opportunity(uuid,jsonb,integer,text,uuid,bigint,text),pjsdas_rows_candidate.large_finish_opportunity(uuid,uuid) to service_role;
