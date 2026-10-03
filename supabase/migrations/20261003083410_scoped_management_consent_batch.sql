-- Source-only, default-off scoped consent. No grant or production flag is activated.
create table public.pjsdas_scoped_management_consent_events (
 user_id uuid not null references auth.users(id) on delete cascade,
 request_id uuid not null,
 client_id uuid not null,
 request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
 choices jsonb not null,
 receipts jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 primary key(user_id, request_id)
);
alter table public.pjsdas_scoped_management_consent_events enable row level security;
revoke all on table public.pjsdas_scoped_management_consent_events from public,anon,authenticated,service_role;
grant select,insert on table public.pjsdas_scoped_management_consent_events to service_role;

create function public.pjsdas_decide_scoped_management_consent_v1(
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
  or jsonb_array_length(target_choices) not between 1 and 4
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
 -- Validate explicit choices and lock/update their grant rows in stable order.
 -- Errors in any scope roll back the entire batch, including its audit event.
 for choice in select value from jsonb_array_elements(target_choices) order by value->>'domain' loop
  if jsonb_typeof(choice) is distinct from 'object' then raise exception 'Invalid scope choice.' using errcode='22023';end if;
  select count(*) into choice_keys from jsonb_object_keys(choice);
  scope_name:=choice->>'domain';
  case scope_name
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
