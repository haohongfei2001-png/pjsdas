-- SOURCE ONLY. Distinct consumer agreement; no legacy owner v2 grant upgrade.
alter table public.pjsdas_business_management_grants drop constraint pjsdas_management_capability_version_check;
alter table public.pjsdas_business_management_grants add constraint pjsdas_management_capability_version_check check (
 (capability='workspace.manage' and consent_version=2) or (capability='workspace.opportunity.manage' and consent_version=3)
 or (capability='workspace.planning.manage' and consent_version=4) or (capability='workspace.discovery-profile.manage' and consent_version=5)
 or (capability='workspace.reminders.manage' and consent_version=6) or (capability='workspace.business.manage' and consent_version=7));

create or replace function public.pjsdas_commit_consumer_business_workspace_v1(
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
  evidence jsonb; changes jsonb; change jsonb; kind text; collection text;
  old_rows jsonb; new_rows jsonb; expected_rows jsonb; current_row jsonb;
  before_row jsonb; after_row jsonb; row_index integer; old_history jsonb; new_history jsonb;
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
      and g.capability = 'workspace.business.manage'
      and g.consent_version = 7
      and g.consent_text_hash = '22626aea373e4e8eb51a90ee4b548c5f3aeeee4bbe58e77b418a0645138edb34'
      and g.revision = target_grant_revision
      and g.revoked_at is null
      and g.granted_at <= now()
    for share;
  if not found then
    raise exception 'Management grant is absent, revoked, replaced or stale.' using errcode = '42501';
  end if;

  if target_operation = 'undo_command' then
    perform 1 from public.pjsdas_command_ledger l
      where user_id = target_user_id
        and command_id = target_provenance ->> 'undoOf'
        and operation = 'business_management'
        and l.receipt #> '{managementAuthorization,consentVersion}' = '7'::jsonb
        and status = 'COMMITTED';
    if not found then
      raise exception 'Management undo target was not found.' using errcode = '42501';
    end if;
  elsif target_operation is distinct from 'business_management' then
    raise exception 'Unsupported management operation.' using errcode = '42501';
  end if;

  select w.* into stored_workspace from public.pjsdas_workspaces w where w.user_id=target_user_id for update;
  if exists(select 1 from public.pjsdas_command_ledger l where l.user_id=target_user_id and l.command_id=target_command_id and (l.operation is distinct from target_operation or l.receipt#>'{managementAuthorization,consentVersion}' is distinct from '7'::jsonb)) then
    raise exception 'Command id was reused with a different payload or consent family.' using errcode='23505';
  end if;
  if stored_workspace.id is not null and stored_workspace.revision=target_expected_revision then
    if (target_snapshot - array['data','exportedAt']) is distinct from (stored_workspace.snapshot - array['data','exportedAt'])
      or target_schema_version is distinct from stored_workspace.schema_version
      or ((target_snapshot->'data')-array['prep','actions','applicationGroups','timeline']) is distinct from ((stored_workspace.snapshot->'data')-array['prep','actions','applicationGroups','timeline']) then
      raise exception 'Consumer business edits cannot change unrelated raw data.' using errcode='42501';
    end if;
    old_history:=coalesce(stored_workspace.snapshot#>'{data,timeline}','[]'::jsonb);
    new_history:=coalesce(target_snapshot#>'{data,timeline}','[]'::jsonb);
    if jsonb_typeof(old_history) is distinct from 'array' or jsonb_typeof(new_history) is distinct from 'array'
      or jsonb_array_length(new_history)<jsonb_array_length(old_history)
      or exists(select 1 from jsonb_array_elements(old_history) with ordinality e(value,n) where new_history->((e.n-1)::int) is distinct from e.value) then
      raise exception 'Existing audit history must be retained.' using errcode='42501';
    end if;
    if target_operation='undo_command' then
      select l.compensation into evidence from public.pjsdas_command_ledger l where l.user_id=target_user_id and l.command_id=target_provenance->>'undoOf' and l.operation='business_management' and l.status='COMMITTED' and l.receipt#>'{managementAuthorization,consentVersion}'='7'::jsonb;
    else evidence:=target_compensation;end if;
    changes:=evidence#>'{payload,changes}';
    if evidence->>'operation' is distinct from 'business_management_restore' or jsonb_typeof(changes) is distinct from 'array'
      or jsonb_array_length(changes) not between 1 and 50 or public.pjsdas_opportunity_evidence_bytes_v1(evidence)>1048576
      or exists(select 1 from jsonb_array_elements(changes) c where jsonb_typeof(c) is distinct from 'object' or c->>'type' is null or c->>'type' not in ('prep','action','application_group') or nullif(trim(c->>'id'),'') is null)
      or (select count(*) from jsonb_array_elements(changes))<>(select count(distinct(c->>'type',c->>'id')) from jsonb_array_elements(changes) c) then
      raise exception 'Bounded exact business change evidence is required.' using errcode='42501';
    end if;
    for kind,collection in select * from (values('prep','prep'),('action','actions'),('application_group','applicationGroups')) p(kind,collection) loop
      old_rows:=stored_workspace.snapshot->'data'->collection;new_rows:=target_snapshot->'data'->collection;expected_rows:=old_rows;
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
revoke all on function public.pjsdas_commit_consumer_business_workspace_v1(
  uuid, text, text, text, bigint, jsonb, integer, text, text, jsonb, jsonb, timestamptz, jsonb, uuid, bigint
) from public, anon, authenticated;
grant execute on function public.pjsdas_commit_consumer_business_workspace_v1(
  uuid, text, text, text, bigint, jsonb, integer, text, text, jsonb, jsonb, timestamptz, jsonb, uuid, bigint
) to service_role;

create or replace function public.pjsdas_decide_scoped_management_consent_v1(
 target_user_id uuid,target_client_id uuid,target_request_id uuid,target_request_hash text,
 target_choices jsonb,target_first_party boolean,target_provider_client_verified boolean,
 target_consumer_enabled boolean,target_audience_mode text
) returns table(receipts jsonb)
language plpgsql security invoker set search_path=public,pg_temp as $$
declare
 previous public.pjsdas_scoped_management_consent_events%rowtype;
 current_grant public.pjsdas_business_management_grants%rowtype;
 choice jsonb; scope_name text; scope_capability text; scope_version integer; scope_hash text;
 expected_id uuid; expected_revision bigint; choice_keys integer; proof_keys integer;
 result_receipts jsonb := '[]'::jsonb; result_outcome text; admission_denied boolean:=false;
begin
 if target_first_party is distinct from true or target_user_id is null or target_client_id is null or target_request_id is null
  or target_request_hash is null or target_request_hash !~ '^[0-9a-f]{64}$'
  or target_consumer_enabled is null or target_audience_mode is null or target_audience_mode not in ('allowlist','legacy')
  or jsonb_typeof(target_choices) is distinct from 'array'
  or jsonb_array_length(target_choices) not between 1 and 5
  or octet_length(target_choices::text)>8192 then
  raise exception 'Explicit bounded first-party consent required.' using errcode='42501';
 end if;
 -- Independent scoped key: v2 keeps its existing audience -> advisory order.
 perform pg_advisory_xact_lock(hashtextextended('ta-scoped-management-consent:'||target_user_id::text,0));
 select e.* into previous from public.pjsdas_scoped_management_consent_events e where e.user_id=target_user_id and e.request_id=target_request_id;
 if found then
  if previous.client_id is distinct from target_client_id or previous.request_hash is distinct from target_request_hash or previous.choices is distinct from target_choices then
   raise exception 'Consent request ID reused.' using errcode='23505';
  end if;
  -- Historical receipt only; replay never issues or reactivates a grant.
  return query select previous.receipts;return;
 end if;
 -- Approval rechecks and locks the configured audience within this transaction.
 -- Exact owned revocation remains possible after admission/provider disconnect.
 if exists(select 1 from jsonb_array_elements(target_choices) c where c->>'decision'='approve')
  and (not target_consumer_enabled or target_audience_mode='allowlist') then
  perform 1 from public.pjsdas_access_grants a where a.user_id=target_user_id
   and (a.role='owner' or (target_consumer_enabled and a.role='beta')) and a.revoked_at is null for share;
  if not found then admission_denied:=true;end if;
 end if;
 if (select count(distinct item->>'domain') from jsonb_array_elements(target_choices) item)<>jsonb_array_length(target_choices) then
  raise exception 'Duplicate or missing scope.' using errcode='22023';
 end if;
 if target_provider_client_verified is distinct from true and exists(select 1 from jsonb_array_elements(target_choices) c where c->>'decision'='approve') then admission_denied:=true;end if;
 if not target_consumer_enabled and exists(select 1 from jsonb_array_elements(target_choices) c where c->>'domain'='business' and c->>'decision'='approve') then admission_denied:=true;end if;
 -- Validate explicit choices and lock/update their grant rows in stable order.
 -- Errors in any scope roll back the entire batch, including its audit event.
 for choice in select value from jsonb_array_elements(target_choices) order by value->>'domain' loop
  if jsonb_typeof(choice) is distinct from 'object' then raise exception 'Invalid scope choice.' using errcode='22023';end if;
  select count(*) into choice_keys from jsonb_object_keys(choice);
  scope_name:=choice->>'domain';
  case scope_name
   when 'business' then scope_capability:='workspace.business.manage';scope_version:=7;scope_hash:='22626aea373e4e8eb51a90ee4b548c5f3aeeee4bbe58e77b418a0645138edb34';
   when 'opportunity' then scope_capability:='workspace.opportunity.manage';scope_version:=3;scope_hash:='cbd141fb716582ead3b578ab730ce0ac6e72d1dcdd93cb75c9cd0d1b734cc070';
   when 'planning' then scope_capability:='workspace.planning.manage';scope_version:=4;scope_hash:='8d00011548bd7cd023b8993127be68a68b10c148a769b0ce66dc456b02590ee8';
   when 'discoveryProfile' then scope_capability:='workspace.discovery-profile.manage';scope_version:=5;scope_hash:='2e101636a8d786162d7dafa04668a130ee2b09fb28e9c7135547faf8437ddcc8';
   when 'privateReminder' then scope_capability:='workspace.reminders.manage';scope_version:=6;scope_hash:='da1356a5e74914ccde6244432f6962e061464678bb75547f97d2de804aaddaa9';
   else raise exception 'Unknown consent domain.' using errcode='22023';
  end case;
  if choice_keys<>5 or not(choice ?& array['domain','decision','consentVersion','consentTextHash','expectedGrant'])
   or choice->>'decision' is null or choice->>'decision' not in ('approve','revoke')
   or choice->'consentVersion' is distinct from to_jsonb(scope_version)
   or choice->>'consentTextHash' is distinct from scope_hash then
   raise exception 'Consent scope binding invalid.' using errcode='42501';
  end if;
  expected_id:=null;expected_revision:=null;
  if choice->'expectedGrant' is distinct from 'null'::jsonb then
   if jsonb_typeof(choice->'expectedGrant') is distinct from 'object' then raise exception 'Invalid expected proof.' using errcode='22023';end if;
   select count(*) into proof_keys from jsonb_object_keys(choice->'expectedGrant');
   if proof_keys<>2 or not((choice->'expectedGrant') ?& array['id','revision'])
    or jsonb_typeof(choice->'expectedGrant'->'id') is distinct from 'string'
    or jsonb_typeof(choice->'expectedGrant'->'revision') is distinct from 'number' then
    raise exception 'Invalid expected proof.' using errcode='22023';
   end if;
   expected_id:=(choice->'expectedGrant'->>'id')::uuid;
   if (choice->'expectedGrant'->>'revision')::numeric not between 1 and 9007199254740991
    or trunc((choice->'expectedGrant'->>'revision')::numeric)<>(choice->'expectedGrant'->>'revision')::numeric then
    raise exception 'Invalid expected revision.' using errcode='22023';
   end if;
   expected_revision:=(choice->'expectedGrant'->>'revision')::bigint;
  elsif choice->>'decision'='revoke' then raise exception 'Revocation requires an observed proof.' using errcode='42501';
  end if;
  if admission_denied then
   result_receipts:=result_receipts||jsonb_build_array(jsonb_build_object('domain',scope_name,'outcome','DENIED','grant_id',null,'grant_revision',null));
   continue;
  end if;
  current_grant:=null;
  select g.* into current_grant from public.pjsdas_business_management_grants g where g.user_id=target_user_id and g.client_id=target_client_id and g.capability=scope_capability for update;
  if (found and (current_grant.id is distinct from expected_id or current_grant.revision is distinct from expected_revision))
   or (current_grant.id is null and expected_id is not null) then
   raise exception 'Consent state changed; reload.' using errcode='40001';
  end if;
  if choice->>'decision'='approve' then
   if current_grant.id is null then
    insert into public.pjsdas_business_management_grants(user_id,client_id,capability,consent_version,consent_text_hash)
     values(target_user_id,target_client_id,scope_capability,scope_version,scope_hash) returning * into current_grant;
   else
    update public.pjsdas_business_management_grants g set revoked_at=null,granted_at=clock_timestamp(),consent_version=scope_version,consent_text_hash=scope_hash where g.id=current_grant.id returning g.* into current_grant;
   end if;
   result_outcome:='APPROVED';
  elsif current_grant.revoked_at is not null then result_outcome:='ALREADY_REVOKED';
  else
   update public.pjsdas_business_management_grants g set revoked_at=clock_timestamp() where g.id=current_grant.id returning g.* into current_grant;
   result_outcome:='REVOKED';
  end if;
  result_receipts:=result_receipts||jsonb_build_array(jsonb_build_object('domain',scope_name,'outcome',result_outcome,'grant_id',current_grant.id,'grant_revision',current_grant.revision));
 end loop;
 -- Consumer approval requires an existing account-owned workspace. Acquire this
 -- after grant locks, matching the grant -> workspace order of business writes.
 -- FK and row locks serialize account/workspace deletion without new auth grants.
 if not admission_denied and target_consumer_enabled and exists(select 1 from jsonb_array_elements(target_choices) c where c->>'decision'='approve') then
  perform 1 from public.pjsdas_workspaces w where w.user_id=target_user_id for key share;
  if not found then raise exception 'Initialize this account workspace before approving scopes.' using errcode='42501';end if;
 end if;
 insert into public.pjsdas_scoped_management_consent_events(user_id,request_id,client_id,request_hash,choices,receipts)
  values(target_user_id,target_request_id,target_client_id,target_request_hash,target_choices,result_receipts);
 return query select result_receipts;
end $$;
revoke all on function public.pjsdas_decide_scoped_management_consent_v1(uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,text) from public,anon,authenticated;
grant execute on function public.pjsdas_decide_scoped_management_consent_v1(uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,text) to service_role;

-- Fence only the newly introduced consumer receipt family from legacy v2.
create or replace function public.pjsdas_commit_management_workspace_v1(
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
      and g.capability = 'workspace.manage'
      and g.consent_version = 2
      and g.revision = target_grant_revision
      and g.revoked_at is null
      and g.granted_at <= now()
    for share;
  if not found then
    raise exception 'Management grant is absent, revoked, replaced or stale.' using errcode = '42501';
  end if;

  if target_operation = 'undo_command' then
    perform 1 from public.pjsdas_command_ledger l
      where user_id = target_user_id
        and command_id = target_provenance ->> 'undoOf'
        and operation = 'business_management'
        and l.receipt#>>'{managementAuthorization,consentVersion}' is distinct from '7'
        and status = 'COMMITTED';
    if not found then
      raise exception 'Management undo target was not found.' using errcode = '42501';
    end if;
  elsif target_operation is distinct from 'business_management' then
    raise exception 'Unsupported management operation.' using errcode = '42501';
  end if;

  -- New v7 receipts are a separate family; existing v2 receipts are unchanged.
  perform 1 from public.pjsdas_workspaces w where w.user_id=target_user_id for update;
  if exists(select 1 from public.pjsdas_command_ledger l where l.user_id=target_user_id and l.command_id=target_command_id and l.receipt#>>'{managementAuthorization,consentVersion}'='7') then
    raise exception 'Command id was reused with a different payload or consent family.' using errcode='23505';
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
revoke all on function public.pjsdas_commit_management_workspace_v1(
  uuid, text, text, text, bigint, jsonb, integer, text, text, jsonb, jsonb, timestamptz, jsonb, uuid, bigint
) from public, anon, authenticated;
grant execute on function public.pjsdas_commit_management_workspace_v1(
  uuid, text, text, text, bigint, jsonb, integer, text, text, jsonb, jsonb, timestamptz, jsonb, uuid, bigint
) to service_role;
