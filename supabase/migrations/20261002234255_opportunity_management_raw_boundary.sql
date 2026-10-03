-- SOURCE ONLY repair; v2 is byte-identical and v3 remains dormant.
-- Count the compact JSON wire representation, not PostgreSQL's whitespace-
-- expanded jsonb::text. Numeric scalars preserve exact decimal significance
-- and use the wire format's fixed/exponent cutoffs (-6 through 20 fixed).
create or replace function public.pjsdas_opportunity_evidence_bytes_v1(value jsonb, depth integer default 0)
returns bigint language plpgsql immutable strict security invoker
set search_path = pg_catalog, pg_temp as $$
declare
  item record; bytes bigint := 2; items bigint := 0;
  encoded text; coefficient text; digits text; sign text := '';
  exponent integer; decimal_position integer; leading_zeroes integer;
begin
  if depth<0 or depth>128 then raise exception 'Opportunity evidence exceeds its structural depth bound.' using errcode='42501';end if;
  case jsonb_typeof(value)
    when 'object' then
      for item in select * from jsonb_each(value) loop
        bytes := bytes + octet_length(to_json(item.key)::text) + 1
          + public.pjsdas_opportunity_evidence_bytes_v1(item.value,depth+1);
        if items>0 then bytes:=bytes+1; end if;
        items:=items+1;
        if bytes>1048576 then return bytes; end if;
      end loop;
      return bytes;
    when 'array' then
      for item in select * from jsonb_array_elements(value) loop
        bytes:=bytes+public.pjsdas_opportunity_evidence_bytes_v1(item.value,depth+1);
        if items>0 then bytes:=bytes+1; end if;
        items:=items+1;
        if bytes>1048576 then return bytes; end if;
      end loop;
      return bytes;
    when 'number' then
      -- No float conversion: retain every significant decimal digit from the
      -- exact JSONB numeric. Only insignificant zeroes and notation change.
      encoded:=value#>>'{}';
      if encoded !~ '^-?[0-9]+(\.[0-9]+)?$' then
        raise exception 'Opportunity evidence numeric spelling is unsupported.' using errcode='42501';
      end if;
      if left(encoded,1)='-' then sign:='-';encoded:=substr(encoded,2);end if;
      coefficient:=replace(encoded,'.','');
      leading_zeroes:=length(coefficient)-length(ltrim(coefficient,'0'));
      digits:=rtrim(ltrim(coefficient,'0'),'0');
      if digits='' then return 1;end if;
      decimal_position:=length(split_part(encoded,'.',1))-leading_zeroes;
      exponent:=decimal_position-1;
      if exponent between -6 and 20 then
        if decimal_position<=0 then encoded:=sign||'0.'||repeat('0',-decimal_position)||digits;
        elsif decimal_position>=length(digits) then encoded:=sign||digits||repeat('0',decimal_position-length(digits));
        else encoded:=sign||left(digits,decimal_position)||'.'||substr(digits,decimal_position+1);
        end if;
      else
        encoded:=sign||left(digits,1)||case when length(digits)>1 then '.'||substr(digits,2) else '' end
          ||'e'||case when exponent>=0 then '+' else '' end||exponent::text;
      end if;
      return octet_length(encoded);
    when 'string' then return octet_length(value::text);
    when 'boolean' then return octet_length(value::text);
    when 'null' then return 4;
    else raise exception 'Management evidence must be JSON.' using errcode='42501';
  end case;
end $$;
revoke all on function public.pjsdas_opportunity_evidence_bytes_v1(jsonb,integer) from public,anon,authenticated;
grant execute on function public.pjsdas_opportunity_evidence_bytes_v1(jsonb,integer) to service_role;

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
revoke all on function public.pjsdas_commit_opportunity_workspace_v1(
  uuid, text, text, text, bigint, jsonb, integer, text, text, jsonb, jsonb, timestamptz, jsonb, uuid, bigint
) from public, anon, authenticated;
grant execute on function public.pjsdas_commit_opportunity_workspace_v1(
  uuid, text, text, text, bigint, jsonb, integer, text, text, jsonb, jsonb, timestamptz, jsonb, uuid, bigint
) to service_role;
